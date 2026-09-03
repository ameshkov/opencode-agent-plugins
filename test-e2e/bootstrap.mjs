/**
 * Container entrypoint for the e2e scenarios (no shell in the image).
 *
 * The image's ENTRYPOINT is `node /app/bootstrap.mjs`; the container command
 * is the scenario mode. The bootstrap:
 *
 * 1. writes the opencode config for the mode (`write-config.mjs`), unless
 *    the scenario was already set up — the `/app/ctrl/setup` marker makes the
 *    config survive container restarts, so CLI-installed sources and the
 *    fixture repo created earlier stay on disk;
 * 2. for `cli` mode, creates the git fixture (`git-fixture.mjs init`) and
 *    then WAITS for the `/app/ctrl/serve` marker — the test runs CLI commands
 *    first and signals "open opencode" afterwards;
 * 3. starts the fake OpenAI-compatible model server in-process
 *    (`fake-model-server.mjs`) and, for `remote` mode, the streamable-http
 *    MCP fixture server;
 * 4. spawns `opencode serve` (published port 4096, hostname 0.0.0.0) with
 *    stdio inherited; `HOME` is the container environment's
 *    `/app/opencode-home` (the CLI execs share it, so the store paths
 *    resolve identically), and `/app/path-bin` is prepended to PATH for the
 *    bare-command fixture server;
 * 5. stays alive as PID 1 until opencode exits.
 *
 * The vitest host connects to the opencode server API and asserts on the
 * executed MCP tool round trip, the captured model requests, and the CLI
 * store/config effects. Nothing opencode-related runs on the host.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { startFakeModel } from './fake-model-server.mjs';
import { writeConfig } from './write-config.mjs';

const mode = process.argv[2] ?? 'hook';

/** Modes that wait for `/app/ctrl/serve` before starting opencode. */
const WAIT_FOR_SERVE = new Set(['cli']);

/** Modes that create the git fixture repository during setup. */
const NEEDS_GIT_FIXTURE = new Set(['cli']);

/** Modes that start the remote streamable-http MCP fixture server. */
const NEEDS_REMOTE_SERVER = new Set(['remote']);

const CTRL_DIR = '/app/ctrl';
const SETUP_MARK = `${CTRL_DIR}/setup`;
const SERVE_MARK = `${CTRL_DIR}/serve`;

/** True once the control directory was initialized by an earlier run. */
function isSetUp() {
  return existsSync(SETUP_MARK);
}

/** Runs `git-fixture.mjs <command>` via the node binary (loud on failure). */
function runGitFixture(command) {
  const child = spawn('node', ['/app/git-fixture.mjs', command], {
    stdio: 'inherit',
  });
  return new Promise((resolveResult, reject) => {
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`git-fixture ${command} exited with ${String(code)}`));
        return;
      }
      resolveResult();
    });
  });
}

/** Polls until the given file exists (bootstrap stays alive meanwhile). */
async function waitForFile(path) {
  for (;;) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolvePause) => setTimeout(resolvePause, 500));
  }
}

/** Writes the setup marker and prepares the ctrl dir once per container. */
async function ensureSetup() {
  if (isSetUp()) {
    return;
  }
  await writeConfig(mode);
  if (NEEDS_GIT_FIXTURE.has(mode)) {
    await runGitFixture('init');
  }
  mkdirSync(CTRL_DIR, { recursive: true });
  writeFileSync(SETUP_MARK, '');
}

/** Starts the remote streamable-http MCP fixture server as a child. */
function startRemoteServer() {
  const child = spawn('node', ['/app/fixtures/remote-plugin/bin/remote-server.mjs'], {
    stdio: 'inherit',
  });
  child.on('exit', (code) => {
    console.error(`remote fixture server exited with ${String(code)}`);
  });
}

await ensureSetup();
// The fake model starts before any phase gate: `cli` mode's container never
// listens on 4096 (opencode starts only after the serve marker), so
// FAKE_SERVER_READY is the earliest, always-emitted readiness signal the
// orchestrator can wait on.
await startFakeModel();
if (WAIT_FOR_SERVE.has(mode)) {
  await waitForFile(SERVE_MARK);
}
if (NEEDS_REMOTE_SERVER.has(mode)) {
  startRemoteServer();
}
await mkdir('/app/opencode-home', { recursive: true });

const opencode = spawn(
  'opencode',
  ['serve', '--print-logs', '--port', '4096', '--hostname', '0.0.0.0'],
  {
    cwd: '/app/workspace',
    stdio: 'inherit',
    env: {
      ...process.env,
      HOME: '/app/opencode-home',
      PATH: `/app/path-bin:${process.env['PATH'] ?? ''}`,
    },
  },
);

opencode.on('exit', (code) => {
  process.exit(code ?? 0);
});

// Forward docker's SIGTERM (stop/restart) to opencode so the container stops
// cleanly instead of leaving a server bound to 4096 (which would break an
// in-place restart of the same container).
process.on('SIGTERM', () => {
  opencode.kill('SIGTERM');
});
