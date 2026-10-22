import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  gitBareFixture,
  gitCmd,
  skillMd,
  storeEnv,
  tempDir,
  tmpPlugin,
  VALID_PLUGIN_JSON,
  writePluginTree,
} from '../../test/helpers.js';
import { cmdInstall } from './install.js';
import { cmdCheck, cmdUpdate } from './update.js';
import { cmdList, cmdDoctor, cmdPrune } from './inspect.js';
import { parseArgs } from './args.js';
import { installedRootFor, readMeta, removeMeta } from '../lib/store.js';
import { dataDirForKey, storeDir } from '../lib/data.js';
import { slugOf } from '../lib/resolve.js';

/** Queued answers for the mocked `confirm` prompt (in order of calls). */
const confirmAnswers = vi.hoisted(() => ({ queue: [] as boolean[] }));
vi.mock('./prompts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts.js')>();
  return {
    ...actual,
    confirm: vi.fn(async () => confirmAnswers.queue.shift() ?? false),
  };
});

/** A switch that forces the staging move to fail in one test. */
const moveFailure = vi.hoisted(() => ({ enabled: false, sources: [] as string[] }));
vi.mock('../lib/move.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/move.js')>();
  return {
    ...actual,
    moveTree: async (from: string, to: string) => {
      if (moveFailure.enabled) {
        moveFailure.sources.push(from);
        throw new Error('simulated filesystem failure');
      }
      return actual.moveTree(from, to);
    },
  };
});

let work = '';
let bare = '';
const source = () => `file://${bare}`;
const slug = () => slugOf(source());
let configPath = '';
let env: Record<string, string | undefined> = {};
let configHome = { root: '' };
let stateHome: { root: string; cleanup: () => Promise<void> } = {
  root: '',
  cleanup: async () => {},
};

function argsOf(command: string, positionals: string[], flags: string[] = []) {
  return parseArgs([command, ...positionals, '--config', configPath, ...flags]);
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Set up the git fixture: working tree + bare remote.
  work = (await tempDir('oap-cli-work-')).root;
  bare = join((await tempDir('oap-cli-bare-')).root, 'remote.git');
  await gitCmd(['init', '--bare', bare]);
  await gitCmd(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  await gitCmd(['init', '-b', 'main', work]);
  await gitCmd(['config', 'user.email', 'a@b.c'], work);
  await gitCmd(['config', 'user.name', 'Test'], work);
  await writePluginTree(work, '1.0.0');
  await gitCmd(['add', '-A'], work);
  await gitCmd(['commit', '-m', 'init'], work);
  await gitCmd(['remote', 'add', 'origin', bare], work);
  await gitCmd(['push', '-u', 'origin', 'main'], work);
  await gitCmd(['tag', 'v1.0.0'], work);
  await gitCmd(['push', '--tags'], work);

  const store = await tempDir('oap-cli-store-');
  configHome = { root: store.root };
  env = storeEnv(store.root);
  process.env['XDG_CONFIG_HOME'] = env['XDG_CONFIG_HOME'];
  process.env['OPENCODE_CONFIG_DIR'] = '';
  // Keep the reload discovery away from the developer's real service.json:
  // the CLI tests must never call a running OpenCode.
  stateHome = await tempDir('oap-cli-state-');
  process.env['XDG_STATE_HOME'] = stateHome.root;
  configPath = join(store.root, 'opencode.json');
  await writeFile(
    configPath,
    JSON.stringify({ $schema: 'https://opencode.ai/config.json' }),
    'utf8',
  );
});

afterAll(async () => {
  delete process.env['XDG_CONFIG_HOME'];
  delete process.env['OPENCODE_CONFIG_DIR'];
  delete process.env['XDG_STATE_HOME'];
  await stateHome.cleanup();
  vi.restoreAllMocks();
});

describe('CLI lifecycle', () => {
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

  it('install aborts on fatal validation with nothing changed on disk (cli-lifecycle.md)', async () => {
    const broken = await gitBareFixture({
      'plugin.json': '{ not json',
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
    });
    try {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitCode = await cmdInstall(argsOf('install', [broken.source], ['--yes']));
      expect(exitCode).toBe(1);
      expect(err.mock.calls.some((call) => String(call[0]).includes('install will abort'))).toBe(
        true,
      );
      const text = await readFile(configPath, 'utf8');
      expect(text).not.toContain(broken.source);
      const meta = await readMeta(broken.slug, env);
      expect(meta).toBeNull();
    } finally {
      await broken.cleanup();
    }
  });

  it('install aborts on a broken path plugin without touching the config or source', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': '{ not json' });
    try {
      const before = await readFile(configPath, 'utf8');
      const exitCode = await cmdInstall(argsOf('install', [plugin.root], ['--yes']));
      expect(exitCode).toBe(1);
      expect(await readFile(configPath, 'utf8')).toBe(before);
      expect((await stat(plugin.root)).isDirectory()).toBe(true);
    } finally {
      await plugin.cleanup();
    }
  });

  it('install creates the config file when none exists (cli-lifecycle.md)', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const fresh = await tempDir('oap-cli-fresh-');
    try {
      const freshPath = join(fresh.root, 'opencode.json');
      const exitCode = await cmdInstall(
        argsOf('install', [plugin.root], ['--yes', '--config', freshPath]),
      );
      expect(exitCode).toBe(0);
      const text = await readFile(freshPath, 'utf8');
      expect(text).toContain(plugin.root);
    } finally {
      await plugin.cleanup();
      await fresh.cleanup();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'install refuses an unreadable config without overwriting it or writing a backup',
    async () => {
      const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
      const home = await tempDir('oap-cli-unreadable-');
      const previousXdg = process.env['XDG_CONFIG_HOME'];
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const configFile = join(home.root, 'opencode.json');
      const before = '{"$schema":"https://opencode.ai/config.json","theme":"dark"}';
      try {
        process.env['XDG_CONFIG_HOME'] = home.root;
        await writeFile(configFile, before, 'utf8');
        await chmod(configFile, 0o200);
        let exitCode = 0;
        try {
          exitCode = await cmdInstall(
            argsOf('install', [plugin.root], ['--yes', '--config', configFile]),
          );
        } finally {
          await chmod(configFile, 0o600);
        }
        expect(exitCode).toBe(1);
        expect(
          err.mock.calls.some((call) =>
            String(call[0]).includes('config exists but could not be read'),
          ),
        ).toBe(true);
        // Byte-identical content, no backup, no partial write.
        expect(await readFile(configFile, 'utf8')).toBe(before);
        expect(await readdir(storeDir('backups', storeEnv(home.root))).catch(() => [])).toEqual([]);
      } finally {
        if (previousXdg === undefined) {
          delete process.env['XDG_CONFIG_HOME'];
        } else {
          process.env['XDG_CONFIG_HOME'] = previousXdg;
        }
        err.mockRestore();
        await plugin.cleanup();
        await home.cleanup();
      }
    },
  );

  it('install reports a staging move failure cleanly and drops the staging tree', async () => {
    const fixture = await gitBareFixture({ 'plugin.json': VALID_PLUGIN_JSON });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    moveFailure.enabled = true;
    moveFailure.sources.length = 0;
    try {
      const exitCode = await cmdInstall(argsOf('install', [fixture.source], ['--yes']));
      expect(exitCode).toBe(1);
      const messages = err.mock.calls.map((call) => String(call[0]));
      expect(messages.some((message) => message.includes('simulated filesystem failure'))).toBe(
        true,
      );
      // No stack trace on stderr.
      expect(messages.some((message) => message.includes('\n    at '))).toBe(false);
      expect(moveFailure.sources).toHaveLength(1);
      expect(await stat(moveFailure.sources[0]!).catch(() => null)).toBeNull();
      expect(await readMeta(fixture.slug, env)).toBeNull();
    } finally {
      moveFailure.enabled = false;
      err.mockRestore();
      await fixture.cleanup();
    }
  });

  it('install warns and asks before adding the loader entry, then registers on accept', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const scope = await tempDir('oap-cli-bootstrap-');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const freshPath = join(scope.root, 'opencode.json');
      await writeFile(freshPath, '{"$schema": "https://opencode.ai/config.json"}', 'utf8');
      // First confirm: add the loader entry; second: install the plugin.
      confirmAnswers.queue.push(true, true);
      const exitCode = await cmdInstall(argsOf('install', [plugin.root], ['--config', freshPath]));
      expect(exitCode).toBe(0);
      const text = await readFile(freshPath, 'utf8');
      expect(text).toContain('opencode-agent-plugins');
      expect(text).toContain(plugin.root);
      expect(
        err.mock.calls.some((call) => String(call[0]).includes('no "opencode-agent-plugins"')),
      ).toBe(true);
    } finally {
      confirmAnswers.queue.length = 0;
      err.mockRestore();
      await plugin.cleanup();
      await scope.cleanup();
    }
  });

  it('install aborts without writing when the user declines the loader entry', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const scope = await tempDir('oap-cli-bootstrap-');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const freshPath = join(scope.root, 'opencode.json');
      await writeFile(freshPath, '{"$schema": "https://opencode.ai/config.json"}', 'utf8');
      confirmAnswers.queue.push(false);
      const exitCode = await cmdInstall(argsOf('install', [plugin.root], ['--config', freshPath]));
      expect(exitCode).toBe(1);
      // Nothing was written: not even the config file's plugins array.
      expect(await readFile(freshPath, 'utf8')).not.toContain(plugin.root);
      expect(err.mock.calls.some((call) => String(call[0]).includes('aborted'))).toBe(true);
    } finally {
      confirmAnswers.queue.length = 0;
      err.mockRestore();
      await plugin.cleanup();
      await scope.cleanup();
    }
  });

  it('install --yes warns and auto-adds the loader entry', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const scope = await tempDir('oap-cli-bootstrap-');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const freshPath = join(scope.root, 'opencode.json');
      await writeFile(freshPath, '{"$schema": "https://opencode.ai/config.json"}', 'utf8');
      const exitCode = await cmdInstall(
        argsOf('install', [plugin.root], ['--yes', '--config', freshPath]),
      );
      expect(exitCode).toBe(0);
      const text = await readFile(freshPath, 'utf8');
      expect(text).toContain('opencode-agent-plugins');
      expect(
        err.mock.calls.some((call) => String(call[0]).includes('no "opencode-agent-plugins"')),
      ).toBe(true);
      // No prompt was shown under --yes.
      expect(confirmAnswers.queue.length).toBe(0);
    } finally {
      confirmAnswers.queue.length = 0;
      err.mockRestore();
      await plugin.cleanup();
      await scope.cleanup();
    }
  });

  it('install does not prompt when the loader entry already exists', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const scope = await tempDir('oap-cli-bootstrap-');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const freshPath = join(scope.root, 'opencode.json');
      await writeFile(
        freshPath,
        '{"plugin": [["opencode-agent-plugins", { "plugins": [] }]]}',
        'utf8',
      );
      const exitCode = await cmdInstall(
        argsOf('install', [plugin.root], ['--yes', '--config', freshPath]),
      );
      expect(exitCode).toBe(0);
      expect(confirmAnswers.queue.length).toBe(0);
      expect(
        err.mock.calls.some((call) => String(call[0]).includes('no "opencode-agent-plugins"')),
      ).toBe(false);
    } finally {
      confirmAnswers.queue.length = 0;
      err.mockRestore();
      await plugin.cleanup();
      await scope.cleanup();
    }
  });

  it('install --no-register prints a config snippet for a path source (cli-lifecycle.md)', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    try {
      const before = await readFile(configPath, 'utf8');
      const exitCode = await cmdInstall(
        argsOf('install', [plugin.root], ['--no-register', '--yes']),
      );
      expect(exitCode).toBe(0);
      // Nothing is written: the user adds the printed snippet manually.
      expect(await readFile(configPath, 'utf8')).toBe(before);
      const logs = vi
        .mocked(console.log)
        .mock.calls.map((call) => String(call[0]))
        .join('\n');
      expect(logs).toContain('Add this to your opencode config');
      expect(logs).toContain(
        `{ "package": "opencode-agent-plugins", "options": { "plugins": ["${plugin.root}"] } }`,
      );
      expect(logs).toContain('not registered');
    } finally {
      await plugin.cleanup();
    }
  });

  it('install --no-register prints a config snippet for a git source (cli-lifecycle.md)', async () => {
    const fixture = await gitBareFixture({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
    });
    try {
      const before = await readFile(configPath, 'utf8');
      const exitCode = await cmdInstall(
        argsOf('install', [fixture.source], ['--no-register', '--yes']),
      );
      expect(exitCode).toBe(0);
      // The store entry is created, but the config is left untouched.
      expect(await readFile(configPath, 'utf8')).toBe(before);
      expect(await readMeta(fixture.slug, env)).not.toBeNull();
      const logs = vi
        .mocked(console.log)
        .mock.calls.map((call) => String(call[0]))
        .join('\n');
      expect(logs).toContain(
        `{ "package": "opencode-agent-plugins", "options": { "plugins": ["${fixture.source}"] } }`,
      );
      expect(logs).toContain('not registered');
    } finally {
      // The store entry holds no config reference (registration was skipped),
      // so remove it to keep the shared suite state consistent.
      await rm(installedRootFor(fixture.slug, env), { recursive: true, force: true });
      await removeMeta(fixture.slug, env);
      await rm(dataDirForKey(fixture.slug, env), { recursive: true, force: true });
      await fixture.cleanup();
    }
  });

  it('install says so when opencode.jsonc wins over opencode.json (cli-lifecycle.md)', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const scope = await tempDir('oap-cli-jsonc-');
    const cwd = process.cwd();
    try {
      const jsonPath = join(scope.root, 'opencode.json');
      const jsoncPath = join(scope.root, 'opencode.jsonc');
      await writeFile(jsonPath, '{}', 'utf8');
      await writeFile(jsoncPath, '{}', 'utf8');
      process.chdir(scope.root);
      const exitCode = await cmdInstall(parseArgs(['install', plugin.root, '--yes']));
      expect(exitCode).toBe(0);
      // The edit lands in opencode.jsonc; opencode.json is untouched.
      expect(await readFile(jsoncPath, 'utf8')).toContain(plugin.root);
      expect(await readFile(jsonPath, 'utf8')).toBe('{}');
      const logs = vi
        .mocked(console.log)
        .mock.calls.map((call) => String(call[0]))
        .join('\n');
      expect(logs).toContain(jsoncPath);
      expect(logs).toContain('opencode.jsonc wins over opencode.json');
    } finally {
      process.chdir(cwd);
      await plugin.cleanup();
      await scope.cleanup();
    }
  });

  it('list shows the installed plugin with its status column (cli-lifecycle.md)', async () => {
    const exitCode = await cmdList();
    expect(exitCode).toBe(0);
    // The HEAD-sourced install is still up to date at this point (the
    // branch only moves in the next test), so the status column reads
    // "current" — the `current / update available / pinned` set.
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(output).toContain('hello v1.0.0');
    expect(output).toContain('file://');
    expect(output).toContain('ref:HEAD');
    expect(output).toContain('  current');
  });

  it('check reports up to date, then update available after a push', async () => {
    let exitCode = await cmdCheck(argsOf('check', []));
    expect(exitCode).toBe(0);

    // Move the branch forward.
    await writePluginTree(work, '1.1.0');
    await gitCmd(['add', '-A'], work);
    await gitCmd(['commit', '-m', 'v1.1.0'], work);
    await gitCmd(['push', 'origin', 'main'], work);

    exitCode = await cmdCheck(argsOf('check', []));
    expect(exitCode).toBe(2);
  });

  it('update applies the new version and preserves PLUGIN_DATA', async () => {
    const dataDir = join(configHome.root, 'opencode', 'opencode-agent-plugins', 'data', slug());
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

    // No service is running in this test, so the CLI prints the restart
    // hint (the reload fallback).
    const logs = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(logs.some((message) => message.includes('Restart OpenCode to pick it up'))).toBe(true);
    expect(logs.some((message) => message.includes('updated hello 1.1.0 (commit'))).toBe(true);
  });

  it('update resolves a manifest name to its store entry (cli-lifecycle.md)', async () => {
    await writePluginTree(work, '1.2.0');
    await gitCmd(['add', '-A'], work);
    await gitCmd(['commit', '-m', 'v1.2.0'], work);
    await gitCmd(['push', 'origin', 'main'], work);

    const exitCode = await cmdUpdate(argsOf('update', ['hello'], ['--yes']));
    expect(exitCode).toBe(0);
    const meta = await readMeta(slug(), env);
    expect(meta?.manifestVersion).toBe('1.2.0');
    const version = JSON.parse(
      await readFile(join(installedRootFor(slug(), env), 'plugin.json'), 'utf8'),
    );
    expect(version.version).toBe('1.2.0');
  });

  it('update reports an unmatched name as an error (cli-lifecycle.md)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const exitCode = await cmdUpdate(argsOf('update', ['not-installed'], ['--yes']));
      expect(exitCode).toBe(1);
      expect(err.mock.calls.some((call) => String(call[0]).includes('not installed'))).toBe(true);
      expect((await readMeta(slug(), env))?.manifestVersion).toBe('1.2.0');
    } finally {
      err.mockRestore();
    }
  });

  it('prune refuses to delete when the config cannot be read (cli-lifecycle.md)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const missing = join(configHome.root, 'missing-config.json');
      const exitCode = await cmdPrune(parseArgs(['prune', '--yes', '--config', missing]));
      expect(exitCode).toBe(1);
      expect(err.mock.calls.some((call) => String(call[0]).includes('refusing to prune'))).toBe(
        true,
      );
      expect((await stat(installedRootFor(slug(), env))).isDirectory()).toBe(true);
      expect((await stat(dataDirForKey(slug(), env))).isDirectory()).toBe(true);
    } finally {
      err.mockRestore();
    }
  });

  it('doctor and prune handle the store', async () => {
    const exitDoctor = await cmdDoctor(argsOf('doctor', []));
    expect(exitDoctor).toBe(0);
    const exitPrune = await cmdPrune(argsOf('prune', [], ['--yes']));
    expect(exitPrune).toBe(0);
  });
});
