#!/usr/bin/env node
/**
 * Minimal MCP stdio server for the e2e fixture plugin.
 *
 * Reports the subprocess environment it was launched with (PLUGIN_ROOT,
 * PLUGIN_DATA, cwd, and whether the data dir exists) inside the `echo_ping`
 * tool RESULT, so the e2e test can assert the registration contract from the
 * executed tool round trip (docs/explanation/design.md §5.7–§5.8): environment injection,
 * cwd defaulting, and the eagerly-created PLUGIN_DATA directory.
 *
 * It also proves placeholder expansion (§5.5): the fixture's mcp.json
 * declares `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` literals inside `args` and `env`
 * values, and the loader must expand them BEFORE registration (opencode
 * passes env values verbatim — empirical finding §9.1.5). E2E_ROOT/E2E_DATA
 * and the `--placeholder-*` args are the expanded values; ARGS_OK flips when
 * they match the injected PLUGIN_ROOT/PLUGIN_DATA.
 */

import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const root = process.env['PLUGIN_ROOT'] ?? '';
const data = process.env['PLUGIN_DATA'] ?? '';
const cwd = process.cwd();
const e2eRoot = process.env['E2E_ROOT'] ?? '';
const e2eData = process.env['E2E_DATA'] ?? '';

/** Value following `--flag` on argv (or ''). */
function argAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? '' : String(process.argv[index + 1] ?? '');
}

const argsOk = argAfter('--placeholder-root') === root && argAfter('--placeholder-data') === data;

const server = new McpServer({ name: 'echo', version: '1.0.0' });

server.registerTool(
  'echo_ping',
  {
    description: `echo_ping e2e: PLUGIN_ROOT=${root}; PLUGIN_DATA=${data}; CWD=${cwd}`,
    inputSchema: {
      message: z.string(),
    },
  },
  async ({ message }) => ({
    content: [
      {
        type: 'text',
        text:
          `pong ${String(message)} | ` +
          `PLUGIN_ROOT=${root}; PLUGIN_DATA=${data}; ` +
          `CWD=${cwd}; DATA_EXISTS=${existsSync(data)}; ` +
          `E2E_ROOT=${e2eRoot}; E2E_DATA=${e2eData}; ARGS_OK=${argsOk}`,
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
