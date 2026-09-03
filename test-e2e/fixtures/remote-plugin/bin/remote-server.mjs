#!/usr/bin/env node
/**
 * Streamable-http MCP server for the e2e remote fixture.
 *
 * Runs inside the container on 127.0.0.1:3999 (started by bootstrap.mjs)
 * and serves three streamable-http endpoints:
 *
 * - `/mcp`      — direct MCP endpoint (server "http" of the fixture).
 * - `/redirect` — responds 307 Temporary Redirect to `/mcp-final` (spec
 *   §7.2.1: client MUST follow redirects and re-send the request; the
 *   client-generated header precedence and header-forwarding rules are owned
 *   by opencode's HTTP stack — asserted here, not reimplemented).
 * - `/mcp-final` — the redirect target, serving the same MCP session.
 * - `/sse`      — 404 (the fixture's sse entry is skipped by the loader, so
 *   nothing ever connects here).
 *
 * Each endpoint gets its own MCP server instance so the tool RESULT can
 * identify which endpoint served the call (`R_ENDPOINT=`). The wrapper also
 * feeds the tool callback the headers of the CURRENT request (stored right
 * before `handleRequest`), so the tool result reports what the client sent:
 * `R_TOKEN=` (the plugin-configured header), `R_UA=` (user agent — used to
 * pin the client-generated-header precedence rule), and `R_ACCEPT=`.
 *
 * Every request is also logged to stdout as a `REMOTE:` line so the test can
 * assert on redirects (`path=/mcp-final`) and duplicate headers across hops.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

/** Headers of the request currently being handled (fed to tool callbacks). */
let currentRequest = { path: '', headers: {} };

/** Logs one received request to container stdout (parsed by the e2e test). */
function logReceived(method, path, headers) {
  currentRequest = {
    path,
    headers: { ...headers },
    method,
  };
  console.log(
    `REMOTE:${JSON.stringify({
      method,
      path,
      token: headers['x-e2e-token'] ?? headers['x-redirect-token'] ?? null,
      userAgent: headers['user-agent'] ?? null,
      accept: headers['accept'] ?? null,
      session: headers['mcp-session-id'] ?? null,
    })}`,
  );
}

/** Creates one MCP server instance bound to a redirect-target label. */
async function createMcpEndpoint(label) {
  const server = new McpServer(
    { name: 'remote-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    'ping',
    {
      description: `remote ping e2e (${label})`,
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({
      content: [
        {
          type: 'text',
          text:
            `pong ${String(message)} | R_ENDPOINT=${label}; ` +
            `R_PATH=${currentRequest.path}; ` +
            `R_TOKEN=${currentRequest.headers['x-e2e-token'] ?? currentRequest.headers['x-redirect-token'] ?? 'MISSING'}; ` +
            `R_UA=${currentRequest.headers['user-agent'] ?? 'MISSING'}; ` +
            `R_ACCEPT=${currentRequest.headers['accept'] ?? 'MISSING'}`,
        },
      ],
    }),
  );
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);
  return transport;
}

/** Endpoint transports, one per redirect target id. */
const endpoints = {
  mcp: await createMcpEndpoint('mcp'),
  final: await createMcpEndpoint('final'),
};

/** Reads and parses the JSON body of a POST request (or undefined). */
function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolveBody(body === '' ? undefined : JSON.parse(body));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', BASE);
  const method = req.method ?? 'GET';
  const headers = { ...req.headers };
  // Normalize to lowercase names (Node lowercases them already).
  logReceived(method, url.pathname, headers);

  if (url.pathname === '/redirect') {
    res.writeHead(307, { location: `${BASE}/mcp-final` });
    res.end();
    return;
  }
  if (url.pathname !== '/mcp' && url.pathname !== '/mcp-final') {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  const label = url.pathname === '/mcp' ? 'mcp' : 'final';
  try {
    const parsedBody = await readBody(req);
    await endpoints[label].handleRequest(req, res, parsedBody);
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`REMOTE_SERVER_READY ${PORT}`);
});
