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
 * - session driving (`POST /session` + `POST /session/{id}/message`) and
 *   capture collection.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { expect } from 'vitest';
import { API_PORT } from './constants.js';
import { capturesOf, type Capture, type SessionRun } from './capture.js';
import { execIn, existsIn, markServeIn, readFileIn, type ExecOutcome } from './exec.js';

const execFileP = promisify(execFile);

/** Container environment shared by every scenario. */
const BASE_ENV = { HOME: '/app/opencode-home' };

/** Options for the fake model's tool call and container-level extras. */
export interface ScenarioOptions {
  /** Tool name the fake model emits on the first main completion. */
  emitToolCall?: string;
  /** Extra container environment variables. */
  env?: Record<string, string>;
}

/** Delay after a prompt before the capture buffer is read (pipe flush). */
const CAPTURE_FLUSH_MS = 500;

/** Runs `docker` and resolves; rejects loudly on CLI failure. */
async function docker(args: string[]): Promise<void> {
  await execFileP('docker', args);
}

/** A booted scenario container. */
export class Scenario {
  private container: StartedTestContainer | null = null;
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
   * listener existing is what matters, not the log wording).
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
   * Creates a session and drives one prompt to completion. Captures are
   * parsed from the log lines produced by THIS session only — a scenario
   * can drive several sessions (e.g. before/after a container restart), and
   * earlier sessions' captures must not leak into the assertions.
   *
   * @param prompt - Text of the prompt message.
   * @returns The session run (prompt response + captures).
   */
  async session(promptText = 'ping'): Promise<SessionRun> {
    const baseUrl = await this.ready();
    const sessionId = await this.createSession(baseUrl);
    const offset = this.buffer.length;
    const prompt = await this.promptSession(baseUrl, sessionId, promptText);
    await new Promise((resolveFlush) => setTimeout(resolveFlush, CAPTURE_FLUSH_MS));
    const output = this.buffer.slice(offset);
    return { baseUrl, prompt, captures: capturesOf(output), output };
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

  /** Creates a session via `POST /session` (query directory = workspace). */
  private async createSession(baseUrl: string): Promise<string> {
    const response = await fetch(`${baseUrl}/session?directory=/app/workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'e2e' }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(response.ok, `session create must succeed (${response.status})`).toBe(true);
    const session = (await response.json()) as { id: string };
    return session.id;
  }

  /** Sends a prompt via `POST /session/{id}/message` (agent loop). */
  private async promptSession(
    baseUrl: string,
    sessionId: string,
    text: string,
  ): Promise<SessionRun['prompt']> {
    const response = await fetch(`${baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text }] }),
      signal: AbortSignal.timeout(180_000),
    });
    expect(response.ok, `prompt must succeed (${response.status})`).toBe(true);
    return (await response.json()) as SessionRun['prompt'];
  }
}
