#!/usr/bin/env node
/**
 * Minimal MCP stdio server for the e2e fixture plugin.
 *
 * Reports the subprocess environment it was launched with (PLUGIN_ROOT,
 * PLUGIN_DATA, cwd, and whether the data dir exists) inside the `echo_ping`
 * tool RESULT, so the e2e test can assert the registration contract from the
 * executed tool round trip (docs/design.md §5.7–§5.8): environment injection,
 * cwd defaulting, and the eagerly-created PLUGIN_DATA directory.
 */

import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const root = process.env['PLUGIN_ROOT'] ?? '';
const data = process.env['PLUGIN_DATA'] ?? '';
const cwd = process.cwd();

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
          `CWD=${cwd}; DATA_EXISTS=${existsSync(data)}`,
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
