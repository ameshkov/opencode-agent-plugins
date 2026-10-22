/**
 * Reload discovery and request behavior (`docs/explanation/changes-and-reload.md`).
 *
 * The tests use a real HTTP server and the real `@opencode/client` discovery
 * path: a temporary `XDG_STATE_HOME` holds a `service.json` that points at the
 * stub. No OpenCode process is started.
 */

import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from './args.js';
import { reloadAfter, reloadOpenCode, type ReloadOutcome } from './reload.js';

/** Version the stub service reports. */
const VERSION = '2.0.16';

/** One stub service plus its temporary state directory. */
interface StubService {
  server: Server;
  stateRoot: string;
  url: string;
  reloadStatus: number;
  requests: Array<{ method: string; url: string; authorization: string | undefined }>;
}

/**
 * Starts a stub OpenCode service and writes its registration file.
 *
 * @param reloadStatus - HTTP status the reload endpoint returns.
 * @returns The running stub.
 */
async function startStub(reloadStatus = 204): Promise<StubService> {
  const requests: StubService['requests'] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorization: request.headers.authorization,
    });
    if (request.url === '/api/info') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: VERSION, pid: process.pid }));
      return;
    }
    if (request.url === '/api/location/reload' && request.method === 'POST') {
      response.writeHead(reloadStatus);
      response.end();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('stub server did not bind a TCP port');
  }
  const url = `http://127.0.0.1:${address.port}`;
  const stateRoot = await mkdtemp(join(tmpdir(), 'oap-reload-'));
  await mkdir(join(stateRoot, 'opencode'), { recursive: true });
  await writeFile(
    join(stateRoot, 'opencode', 'service.json'),
    JSON.stringify({
      id: 'test-service',
      version: VERSION,
      url,
      pid: process.pid,
      password: 'secret',
    }),
    'utf8',
  );
  process.env['XDG_STATE_HOME'] = stateRoot;
  return { server, stateRoot, url, reloadStatus, requests };
}

/** Stops the stub and removes its state directory. */
async function stopStub(stub: StubService): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stub.server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  await rm(stub.stateRoot, { recursive: true, force: true });
  delete process.env['XDG_STATE_HOME'];
}

afterEach(() => {
  delete process.env['XDG_STATE_HOME'];
  vi.restoreAllMocks();
});

describe('reloadOpenCode', () => {
  it('reports no service when the registration file is absent', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'oap-reload-empty-'));
    process.env['XDG_STATE_HOME'] = stateRoot;
    try {
      await expect(reloadOpenCode()).resolves.toEqual({ status: 'no-service' });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it('posts to the reload endpoint with basic auth', async () => {
    const stub = await startStub();
    try {
      await expect(reloadOpenCode()).resolves.toEqual({ status: 'reloaded' });
      const reload = stub.requests.find(
        (request) => request.url === '/api/location/reload' && request.method === 'POST',
      );
      expect(reload).toBeDefined();
      const expected = Buffer.from('opencode:secret').toString('base64');
      expect(reload?.authorization).toBe(`Basic ${expected}`);
    } finally {
      await stopStub(stub);
    }
  });

  it('reports a failed reload when the endpoint rejects the request', async () => {
    const stub = await startStub(401);
    try {
      const outcome = await reloadOpenCode();
      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.message.length).toBeGreaterThan(0);
      }
      // A discovery failure must not pass as a rejected reload: the request
      // must have reached the endpoint and got the 401.
      expect(stub.requests).toContainEqual(
        expect.objectContaining({ method: 'POST', url: '/api/location/reload' }),
      );
    } finally {
      await stopStub(stub);
    }
  });
});

describe('reloadAfter', () => {
  const HINT = 'Restart OpenCode to use it.';

  it('prints the hint and skips the reload with --no-reload', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reload = vi.fn(async (): Promise<ReloadOutcome> => ({ status: 'reloaded' }));

    await reloadAfter(parseArgs(['install', '--no-reload']), HINT, reload);

    expect(reload).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(HINT);
  });

  it('prints the no-register hint and skips the reload with --no-register', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reload = vi.fn(async (): Promise<ReloadOutcome> => ({ status: 'reloaded' }));
    const noRegisterHint = 'Add the config snippet above, then restart OpenCode to use it.';

    await reloadAfter(parseArgs(['install', '--no-register']), HINT, reload, noRegisterHint);

    expect(reload).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(noRegisterHint);
    expect(log).not.toHaveBeenCalledWith(HINT);
  });

  it('calls the reload and prints the outcome without an opt-out', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const reload = vi.fn(async (): Promise<ReloadOutcome> => ({ status: 'reloaded' }));

    await reloadAfter(parseArgs(['install']), HINT, reload);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'OpenCode reloaded; the change applies where this config is loaded.',
    );
  });

  it('prints the warning and the hint when the reload fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn(async (): Promise<ReloadOutcome> => ({
      status: 'failed',
      message: 'connection refused',
    }));

    await reloadAfter(parseArgs(['remove']), HINT, reload);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('warn:    could not reload OpenCode: connection refused');
    expect(log).toHaveBeenCalledWith(HINT);
  });
});
