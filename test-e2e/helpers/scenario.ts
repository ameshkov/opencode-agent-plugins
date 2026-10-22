/**
 * Scenario driver for the docker e2e suite.
 *
 * A scenario is one task container booted from the shared e2e image, in one
 * config "mode" (see `test-e2e/write-config.mjs`). The driver owns:
 *
 * - container lifecycle (start/log capture/stop; `restart()` re-runs the SAME
 *   container via `docker stop`/`docker start`, preserving its filesystem so
 *   CLI-installed stores and configs survive — the control markers in
 *   `/app/ctrl` make bootstrap re-enter cleanly);
 * - opencode API readiness: a stable TCP/HTTP poll on the published port
 *   instead of grepping opencode's log wording (per-release formatting must
 *   not gate the suite);
 * - `exec()` / `cli()` helpers inside the container (cwd `/app/workspace`,
 *   `HOME=/app/opencode-home` so the CLI resolves the same client store the
 *   opencode plugin uses at startup);
 * - session driving through the V2 client (`@opencode/client`:
 *   `session.create` → `session.prompt` → `session.wait` → `session.context`)
 *   and capture collection.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import {
  OpenCode,
  type McpListOutput,
  type PluginListOutput,
  type SkillListOutput,
} from '@opencode/client';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { API_PORT, PLUGIN_ID, SERVER_PASSWORD } from './constants.js';
import { capturesOf, type Capture, type SessionRun } from './capture.js';
import { execIn, existsIn, markServeIn, readFileIn, type ExecOutcome } from './exec.js';

const execFileP = promisify(execFile);

/** Container environment shared by every scenario. */
const BASE_ENV = { HOME: '/app/opencode-home', E2E_SERVER_PASSWORD: SERVER_PASSWORD };

/** Options for the fake model's tool call and container-level extras. */
export interface ScenarioOptions {
  /** Tool name the fake model emits on the first main completion of each session. */
  emitToolCall?: string;
  /** Code Mode code the fake model sends when `emitToolCall` is `execute`. */
  emitToolCode?: string;
  /** Extra container environment variables. */
  env?: Record<string, string>;
}

/** An MCP server a session must see registered before it prompts. */
export interface McpExpectation {
  /** Server name as it appears in `mcp.list`. */
  name: string;
  /** Expected connection status (defaults to `connected`). */
  status?: string;
}

/** Options for {@link Scenario.session}. */
export interface SessionOptions {
  /**
   * Wait for the loader plugin before prompting (default `true`). Set this to
   * `false` only for a session that runs after the loader entry was removed.
   */
  expectLoader?: boolean;
}

/**
 * MCP servers each scenario mode registers; a session waits for them (by
 * name and status) before prompting. `cli` phases override per call.
 */
const MODE_EXPECTATIONS: Record<string, McpExpectation[]> = {
  hook: [{ name: 'echo' }],
  static: [{ name: 'echo' }],
  remote: [{ name: 'http' }, { name: 'redirect' }, { name: 'pathtool' }],
  'negative-invalid': [{ name: 'echo' }],
  'negative-stub': [{ name: 'echo', status: 'disabled' }],
  'skill-collision': [{ name: 'echo' }],
  'negative-mismatch': [],
  'cli-missing': [],
  cli: [],
};

/** Delay after a prompt completes before the capture buffer is read (flush). */
const CAPTURE_FLUSH_MS = 500;

/** How long to wait for plugin activation and MCP connections. */
const READY_TIMEOUT_MS = 120_000;

/**
 * How long the expected MCP state must hold before a session prompts.
 *
 * A server's `connected` status (what `mcp.list` reports) is set BEFORE its
 * tools reach the tool registry: OpenCode registers them through a debounced
 * reconcile of the `mcp.tools.changed` event (100 ms in 2.0.16,
 * `packages/core/src/tool/mcp.ts`). The Code Mode `execute` inventory is a
 * snapshot of that registry, so a prompt sent inside the window cannot call
 * the server's tools — the scenario fails with `Unknown tool
 * '<server>.<tool>'` even though the server is connected and reports its
 * tools. The registry has no read API, so the gate requires the expected
 * state to hold for several times that debounce instead. A CLI reload
 * reconnects servers and refetches their catalogs, so the hold must also
 * cover that reconnect.
 */
const MCP_TOOL_REGISTRY_SETTLE_MS = 2000;

/** Runs `docker` and resolves; rejects loudly on CLI failure. */
async function docker(args: string[]): Promise<void> {
  await execFileP('docker', args);
}

/** HTTP Basic authorization for the V2 server API (username `opencode`). */
function authHeaders(): Record<string, string> {
  const credentials = Buffer.from(`opencode:${SERVER_PASSWORD}`).toString('base64');
  return { authorization: `Basic ${credentials}` };
}

/** A booted scenario container. */
export class Scenario {
  private container: StartedTestContainer | null = null;
  private client: ReturnType<typeof OpenCode.make> | null = null;
  private buffer = '';
  private logFollow: ChildProcess | null = null;
  private readonly image: string;
  private readonly mode: string;
  private readonly options: ScenarioOptions;

  /**
   * @param image - The e2e image tag (from `helpers/image.ts`).
   * @param mode - Scenario mode (see `write-config.mjs`).
   * @param options - Fake-model and env options.
   */
  constructor(image: string, mode: string, options: ScenarioOptions = {}) {
    this.image = image;
    this.mode = mode;
    this.options = options;
  }

  /** Starts the container (and stays ready for exec). */
  async start(): Promise<void> {
    const env: Record<string, string> = { ...BASE_ENV, ...(this.options.env ?? {}) };
    if (this.options.emitToolCall !== undefined) {
      env['EMIT_TOOL_CALL'] = this.options.emitToolCall;
    }
    if (this.options.emitToolCode !== undefined) {
      env['EMIT_TOOL_CODE'] = this.options.emitToolCode;
    }
    // Wait on OUR readiness marker (the fake model's FAKE_SERVER_READY line):
    // the default `forListeningPorts` strategy would wait for 4096, which
    // never listens in `cli` mode (opencode starts only after the serve
    // marker). opencode's actual readiness is polled via HTTP in `ready()`.
    // The host port is bound EXPLICITLY: `docker stop` + `docker start` of
    // the same container re-randomizes dynamic host bindings, which would
    // strand the cached mapped port after a restart.
    const container = new GenericContainer(this.image)
      .withCommand([this.mode])
      .withExposedPorts({ container: API_PORT, host: API_PORT, protocol: 'tcp' })
      .withEnvironment(env)
      .withWaitStrategy(Wait.forLogMessage(/FAKE_SERVER_READY/))
      .withLogConsumer((stream) => {
        stream.on('data', (chunk) => {
          this.buffer += chunk.toString('utf8');
        });
      })
      .withStartupTimeout(10 * 60 * 1000);
    this.container = await container.start();
  }

  /** The mapped host URL of opencode's server API. */
  get baseUrl(): string {
    const started = this.requireContainer();
    return `http://${started.getHost()}:${started.getMappedPort(API_PORT)}`;
  }

  /** Raw container output collected so far. */
  output(): string {
    return this.buffer;
  }

  /**
   * Waits until opencode's HTTP listener answers (any status counts — the
   * listener existing is what matters, not the log wording; V2 answers 401
   * without credentials, which still proves the listener is up).
   *
   * @param timeoutMs - Readiness timeout.
   * @returns The base URL once reachable.
   */
  async ready(timeoutMs = 10 * 60 * 1000): Promise<string> {
    const baseUrl = this.baseUrl;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let up = false;
      try {
        await fetch(baseUrl, { signal: AbortSignal.timeout(3_000) });
        up = true;
      } catch {
        // Not answering yet — keep polling.
      }
      if (up) {
        return baseUrl;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `opencode server did not become reachable at ${baseUrl} within ${timeoutMs}ms; ` +
            `mode=${this.mode}; last output:\n${this.buffer.slice(-4000)}`,
        );
      }
      await new Promise((resolvePause) => setTimeout(resolvePause, 1_000));
    }
  }

  /**
   * Creates a V2 session, drives one prompt to completion, and reads the
   * session context once it is idle. Captures are parsed from the log lines
   * produced by THIS session only — a scenario can drive several sessions
   * (e.g. before/after a container restart), and earlier sessions' captures
   * must not leak into the assertions.
   *
   * @param promptText - Text of the prompt message.
   * @param expectMcp - MCP servers the session must see registered before the
   * prompt (defaults to the scenario mode's set; `cli` phases override).
   * @param options - Session readiness options; `expectLoader` defaults to
   * `true`. Pass `{ expectLoader: false }` after the loader entry was removed.
   * @returns The session run (messages + captures).
   */
  async session(
    promptText = 'ping',
    expectMcp: McpExpectation[] = MODE_EXPECTATIONS[this.mode] ?? [],
    options: SessionOptions = {},
  ): Promise<SessionRun> {
    await this.ready();
    const client = this.api();
    // Creating the session loads the location (config + plugin activation);
    // MCP servers then connect asynchronously, so wait before prompting.
    const session = await client.session.create(
      { location: { directory: '/app/workspace' } },
      { signal: AbortSignal.timeout(90_000) },
    );
    await this.waitForReady(expectMcp, options.expectLoader ?? true);
    const offset = this.buffer.length;
    await client.session.prompt(
      { sessionID: session.id, text: promptText },
      { signal: AbortSignal.timeout(90_000) },
    );
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(180_000) });
    await new Promise((resolveFlush) => setTimeout(resolveFlush, CAPTURE_FLUSH_MS));
    const output = this.buffer.slice(offset);
    const messages = await client.session.context({ sessionID: session.id });
    return { baseUrl: this.baseUrl, messages, captures: capturesOf(output), output };
  }

  /**
   * The effective V2 config (`config.get`) — host-side registration evidence.
   *
   * @returns The config response.
   */
  async config(): Promise<unknown> {
    return this.api().config.get();
  }

  /**
   * MCP servers with their connection status (`mcp.list`).
   *
   * @returns The MCP list response.
   */
  async mcpList(): Promise<McpListOutput> {
    return this.api().mcp.list();
  }

  /**
   * Active plugins at the workspace location (`plugin.list`).
   *
   * @returns The plugin list response.
   */
  async pluginList(): Promise<PluginListOutput> {
    return this.api().plugin.list();
  }

  /**
   * Skills available at the workspace location (`skill.list`).
   *
   * @returns The skills list response.
   */
  async skillList(): Promise<SkillListOutput> {
    return this.api().skill.list();
  }

  /**
   * Runs a command inside the container (cwd `/app/workspace`, shared HOME).
   *
   * @param args - Command argv (no shell; `/bin/sh -c` is avoided).
   * @returns The exit code and captured output.
   */
  async exec(args: string[]): Promise<ExecOutcome> {
    return execIn(this.requireContainer(), args);
  }

  /**
   * Runs the `opencode-agent-plugins` CLI in the container.
   *
   * @param args - CLI arguments (the command name is the first element).
   * @returns The CLI outcome.
   */
  async cli(args: string[]): Promise<ExecOutcome> {
    return this.exec([
      'opencode-agent-plugins',
      ...args,
      '--config',
      '/app/workspace/opencode.json',
    ]);
  }

  /** Signals bootstrap to start opencode (`cli` mode) via the serve marker. */
  async markServe(): Promise<void> {
    await markServeIn(this.requireContainer());
  }

  /** Reads a file from the container as UTF-8 (empty when unreadable). */
  async readFile(path: string): Promise<string> {
    return readFileIn(this.requireContainer(), path);
  }

  /** Whether a path exists inside the container. */
  async exists(path: string): Promise<boolean> {
    return existsIn(this.requireContainer(), path);
  }

  /**
   * Restarts the SAME container (filesystem preserved): `docker stop` +
   * `docker start`. Used by CLI scenarios that must boot opencode again after
   * install/update/remove. Container stdout is re-attached via
   * `docker logs -f` because the original consumer is tied to the boot.
   */
  async restart(): Promise<void> {
    const id = this.requireContainer().getId();
    await docker(['stop', '-t', '20', id]);
    await docker(['start', id]);
    this.client = null;
    this.reattachLogs(id);
  }

  /** Stops and removes the container (cleanup path; idempotent). */
  async stop(): Promise<void> {
    this.logFollow?.kill();
    this.logFollow = null;
    if (this.container !== null) {
      await this.container.stop({ remove: true }).catch(() => {});
      this.container = null;
    }
  }

  /** Keeps following container stdout after an in-place restart. */
  private reattachLogs(id: string): void {
    const follow = spawn('docker', ['logs', '-f', id]);
    follow.stdout?.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
    });
    follow.stderr?.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8');
    });
    follow.unref();
    this.logFollow = follow;
  }

  private requireContainer(): StartedTestContainer {
    if (this.container === null) {
      throw new Error(`scenario container is not started (mode ${this.mode})`);
    }
    return this.container;
  }

  /** Lazily creates the authenticated V2 client for this container. */
  private api(): ReturnType<typeof OpenCode.make> {
    this.client ??= OpenCode.make({ baseUrl: this.baseUrl, headers: authHeaders() });
    return this.client;
  }

  /**
   * Waits until the location is registered and usable: when `expectLoader` is
   * true, the loader plugin is active (all modes except `static`, which
   * hand-writes the config), the session's expected MCP servers are present
   * with their status (and no server is still `pending`), and that state has
   * held for {@link MCP_TOOL_REGISTRY_SETTLE_MS}. V2 activates plugins and connects
   * servers asynchronously after the location loads, so a prompt sent too
   * early would miss the registered tools and skills. With no expected
   * servers the registry must be empty instead — never "ready" merely
   * because a poll was empty. A timeout is non-fatal: the scenario
   * assertions then report the actual state.
   *
   * @param expectMcp - Servers that must be present with their status.
   * @param expectLoader - Whether the loader plugin must be active first.
   */
  private async waitForReady(expectMcp: McpExpectation[], expectLoader: boolean): Promise<void> {
    const client = this.api();
    const deadline = Date.now() + READY_TIMEOUT_MS;
    if (this.mode !== 'static' && expectLoader) {
      for (;;) {
        const plugins = (await client.plugin.list()).data;
        if (plugins.some((plugin) => plugin.id === PLUGIN_ID)) {
          break;
        }
        if (Date.now() > deadline) {
          return;
        }
        await new Promise((resolvePause) => setTimeout(resolvePause, 500));
      }
    }
    let satisfiedSince: number | undefined;
    for (;;) {
      const servers = (await client.mcp.list()).data;
      const pending = servers.some((server) => server.status.status === 'pending');
      const satisfied =
        expectMcp.length > 0
          ? expectMcp.every((want) =>
              servers.some(
                (server) =>
                  server.name === want.name &&
                  server.status.status === (want.status ?? 'connected'),
              ),
            )
          : servers.length === 0;
      if (pending || !satisfied) {
        satisfiedSince = undefined;
      } else {
        satisfiedSince ??= Date.now();
        if (Date.now() - satisfiedSince >= MCP_TOOL_REGISTRY_SETTLE_MS) {
          return;
        }
      }
      if (Date.now() > deadline) {
        return;
      }
      await new Promise((resolvePause) => setTimeout(resolvePause, 500));
    }
  }
}
