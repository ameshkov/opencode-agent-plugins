/**
 * Parsing and assertion helpers for the model requests the fake server
 * captures (`fake-model-server.mjs` prints every chat-completions body as a
 * `CAPTURE:` line on container stdout).
 *
 * These are behavior-neutral: they only extract facts from the captures; the
 * suites decide what to assert.
 */

import { expect } from 'vitest';

/** Shape of the OpenAI chat-completions request the fake server captures. */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role?: string;
    content?: string | null;
    tool_calls?: Array<{ function?: { name?: string } }>;
  }>;
  tools?: Array<{ type?: string; function?: { name?: string; description?: string } }>;
}

/** A captured model request plus its line index (request order). */
export interface Capture {
  index: number;
  request: ChatCompletionRequest;
}

/** Result of driving one session (`POST /session/{id}/message`). */
export interface SessionRun {
  /** Base URL of the opencode server. */
  baseUrl: string;
  /** Response of the prompt POST. */
  prompt: { info: { role: string }; parts: Array<{ type: string; text?: string }> };
  /** Every captured model request, in order (this session only). */
  captures: Capture[];
  /** Raw container output (for failure messages). */
  output: string;
}

/**
 * Parses the `CAPTURE:` lines the fake model server prints to stdout.
 *
 * @param output - Raw container output.
 * @returns The captures in request order.
 */
export function capturesOf(output: string): Capture[] {
  const captures: Capture[] = [];
  for (const line of output.split('\n')) {
    if (!line.startsWith('CAPTURE:')) {
      continue;
    }
    const json = line.slice('CAPTURE:'.length).trim();
    try {
      captures.push({
        index: captures.length,
        request: JSON.parse(json) as ChatCompletionRequest,
      });
    } catch {
      // Ignore truncated interleaved log lines; the assertion below fails
      // when no capture parses.
    }
  }
  return captures;
}

/**
 * Tool entries of a captured request, keyed by their opencode name.
 *
 * @param request - A captured request.
 * @returns Map of tool name → description.
 */
export function toolsOf(request: ChatCompletionRequest): Map<string, string> {
  const tools = new Map<string, string>();
  for (const tool of request.tools ?? []) {
    if (tool.function?.name !== undefined) {
      tools.set(tool.function.name, tool.function.description ?? '');
    }
  }
  return tools;
}

/**
 * System-prompt text of a captured request (all system messages joined).
 *
 * @param request - A captured request.
 * @returns The joined system prompt text.
 */
export function systemText(request: ChatCompletionRequest): string {
  return request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content ?? '')
    .join('\n');
}

/** True when this is opencode's internal session-title request. */
export function isTitleRequest(request: ChatCompletionRequest): boolean {
  return request.messages.some(
    (message) =>
      message.role === 'system' &&
      typeof message.content === 'string' &&
      message.content.includes('You are a title generator'),
  );
}

/**
 * The request where opencode lists the tools for the first time (the first
 * non-title request).
 *
 * @param captures - The captures.
 * @returns The first main request.
 */
export function mainRequestOf(captures: Capture[]): Capture {
  const main = captures.find((capture) => !isTitleRequest(capture.request));
  expect(main, 'a main chat request must be captured').toBeDefined();
  return main!;
}

/**
 * Whether a tool-call round trip happened: an assistant message with
 * `tool_calls` and a `tool` message in the same captured request.
 *
 * @param captures - The captures.
 * @returns `{ call, result }` flags.
 */
export function toolRoundTripOf(captures: Capture[]): { call: boolean; result: boolean } {
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

/**
 * The text content of the FIRST `tool` message of the request that carried
 * the executed tool result back to the model.
 *
 * @param captures - The captures.
 * @returns The tool result text (may be empty when no result was captured).
 */
export function toolResultTextOf(captures: Capture[]): string {
  const withResult = captures.find((capture) =>
    capture.request.messages.some((message) => message.role === 'tool'),
  );
  const toolResult = withResult?.request.messages.find((message) => message.role === 'tool');
  return toolResult?.content ?? '';
}
