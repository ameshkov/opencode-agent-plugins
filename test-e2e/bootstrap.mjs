/**
 * Container entrypoint for the e2e scenario (no shell in the image).
 *
 * The image's ENTRYPOINT is `node /app/bootstrap.mjs`; the container command
 * is the scenario mode (`hook` | `static`). The bootstrap:
 *
 * 1. writes the opencode config for the mode (`write-config.mjs`);
 * 2. starts the fake OpenAI-compatible model server in-process
 *    (`fake-model-server.mjs`), so its `CAPTURE:` lines flow to the
 *    container stdout;
 * 3. spawns `opencode serve` (published port 4096, hostname 0.0.0.0) with
 *    stdio inherited — its "listening" line is what the test waits for;
 * 4. stays alive as PID 1 until opencode exits.
 *
 * The vitest host connects to the opencode server API and asserts on the
 * executed MCP tool round trip and the captured model requests. Nothing
 * opencode-related runs on the host.
 */

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { startFakeModel } from './fake-model-server.mjs';
import { writeConfig } from './write-config.mjs';

const mode = process.argv[2] ?? 'hook';

await writeConfig(mode);
await startFakeModel();
await mkdir('/app/opencode-home', { recursive: true });

const opencode = spawn(
  'opencode',
  ['serve', '--print-logs', '--port', '4096', '--hostname', '0.0.0.0'],
  {
    cwd: '/app/workspace',
    stdio: 'inherit',
    env: { ...process.env, HOME: '/app/opencode-home' },
  },
);

opencode.on('exit', (code) => {
  process.exit(code ?? 0);
});
