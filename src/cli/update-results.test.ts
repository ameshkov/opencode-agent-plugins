/**
 * `update` result reporting: a mixed outcome reloads and exits 1, and an
 * empty status list prints the no-op message (`docs/explanation/cli-lifecycle.md`).
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  gitBareFixture,
  gitCmd,
  storeEnv,
  tempDir,
  writePluginTree,
  type GitBareFixture,
  type TempDir,
} from '../../test/helpers.js';
import { installedRootFor, readMeta, removeMeta } from '../lib/store.js';
import { parseArgs } from './args.js';
import { cmdInstall } from './install.js';
import { cmdUpdate } from './update.js';

let store: TempDir;
let state: TempDir;
let configPath = '';
let env: Record<string, string | undefined> = {};

function argsOf(positionals: string[], flags: string[] = []) {
  return parseArgs(['update', ...positionals, '--config', configPath, ...flags]);
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = await tempDir('oap-update-results-store-');
  env = storeEnv(store.root);
  process.env['XDG_CONFIG_HOME'] = env['XDG_CONFIG_HOME'];
  process.env['OPENCODE_CONFIG_DIR'] = '';
  // Keep reload discovery away from the developer's real service.json.
  state = await tempDir('oap-update-results-state-');
  process.env['XDG_STATE_HOME'] = state.root;
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
  vi.restoreAllMocks();
  await store.cleanup();
  await state.cleanup();
});

/**
 * Creates a git fixture with the standard plugin tree at `version` and
 * installs it into the temporary store.
 *
 * @param version - Manifest version of the fixture.
 * @returns The installed fixture.
 */
async function installedFixture(version: string): Promise<GitBareFixture> {
  const fixture = await gitBareFixture({ 'README.md': 'fixture\n' });
  await writePluginTree(fixture.work, version);
  await gitCmd(['add', '-A'], fixture.work);
  await gitCmd(['commit', '-m', `v${version}`], fixture.work);
  await gitCmd(['push', 'origin', 'main'], fixture.work);
  const exitCode = await cmdInstall(
    parseArgs(['install', fixture.source, '--yes', '--config', configPath]),
  );
  if (exitCode !== 0) {
    throw new Error(`fixture install failed with exit code ${exitCode}`);
  }
  return fixture;
}

/**
 * Pushes a new manifest version to a fixture's remote.
 *
 * @param fixture - The installed fixture.
 * @param version - New manifest version.
 */
async function pushVersion(fixture: GitBareFixture, version: string): Promise<void> {
  await writePluginTree(fixture.work, version);
  await gitCmd(['add', '-A'], fixture.work);
  await gitCmd(['commit', '-m', `v${version}`], fixture.work);
  await gitCmd(['push', 'origin', 'main'], fixture.work);
}

/**
 * Deletes the store entry of a fixture and removes the fixture directories.
 *
 * @param fixture - The installed fixture.
 */
async function removeFixtureEntry(fixture: GitBareFixture): Promise<void> {
  await rm(installedRootFor(fixture.slug, env), { recursive: true, force: true });
  await removeMeta(fixture.slug, env);
  await fixture.cleanup();
}

/** Returns the captured stdout lines of the current test. */
function logLines(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
}

describe('update results', () => {
  it('updates one entry, fails another, reloads, and exits 1', async () => {
    const fixture = await installedFixture('1.0.0');
    const brokenSlug = 'broken-entry';
    const brokenRoot = installedRootFor(brokenSlug, env);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mkdir(brokenRoot, { recursive: true });
      await pushVersion(fixture, '1.1.0');
      vi.mocked(console.log).mockClear();
      const exitCode = await cmdUpdate(argsOf([fixture.slug, brokenSlug], ['--yes']));
      expect(exitCode).toBe(1);
      const logs = logLines();
      expect(logs.some((line) => line.startsWith('updated hello 1.1.0'))).toBe(true);
      // reloadAfter ran (no service is running): it printed the restart hint.
      expect(logs).toContain('Restart OpenCode to pick it up.');
      expect((await readMeta(fixture.slug, env))?.manifestVersion).toBe('1.1.0');
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      await rm(brokenRoot, { recursive: true, force: true });
      await removeMeta(brokenSlug, env);
      await removeFixtureEntry(fixture);
    }
  });

  it('prints nothing to update for an empty store and rejects an unmatched name', async () => {
    const fixture = await installedFixture('1.0.0');
    try {
      // Remove the only store entry: a genuinely empty store is a no-op.
      await rm(installedRootFor(fixture.slug, env), { recursive: true, force: true });
      await removeMeta(fixture.slug, env);
      vi.mocked(console.log).mockClear();
      expect(await cmdUpdate(argsOf([], ['--yes']))).toBe(0);
      expect(logLines()).toContain('nothing to update.');

      // A name that matches no entry is an error, not a silent no-op.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        vi.mocked(console.log).mockClear();
        expect(await cmdUpdate(argsOf(['missing-name'], ['--yes']))).toBe(1);
        expect(errorSpy).toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('previews a corrupted entry as a failure and exits 1', async () => {
    const brokenSlug = 'broken-preview';
    const brokenRoot = installedRootFor(brokenSlug, env);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await mkdir(brokenRoot, { recursive: true });
      vi.mocked(console.log).mockClear();
      expect(await cmdUpdate(argsOf([brokenSlug]))).toBe(1);
      expect(errorSpy).toHaveBeenCalled();
      expect(logLines()).not.toContain('nothing to update.');
    } finally {
      errorSpy.mockRestore();
      await rm(brokenRoot, { recursive: true, force: true });
      await removeMeta(brokenSlug, env);
    }
  });
});
