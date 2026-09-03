/**
 * Fake OpenAI-compatible model server for the e2e scenario.
 *
 * Runs inside the e2e container next to opencode. Serves `/v1/models` and
 * `/v1/chat/completions` (streaming and non-streaming) and:
 *
 * - appends every chat-completions request body to `CAPTURE_FILE`;
 * - prints the same body to stdout as a `CAPTURE:` line, so the test can
 *   assert on the request (tools, `<available_skills>`) from container logs
 *   without needing a filesystem channel;
 * - when `EMIT_TOOL_CALL` is set to a tool name, the FIRST main chat
 *   completion returns a tool call for it (so opencode executes the MCP
 *   server and the test can assert on the resulting tool round trip);
 *   subsequent completions return plain text so the agent loop terminates.
 *
 * Exported for the container bootstrap (`bootstrap.mjs`); may also be run
 * directly for local debugging.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

/**
 * Options for {@link startFakeModel}; defaults come from the environment
 * (`FAKE_MODEL_PORT`, `CAPTURE_FILE`, `EMIT_TOOL_CALL`).
 *
 * @typedef {object} FakeModelOptions
 * @property {number} [port] - Port to bind.
 * @property {string} [captureFile] - JSONL file captured requests are
 * appended to.
 * @property {string} [emitToolCall] - Tool name emitted on the first main
 * completion.
 */

/**
 * Starts the fake model server (in-process) and resolves once it is
 * listening, so callers need no readiness polling.
 *
 * @param {FakeModelOptions} [options] - Overrides; falls back to the
 * environment.
 * @returns {Promise<number>} The bound port.
 */
export function startFakeModel(options = {}) {
  const port = options.port ?? Number(process.env['FAKE_MODEL_PORT'] ?? '8787');
  const captureFile =
    options.captureFile ?? process.env['CAPTURE_FILE'] ?? '/app/out/requests.jsonl';
  const emitToolCall = options.emitToolCall ?? process.env['EMIT_TOOL_CALL'] ?? '';
  mkdirSync(dirname(captureFile), { recursive: true });

  let toolCallEmitted = false;

  /** Serializes a request body to the capture file and stdout. */
  function capture(parsed) {
    const line = JSON.stringify(parsed);
    appendFileSync(captureFile, `${line}\n`);
    console.log(`CAPTURE:${line}`);
  }

  /** True for opencode's session-title request (small model, no tools). */
  function isTitleRequest(parsed) {
    return (parsed.messages ?? []).some(
      (message) =>
        message.role === 'system' &&
        typeof message.content === 'string' &&
        message.content.includes('You are a title generator'),
    );
  }

  /** Tool call for the first *main* completion when EMIT_TOOL_CALL is set. */
  function toolCallFor() {
    if (toolCallEmitted || emitToolCall === '') {
      return undefined;
    }
    toolCallEmitted = true;
    return {
      id: 'call_e2e_1',
      type: 'function',
      function: {
        name: emitToolCall,
        arguments: JSON.stringify({ message: 'hello from e2e' }),
      },
    };
  }

  /** Responds with a JSON body. */
  function respond(res, statusCode, body) {
    res.writeHead(statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  /** Streams an SSE-style chat completion (plain text or a tool call). */
  function streamCompletion(res, model, toolCall) {
    const chunks = [
      {
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
    ];
    if (toolCall !== undefined) {
      chunks.push({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, ...toolCall }] },
            finish_reason: null,
          },
        ],
      });
      chunks.push({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      });
    } else {
      chunks.push({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: 'e2e-ready' }, finish_reason: null }],
      });
      chunks.push({
        id: 'chatcmpl-e2e',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      });
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    for (const chunk of chunks) {
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      respond(res, 200, { object: 'list', data: [{ id: 'test-model', object: 'model' }] });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          respond(res, 400, { error: { message: 'request body is not valid JSON' } });
          return;
        }
        capture(parsed);
        const model = parsed.model ?? 'test-model';
        const toolCall = isTitleRequest(parsed) ? undefined : toolCallFor();
        if (parsed.stream === true) {
          streamCompletion(res, model, toolCall);
          return;
        }
        respond(res, 200, {
          id: 'chatcmpl-e2e',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [
            {
              index: 0,
              message:
                toolCall === undefined
                  ? { role: 'assistant', content: 'e2e-ready' }
                  : { role: 'assistant', content: null, tool_calls: [toolCall] },
              finish_reason: toolCall === undefined ? 'stop' : 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      });
      return;
    }
    respond(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
  });

  return new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log(`FAKE_SERVER_READY ${port}`);
      resolveReady(port);
    });
  });
}

if (isMain) {
  startFakeModel().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
