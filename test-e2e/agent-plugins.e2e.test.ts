/**
 * Docker e2e tests for the agent-plugins client (`docs/design.md` §9.1,
 * §9.2.4).
 *
 * Everything opencode-related runs inside a container built from
 * `test-e2e/Dockerfile`: a real, pinned opencode binary, the plugin compiled
 * from this repo, the fixture plugin package, and a fake OpenAI-compatible
 * model server. The image entrypoint (`test-e2e/bootstrap.mjs`) starts the
 * fake model server and `opencode serve` (hostname 0.0.0.0, published port
 * 4096); this test connects to the opencode server API from outside the
 * container:
 *
 * - create a session and send a prompt through `POST /session/{id}/message`;
 * - the fake model's first completion emits a tool call to the plugin's MCP
 *   server (echo_echo_ping), so opencode executes it — the executed tool
 *   result carries PLUGIN_ROOT/PLUGIN_DATA/CWD/DATA_EXISTS;
 * - the fake model prints every chat-completions request it receives as a
 *   `CAPTURE:` line, which this test reads from the container logs and
 *   asserts on (the tool list, `<available_skills>`, and the executed tool
 *   round trip).
 *
 * The fixtures include a stray nested `SKILL.md` (`skills/<name>/references/
 * SKILL.md`) so each release's skills scan depth is pinned here: §2.2
 * documents a discrepancy between the documented one-level scan and the
 * observed recursive scan on 1.18.25. If a future release changes that
 * behavior, this test is the tripwire.
 *
 * Docker is required (`pnpm test:e2e`); no opencode is installed on the host.
 */

import { execFile } from 'node:child_process';
import { GenericContainer, Wait } from 'testcontainers';
import { beforeAll, describe, expect, it } from 'vitest';

/** Release under test; overridable, must match the @opencode-ai/plugin pin. */
const OPENCODE_VERSION = process.env['OPENCODE_VERSION'] ?? '1.18.25';

/** Image name shared by the build and the per-test containers. */
const IMAGE_NAME = `opencode-agent-plugins-e2e:${OPENCODE_VERSION}`;

/** Port `opencode serve` listens on inside the container. */
const API_PORT = 4096;

/** Plugin name/values the assertions use (see fixtures + §5.7–§5.8). */
const PLUGIN_ROOT = '/app/fixtures/my-plugin';
const DATA_DIR_PREFIX = '/app/opencode-home/.local/share/opencode/agent-plugins/data/hello-';
const STATIC_DATA_DIR = '/app/static-data/hello';

/** Shape of the OpenAI chat-completions request the fake server captures. */
interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role?: string;
    content?: string | null;
    tool_calls?: Array<{ function?: { name?: string } }>;
  }>;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string } }>;
}

/** A captured model request plus its line index (request order). */
interface Capture {
  index: number;
  request: ChatCompletionRequest;
}

/** Result of one scenario run against the exposed opencode server. */
interface ScenarioResult {
  baseUrl: string;
  /** Response of the prompt POST (`POST /session/{id}/message`). */
  prompt: { info: { role: string }; parts: Array<{ type: string; text?: string }> };
  /** Every captured model request, in order. */
  captures: Capture[];
  /** Raw container output (for failure messages). */
  output: string;
}

/** Parses the `CAPTURE:` lines the fake model server prints to stdout. */
function capturesOf(output: string): Capture[] {
  const captures: Capture[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('CAPTURE:')) {
      continue;
    }
    const json = line.slice('CAPTURE:'.length).trim();
    try {
      captures.push({ index: captures.length, request: JSON.parse(json) as ChatCompletionRequest });
    } catch {
      // Ignore truncated interleaved log lines; the assertion below fails
      // when no capture parses.
    }
  }
  return captures;
}

/** Tool entries of a captured request, keyed by their opencode name. */
function toolsOf(request: ChatCompletionRequest): Map<string, string> {
  const tools = new Map<string, string>();
  for (const tool of request.tools ?? []) {
    if (tool.function?.name !== undefined) {
      tools.set(tool.function.name, tool.function.description ?? '');
    }
  }
  return tools;
}

/** System-prompt text of a captured request (all system messages joined). */
function systemText(request: ChatCompletionRequest): string {
  return request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content ?? '')
    .join('\n');
}

/** True when this is opencode's internal session-title request. */
function isTitleRequest(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes('You are a title generator'),
  );
}

/** The request where opencode lists the plugin's tools for the first time. */
function mainRequestOf(captures: Capture[]): Capture {
  const main = captures.find((capture) => !isTitleRequest(capture.request));
  expect(main, 'a main chat request must be captured').toBeDefined();
  return main!;
}

/** The request that carried the executed tool result back to the model. */
function toolRoundTripOf(captures: Capture[]): { call: boolean; result: boolean } {
  const roundTrip = captures.find((capture) =>
    capture.request.messages.some((message) => message.role === 'tool'),
  );
  if (roundTrip === undefined) {
    return { call: false, result: false };
  }
  const call = roundTrip.request.messages.some(
    (message) => message.role === 'assistant' && (message.tool_calls?.length ?? 0) > 0,
  );
  const result = roundTrip.request.messages.some((message) => message.role === 'tool');
  return { call, result };
}

/** Runs the scenario, drives a session through the API, and collects results. */
async function runScenario(mode: 'hook' | 'static'): Promise<ScenarioResult> {
  // The image ENTRYPOINT is `node /app/bootstrap.mjs`; the command is the
  // mode. Logs are collected continuously via the consumer: `logs()` follows
  // forever on a long-running container, so it cannot be awaited here.
  let buffer = '';
  const container = new GenericContainer(IMAGE_NAME)
    .withCommand([mode])
    .withExposedPorts(API_PORT)
    .withEnvironment({ EMIT_TOOL_CALL: 'echo_echo_ping' })
    .withLogConsumer((stream) => {
      stream.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
      });
    })
    .withWaitStrategy(Wait.forLogMessage(/opencode server listening on/i))
    .withStartupTimeout(10 * 60 * 1000);
  const started = await container.start();
  try {
    const baseUrl = `http://${started.getHost()}:${started.getMappedPort(API_PORT)}`;
    const sessionId = await createSession(baseUrl);
    const prompt = await promptSession(baseUrl, sessionId);
    // The fake server prints CAPTURE lines synchronously before answering
    // each completion, so everything that matters is buffered by now; a short
    // pause lets the pipe flush the last line.
    await new Promise((resolveFlush) => setTimeout(resolveFlush, 500));
    return { baseUrl, prompt, captures: capturesOf(buffer), output: buffer };
  } finally {
    await started.stop({ remove: true });
  }
}

/** Creates a session via `POST /session` (query directory = workspace). */
async function createSession(baseUrl: string): Promise<string> {
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

/** Sends a prompt via `POST /session/{id}/message` (agent loop to completion). */
async function promptSession(
  baseUrl: string,
  sessionId: string,
): Promise<ScenarioResult['prompt']> {
  const response = await fetch(`${baseUrl}/session/${sessionId}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'ping' }] }),
    signal: AbortSignal.timeout(180_000),
  });
  expect(response.ok, `prompt must succeed (${response.status})`).toBe(true);
  return (await response.json()) as ScenarioResult['prompt'];
}

// No Ryuk reaper: scenario containers are self-cleaning via stop({ remove }),
// and avoiding the reaper keeps the suite lean (it would pull another image).
process.env['TESTCONTAINERS_RYUK_DISABLED'] = 'true';

describe(`e2e: real opencode ${OPENCODE_VERSION} in Docker (testcontainers)`, () => {
  beforeAll(
    async () => {
      // Docker is mandatory for this suite; fail loudly instead of skipping so
      // CI can never silently lose the gate.
      await new Promise<void>((resolveReject, reject) => {
        execFile('docker', ['info'], (error) => {
          if (error !== null) {
            reject(new Error('e2e requires a running Docker engine (`docker info` failed)'));
            return;
          }
          resolveReject();
        });
      });
      await GenericContainer.fromDockerfile('.', 'test-e2e/Dockerfile')
        .withBuildArgs({ OPENCODE_VERSION })
        .build(IMAGE_NAME);
    },
    20 * 60 * 1000,
  );

  it(
    'hook mode: registered components reach the live session',
    async () => {
      const result = await runScenario('hook');

      // The fake model emits a tool call to the plugin's MCP server, opencode
      // executes it, and the executed result is sent back to the model —
      // proving the server was registered, spawned with the right env and cwd,
      // and is callable (not merely listed).
      const roundTrip = toolRoundTripOf(result.captures);
      expect(roundTrip.call, 'opencode must call echo_echo_ping').toBe(true);
      expect(roundTrip.result, 'the MCP tool result must reach the model').toBe(true);
      const withResult = result.captures.find((capture) =>
        capture.request.messages.some((message) => message.role === 'tool'),
      )!;
      const toolResult = withResult.request.messages.find((message) => message.role === 'tool');
      const resultText = toolResult?.content ?? '';

      // The executed server reported its subprocess contract (§5.7–§5.8): the
      // client-managed PLUGIN_DATA dir was created eagerly before launch.
      expect(resultText).toContain('pong hello from e2e');
      expect(resultText).toContain(`PLUGIN_ROOT=${PLUGIN_ROOT}`);
      expect(resultText).toContain(`PLUGIN_DATA=${DATA_DIR_PREFIX}`);
      expect(resultText).toContain(`CWD=${PLUGIN_ROOT}`);
      expect(resultText).toContain('DATA_EXISTS=true');

      // The definition request listed the tool and advertised the skills.
      const main = mainRequestOf(result.captures);
      const tools = toolsOf(main.request);
      const echo = tools.get('echo_echo_ping');
      expect(echo, 'MCP tool echo_echo_ping must be registered').toBeDefined();
      expect(echo!).toContain(`PLUGIN_ROOT=${PLUGIN_ROOT}`);
      expect(echo!).toContain(`PLUGIN_DATA=${DATA_DIR_PREFIX}`);
      expect(echo!).toContain(`CWD=${PLUGIN_ROOT}`);

      const system = systemText(main.request);
      expect(system).toContain('<available_skills>');
      expect(system).toContain('<name>hello</name>');
      // Scan-depth pin (opencode 1.18.25): the skills scan is recursive, so the
      // stray nested SKILL.md IS exposed — see the fixture comment and §2.2.
      expect(system).toContain('<name>nested</name>');

      // The session round-tripped to completion.
      expect(result.prompt.info.role).toBe('assistant');
    },
    10 * 60 * 1000,
  );

  it(
    'static mode: handwritten config is behaviorally equivalent',
    async () => {
      const result = await runScenario('static');

      const roundTrip = toolRoundTripOf(result.captures);
      expect(roundTrip.call, 'opencode must call echo_echo_ping').toBe(true);
      expect(roundTrip.result, 'the MCP tool result must reach the model').toBe(true);
      const withResult = result.captures.find((capture) =>
        capture.request.messages.some((message) => message.role === 'tool'),
      )!;
      const toolResult = withResult.request.messages.find((message) => message.role === 'tool');
      const resultText = toolResult?.content ?? '';
      expect(resultText).toContain(`PLUGIN_ROOT=${PLUGIN_ROOT}`);
      expect(resultText).toContain(`PLUGIN_DATA=${STATIC_DATA_DIR}`);
      expect(resultText).toContain(`CWD=${PLUGIN_ROOT}`);

      const main = mainRequestOf(result.captures);
      const tools = toolsOf(main.request);
      const echo = tools.get('echo_echo_ping');
      expect(echo, 'MCP tool echo_echo_ping must be registered').toBeDefined();
      expect(echo!).toContain(`PLUGIN_ROOT=${PLUGIN_ROOT}`);
      expect(echo!).toContain(`PLUGIN_DATA=${STATIC_DATA_DIR}`);
      expect(echo!).toContain(`CWD=${PLUGIN_ROOT}`);

      const system = systemText(main.request);
      expect(system).toContain('<available_skills>');
      expect(system).toContain('<name>hello</name>');
      // Same host scan behavior as the hook mode above, for the same release.
      expect(system).toContain('<name>nested</name>');

      expect(result.prompt.info.role).toBe('assistant');
    },
    10 * 60 * 1000,
  );
});
