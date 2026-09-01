import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tempDir, storeEnv, skillMd } from '../../test/helpers.js';
import { cmdInstall } from './install.js';
import { cmdRemove } from './remove.js';
import { cmdCheck, cmdUpdate } from './update.js';
import { cmdList, cmdDoctor, cmdPrune } from './inspect.js';
import { parseArgs } from './args.js';
import { installedRootFor, readMeta } from '../lib/store.js';
import { slugOf } from '../lib/resolve.js';

/** Runs a git command, failing the test on error. */
function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
        return;
      }
      resolveResult(stdout);
    });
  });
}

/** Writes the fixture plugin into a working tree. */
async function writePlugin(work: string, version: string): Promise<void> {
  await mkdir(join(work, 'skills', 'hello'), { recursive: true });
  await writeFile(
    join(work, 'plugin.json'),
    JSON.stringify(
      {
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'hello',
        version,
        description: 'Test plugin',
      },
      undefined,
      2,
    ),
    'utf8',
  );
  await writeFile(join(work, 'skills', 'hello', 'SKILL.md'), skillMd('hello', 'Hi'), 'utf8');
  await writeFile(
    join(work, 'mcp.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { echo: { type: 'stdio', command: 'echo', args: ['--ping'] } },
    }),
    'utf8',
  );
}

let work = '';
let bare = '';
const source = () => `file://${bare}`;
const slug = () => slugOf(source());
let configPath = '';
let env: Record<string, string | undefined> = {};
let dataHome = { root: '' };

function argsOf(command: string, positionals: string[], flags: string[] = []) {
  return parseArgs([command, ...positionals, '--config', configPath, ...flags]);
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Set up the git fixture: working tree + bare remote.
  work = (await tempDir('oap-cli-work-')).root;
  bare = join((await tempDir('oap-cli-bare-')).root, 'remote.git');
  await git(['init', '--bare', bare]);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  await git(['init', '-b', 'main', work]);
  await git(['config', 'user.email', 'a@b.c'], work);
  await git(['config', 'user.name', 'Test'], work);
  await writePlugin(work, '1.0.0');
  await git(['add', '-A'], work);
  await git(['commit', '-m', 'init'], work);
  await git(['remote', 'add', 'origin', bare], work);
  await git(['push', '-u', 'origin', 'main'], work);
  await git(['tag', 'v1.0.0'], work);
  await git(['push', '--tags'], work);

  const store = await tempDir('oap-cli-store-');
  dataHome = { root: store.root };
  env = storeEnv(store.root);
  process.env['XDG_DATA_HOME'] = env['XDG_DATA_HOME'];
  configPath = join(store.root, 'opencode.json');
  await writeFile(
    configPath,
    JSON.stringify({ $schema: 'https://opencode.ai/config.json' }),
    'utf8',
  );
});

afterAll(async () => {
  delete process.env['XDG_DATA_HOME'];
  vi.restoreAllMocks();
});

describe('CLI lifecycle', () => {
  it('install --dry-run writes nothing', async () => {
    const exitCode = await cmdInstall(argsOf('install', ['file:///nonexistent.git']));
    expect(exitCode).toBe(1);
  });

  it('install fetches, validates and registers (and restarts are printed)', async () => {
    const exitCode = await cmdInstall(argsOf('install', [source()], ['--yes']));
    expect(exitCode).toBe(0);
    const text = await readFile(configPath, 'utf8');
    expect(text).toContain(source());
    const meta = await readMeta(slug(), env);
    expect(meta).not.toBeNull();
    expect(meta?.resolvedCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(meta?.source).toBe(source());
  });

  it('install refuses to overwrite an already-installed slug', async () => {
    const exitCode = await cmdInstall(argsOf('install', [source()], ['--yes']));
    expect(exitCode).toBe(1);
  });

  it('list shows the installed plugin', async () => {
    const exitCode = await cmdList();
    expect(exitCode).toBe(0);
  });

  it('check reports up to date, then update available after a push', async () => {
    let exitCode = await cmdCheck(argsOf('check', []));
    expect(exitCode).toBe(0);

    // Move the branch forward.
    await writePlugin(work, '1.1.0');
    await git(['add', '-A'], work);
    await git(['commit', '-m', 'v1.1.0'], work);
    await git(['push', 'origin', 'main'], work);

    exitCode = await cmdCheck(argsOf('check', []));
    expect(exitCode).toBe(2);
  });

  it('update applies the new version and preserves PLUGIN_DATA', async () => {
    const dataDir = join(dataHome.root, 'opencode/agent-plugins/data', slug());
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'state.txt'), 'keep me', 'utf8');

    const exitCode = await cmdUpdate(argsOf('update', [], ['--yes']));
    expect(exitCode).toBe(0);
    const meta = await readMeta(slug(), env);
    expect(meta?.manifestVersion).toBe('1.1.0');
    const version = JSON.parse(
      await readFile(join(installedRootFor(slug(), env), 'plugin.json'), 'utf8'),
    );
    expect(version.version).toBe('1.1.0');
    expect(await readFile(join(dataDir, 'state.txt'), 'utf8')).toBe('keep me');
  });

  it('doctor and prune handle the store', async () => {
    const exitDoctor = await cmdDoctor(argsOf('doctor', []));
    expect(exitDoctor).toBe(0);
    const exitPrune = await cmdPrune(argsOf('prune', [], ['--yes']));
    expect(exitPrune).toBe(0);
  });

  it('remove deletes the store entry and the config source', async () => {
    const exitCode = await cmdRemove(argsOf('remove', ['hello'], ['--yes', '--keep-data']));
    expect(exitCode).toBe(0);
    const text = await readFile(configPath, 'utf8');
    expect(text).not.toContain('file://');
    const meta = await readMeta(slug(), env);
    expect(meta).toBeNull();
  });
});
