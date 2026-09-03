#!/usr/bin/env node
/**
 * Dependency-free MCP stdio server for the git-sourced e2e fixture plugin.
 *
 * Implements just enough of the MCP stdio transport (newline-delimited
 * JSON-RPC 2.0) for opencode's client: initialize, notifications/initialized,
 * ping, tools/list and tools/call. The `echo_ping` tool RESULT embeds the
 * subprocess contract (PLUGIN_ROOT, PLUGIN_DATA, CWD, DATA_EXISTS) plus
 * GIT_VERSION — the plugin.json version at the currently installed commit —
 * so an update to a new fixture version is observable from the executed tool
 * round trip without extra filesystem access.
 *
 * No external dependencies: the fixture is cloned into the client store by
 * the CLI and must install with nothing extra.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env['PLUGIN_ROOT'] ?? '';
const data = process.env['PLUGIN_DATA'] ?? '';
const cwd = process.cwd();

/** plugin.json version at the installed commit (the update marker). */
function versionOf() {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
    return String(manifest.version ?? '');
  } catch {
    return '';
  }
}

const VERSION = versionOf();

/** Sends a JSON-RPC message on stdout (newline-delimited, MCP stdio). */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** The tool definition opencode's client needs (JSON Schema input). */
function toolDefinition() {
  return {
    name: 'echo_ping',
    description:
      `git-sourced echo_ping e2e: PLUGIN_ROOT=${root}; PLUGIN_DATA=${data}; ` +
      `GIT_VERSION=${VERSION}`,
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  };
}

/** Handles one JSON-RPC message. */
function handle(message) {
  const method = message?.method;
  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'git-fixture', version: VERSION },
        },
      });
      break;
    case 'notifications/initialized':
      // No response for notifications.
      break;
    case 'ping':
      send({ jsonrpc: '2.0', id: message.id ?? null, result: {} });
      break;
    case 'tools/list':
      send({ jsonrpc: '2.0', id: message.id ?? null, result: { tools: [toolDefinition()] } });
      break;
    case 'tools/call': {
      const args = message.params?.arguments ?? {};
      const text =
        `pong ${String(args.message ?? '')} | ` +
        `GIT_VERSION=${VERSION}; ` +
        `PLUGIN_ROOT=${root}; PLUGIN_DATA=${data}; ` +
        `CWD=${cwd}; DATA_EXISTS=${existsSync(data)}`;
      send({
        jsonrpc: '2.0',
        id: message.id ?? null,
        result: { content: [{ type: 'text', text }], isError: false },
      });
      break;
    }
    default:
      send({
        jsonrpc: '2.0',
        id: message.id ?? null,
        error: { code: -32601, message: `method not found: ${method ?? '?'}` },
      });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line === '') {
      continue;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // Malformed line: ignore (the client tolerates nothing, but a strict
      // stance here only affects diagnostics).
      continue;
    }
    handle(message);
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
