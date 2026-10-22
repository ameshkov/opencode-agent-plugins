/**
 * CLI-level doctor/prune/list behavior that needs process-global state
 * (`docs/explanation/cli-lifecycle.md`).
 */

import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cmdDoctor, cmdList, cmdPrune } from './inspect.js';
import { cmdCheck, cmdUpdate } from './update.js';
import { parseArgs } from './args.js';
import { configDir, dataDirForKey, storeDir } from '../lib/data.js';
import { installedRootFor, metaPathFor, writeMeta } from '../lib/store.js';
import { storeEnv, tempDir, type TempDir } from '../../test/helpers.js';

let state: TempDir;
const originalCwd = process.cwd();

function configWith(sources: string[]): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    plugins: [{ package: 'opencode-agent-plugins', options: { plugins: sources } }],
  });
}

function manifestOf(name: string): string {
  return JSON.stringify(
    {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name,
      version: '1.0.0',
      description: `${name} plugin`,
    },
    undefined,
    2,
  );
}

/** Runs a test with an isolated store and config home. */
async function withEnv<T>(
  fn: (env: Record<string, string | undefined>, configPath: string) => Promise<T>,
): Promise<T> {
  const home = await tempDir('oap-cli-inspect-');
  const previousXdg = process.env['XDG_CONFIG_HOME'];
  const previousOpencode = process.env['OPENCODE_CONFIG_DIR'];
  const env = storeEnv(home.root);
  process.env['XDG_CONFIG_HOME'] = env['XDG_CONFIG_HOME'];
  process.env['OPENCODE_CONFIG_DIR'] = '';
  try {
    return await fn(env, join(home.root, 'opencode.json'));
  } finally {
    process.chdir(originalCwd);
    if (previousXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = previousXdg;
    }
    if (previousOpencode === undefined) {
      delete process.env['OPENCODE_CONFIG_DIR'];
    } else {
      process.env['OPENCODE_CONFIG_DIR'] = previousOpencode;
    }
    await home.cleanup();
  }
}

/** Writes a store entry with a readable or unreadable manifest. */
async function writeStoreEntry(
  env: Record<string, string | undefined>,
  slug: string,
  manifest = manifestOf('hello'),
): Promise<string> {
  const root = installedRootFor(slug, env);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'plugin.json'), manifest, 'utf8');
  await writeMeta(
    slug,
    {
      source: 'file:///nowhere/org-repo.git',
      url: 'file:///nowhere/org-repo.git',
      resolvedCommit: 'a'.repeat(40),
      manifestVersion: '1.0.0',
      installedAt: '2026-01-01T00:00:00.000Z',
    },
    env,
  );
  return root;
}

/** Writes a data directory with a keep-me file. */
async function writeData(env: Record<string, string | undefined>, key: string): Promise<string> {
  const dir = dataDirForKey(key, env);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.txt'), 'keep me', 'utf8');
  return dir;
}

function logLines(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
}

function errorLines(): string[] {
  return vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state = await tempDir('oap-cli-inspect-state-');
  process.env['XDG_STATE_HOME'] = state.root;
});

afterAll(async () => {
  delete process.env['XDG_STATE_HOME'];
  process.chdir(originalCwd);
  vi.restoreAllMocks();
  await state.cleanup();
});

describe('prune refusal gate', () => {
  it('refuses an unresolved (malformed) git source with data', async () => {
    await withEnv(async (env, configPath) => {
      await writeFile(configPath, configWith(['https://github.com/org/repo.git#bad ref']), 'utf8');
      const dataDir = await writeData(env, 'org-repo');
      vi.mocked(console.log).mockClear();
      vi.mocked(console.error).mockClear();

      expect(await cmdPrune(parseArgs(['prune', '--yes', '--config', configPath]))).toBe(1);
      expect(errorLines().some((line) => line.includes('refusing to prune'))).toBe(true);
      expect((await stat(dataDir)).isDirectory()).toBe(true);

      vi.mocked(console.log).mockClear();
      expect(await cmdDoctor(parseArgs(['doctor', '--config', configPath]))).toBe(2);
      expect(logLines().some((line) => line.includes('no-store-entry'))).toBe(true);
    });
  });

  it('refuses a project relative path that does not resolve and has data', async () => {
    await withEnv(async (env) => {
      const project = await tempDir('oap-cli-inspect-project-');
      try {
        const configPath = join(project.root, 'opencode.json');
        await writeFile(configPath, configWith(['./missing-plugin']), 'utf8');
        const dataDir = await writeData(env, 'possibly-referenced');
        process.chdir(project.root);
        vi.mocked(console.log).mockClear();
        vi.mocked(console.error).mockClear();

        expect(await cmdPrune(parseArgs(['prune', '--yes', '--config', configPath]))).toBe(1);
        expect(errorLines().some((line) => line.includes('refusing to prune'))).toBe(true);
        expect((await stat(dataDir)).isDirectory()).toBe(true);
        vi.mocked(console.log).mockClear();
        expect(await cmdDoctor(parseArgs(['doctor', '--config', configPath]))).toBe(2);
        expect(logLines().some((line) => line.includes('no-store-entry'))).toBe(true);
      } finally {
        await project.cleanup();
      }
    });
  });

  it('refuses a malformed config', async () => {
    await withEnv(async (env, configPath) => {
      await writeFile(configPath, '{ not json', 'utf8');
      const root = await writeStoreEntry(env, 'org-repo');
      const dataDir = await writeData(env, 'org-repo');
      vi.mocked(console.log).mockClear();
      vi.mocked(console.error).mockClear();

      expect(await cmdPrune(parseArgs(['prune', '--yes', '--config', configPath]))).toBe(1);
      expect(errorLines().some((line) => line.includes('refusing to prune'))).toBe(true);
      expect((await stat(root)).isDirectory()).toBe(true);
      expect((await stat(dataDir)).isDirectory()).toBe(true);

      vi.mocked(console.log).mockClear();
      expect(await cmdDoctor(parseArgs(['doctor', '--config', configPath]))).toBe(2);
      expect(logLines().some((line) => line.includes('config-missing'))).toBe(true);
    });
  });

  it('refuses when a configured name matches an entry with an unreadable manifest', async () => {
    await withEnv(async (env, configPath) => {
      await writeFile(configPath, configWith(['hello']), 'utf8');
      const root = await writeStoreEntry(env, 'org-repo', '{ not json');
      const dataDir = await writeData(env, 'org-repo');
      vi.mocked(console.log).mockClear();
      vi.mocked(console.error).mockClear();

      expect(await cmdPrune(parseArgs(['prune', '--yes', '--config', configPath]))).toBe(1);
      expect(errorLines().some((line) => line.includes('refusing to prune'))).toBe(true);
      expect((await stat(root)).isDirectory()).toBe(true);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
      vi.mocked(console.log).mockClear();
      expect(await cmdDoctor(parseArgs(['doctor', '--config', configPath]))).toBe(2);
      expect(logLines().some((line) => line.includes('no-store-entry'))).toBe(true);
    });
  });
});

describe('prune --global', () => {
  it('keeps entries the cwd project config references', async () => {
    await withEnv(async (env) => {
      const project = await tempDir('oap-cli-inspect-global-');
      try {
        const globalPath = join(configDir(env), 'opencode.json');
        await mkdir(dirname(globalPath), { recursive: true });
        await writeFile(globalPath, configWith([]), 'utf8');
        await writeFile(join(project.root, 'opencode.json'), configWith(['hello']), 'utf8');
        const root = await writeStoreEntry(env, 'org-repo');
        const dataDir = await writeData(env, 'org-repo');
        process.chdir(project.root);

        expect(await cmdPrune(parseArgs(['prune', '--yes', '--global']))).toBe(0);
        expect((await stat(root)).isDirectory()).toBe(true);
        expect((await stat(dataDir)).isDirectory()).toBe(true);
      } finally {
        await project.cleanup();
      }
    });
  });

  it('refuses when the cwd project config is unreadable', async () => {
    await withEnv(async (env) => {
      const project = await tempDir('oap-cli-inspect-global-bad-');
      try {
        const globalPath = join(configDir(env), 'opencode.json');
        await mkdir(dirname(globalPath), { recursive: true });
        await writeFile(globalPath, configWith([]), 'utf8');
        await writeFile(join(project.root, 'opencode.json'), '{ not json', 'utf8');
        const root = await writeStoreEntry(env, 'org-repo');
        const dataDir = await writeData(env, 'org-repo');
        process.chdir(project.root);
        vi.mocked(console.error).mockClear();

        expect(await cmdPrune(parseArgs(['prune', '--yes', '--global']))).toBe(1);
        expect(errorLines().some((line) => line.includes('refusing to prune'))).toBe(true);
        expect((await stat(root)).isDirectory()).toBe(true);
        expect((await stat(dataDir)).isDirectory()).toBe(true);
      } finally {
        await project.cleanup();
      }
    });
  });
});

describe('check --global path sources', () => {
  it('reports a global relative path resolved against the cwd, like doctor', async () => {
    await withEnv(async (env) => {
      const project = await tempDir('oap-cli-inspect-global-path-');
      try {
        const pluginRoot = join(project.root, 'plugin');
        await mkdir(pluginRoot, { recursive: true });
        await writeFile(join(pluginRoot, 'plugin.json'), manifestOf('hello'), 'utf8');
        const globalPath = join(configDir(env), 'opencode.json');
        await mkdir(dirname(globalPath), { recursive: true });
        await writeFile(globalPath, configWith(['./plugin']), 'utf8');
        process.chdir(project.root);
        vi.mocked(console.log).mockClear();
        vi.mocked(console.error).mockClear();

        expect(await cmdCheck(parseArgs(['check', '--global']))).toBe(0);
        expect(logLines().some((line) => line.includes('./plugin: local-path'))).toBe(true);

        // `doctor --global` resolves the same source against the same
        // location directory and finds no drift.
        vi.mocked(console.log).mockClear();
        expect(await cmdDoctor(parseArgs(['doctor', '--global']))).toBe(0);
        expect(logLines().some((line) => line.includes('no-store-entry'))).toBe(false);
      } finally {
        await project.cleanup();
      }
    });
  });
});

describe('wrong-shape store metadata', () => {
  it('list, check, and update handle a corrupted entry without throwing', async () => {
    await withEnv(async (env, configPath) => {
      await writeFile(configPath, configWith([]), 'utf8');
      const slug = 'org-repo';
      await mkdir(installedRootFor(slug, env), { recursive: true });
      await mkdir(storeDir('meta', env), { recursive: true });
      await writeFile(metaPathFor(slug, env), '{}', 'utf8');
      vi.mocked(console.log).mockClear();
      vi.mocked(console.error).mockClear();

      expect(await cmdList()).toBe(0);
      expect(logLines().some((line) => line.includes('[corrupted: missing metadata]'))).toBe(true);

      expect(await cmdCheck(parseArgs(['check', '--config', configPath]))).toBe(0);
      expect(await cmdUpdate(parseArgs(['update', '--yes', '--config', configPath]))).toBe(1);
    });
  });
});

describe('prune deletion failures', () => {
  it.skipIf(process.getuid?.() === 0)(
    'reports a failed item, deletes the others, and exits 1',
    async () => {
      await withEnv(async (env, configPath) => {
        await writeFile(configPath, configWith([]), 'utf8');
        const removable = await writeData(env, 'aaa');
        const locked = await writeData(env, 'zzz');
        await chmod(locked, 0o500);
        vi.mocked(console.log).mockClear();
        vi.mocked(console.error).mockClear();
        try {
          expect(await cmdPrune(parseArgs(['prune', '--yes', '--config', configPath]))).toBe(1);
          const errors = errorLines();
          expect(errors.some((line) => line.includes('failed to prune zzz'))).toBe(true);
          expect(
            errors.some((line) => line.includes('EACCES') || line.includes('permission')),
          ).toBe(true);
          await expect(stat(removable)).rejects.toThrow();
          expect((await stat(locked)).isDirectory()).toBe(true);
        } finally {
          await chmod(locked, 0o700).catch(() => undefined);
        }
      });
    },
  );
});
