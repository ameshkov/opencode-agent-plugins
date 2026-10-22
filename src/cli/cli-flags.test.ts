/**
 * CLI flag behavior that must not depend on another test's lifecycle state:
 * reload wiring (`--no-reload`, `--no-register`) and `--dry-run` plans
 * (`docs/explanation/testing.md`).
 */

import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  gitBareFixture,
  gitCmd,
  storeEnv,
  tempDir,
  tmpPlugin,
  VALID_PLUGIN_JSON,
  writePluginTree,
  type GitBareFixture,
  type TempDir,
} from '../../test/helpers.js';
import { cmdInstall } from './install.js';
import { cmdRemove } from './remove.js';
import { cmdUpdate } from './update.js';
import { parseArgs } from './args.js';
import { dataDirForKey, storeDir } from '../lib/data.js';
import { installedRootFor, metaPathFor, readMeta, removeMeta, writeMeta } from '../lib/store.js';

/** Source of the seeded store entry used by the remove tests. */
const SEEDED_SOURCE = 'https://example.com/seeded.git';
/** Slug of the seeded store entry. */
const SEEDED_SLUG = 'example-seeded';

let store: TempDir;
let state: TempDir;
let configPath = '';
let env: Record<string, string | undefined> = {};

function argsOf(command: string, positionals: string[], flags: string[] = []) {
  return parseArgs([command, ...positionals, '--config', configPath, ...flags]);
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  store = await tempDir('oap-cli-flags-store-');
  env = storeEnv(store.root);
  process.env['XDG_CONFIG_HOME'] = env['XDG_CONFIG_HOME'];
  process.env['OPENCODE_CONFIG_DIR'] = '';
  // Keep reload discovery away from the developer's real service.json.
  state = await tempDir('oap-cli-flags-state-');
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
  const exitCode = await cmdInstall(argsOf('install', [fixture.source], ['--yes']));
  if (exitCode !== 0) {
    throw new Error(`fixture install failed with exit code ${exitCode}`);
  }
  return fixture;
}

/**
 * Deletes the store entry of a fixture and removes the fixture directories.
 *
 * @param fixture - The installed fixture.
 */
async function removeFixtureEntry(fixture: GitBareFixture): Promise<void> {
  await rm(installedRootFor(fixture.slug, env), { recursive: true, force: true });
  await removeMeta(fixture.slug, env);
  await rm(dataDirForKey(fixture.slug, env), { recursive: true, force: true });
  await fixture.cleanup();
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

/** Seeds a store entry, its data dir, and a config entry referencing it. */
async function seedRemoveEntry(): Promise<void> {
  const root = installedRootFor(SEEDED_SLUG, env);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'plugin.json'), VALID_PLUGIN_JSON, 'utf8');
  await writeMeta(
    SEEDED_SLUG,
    {
      source: SEEDED_SOURCE,
      url: SEEDED_SOURCE,
      resolvedCommit: '0'.repeat(40),
      installedAt: '2026-01-01T00:00:00.000Z',
    },
    env,
  );
  const dataDir = dataDirForKey(SEEDED_SLUG, env);
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'state.txt'), 'keep me', 'utf8');
  await writeFile(
    configPath,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugins: [{ package: 'opencode-agent-plugins', options: { plugins: [SEEDED_SOURCE] } }],
    }),
    'utf8',
  );
}

/** Returns the captured stdout lines of the current test. */
function logLines(): string[] {
  return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
}

describe('dry-run plans', () => {
  it('install --dry-run writes nothing', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const scope = await tempDir('oap-cli-flags-dry-');
    try {
      const freshPath = join(scope.root, 'opencode.json');
      const before = await readFile(configPath, 'utf8');
      vi.mocked(console.log).mockClear();
      const exitCode = await cmdInstall(
        parseArgs(['install', plugin.root, '--yes', '--dry-run', '--config', freshPath]),
      );
      expect(exitCode).toBe(0);
      // Neither the fresh config nor the shared config was written.
      await expect(stat(freshPath)).rejects.toThrow();
      expect(await readFile(configPath, 'utf8')).toBe(before);
      expect(logLines()).toContain('dry-run: nothing was written.');
    } finally {
      await plugin.cleanup();
      await scope.cleanup();
    }
  });

  it('update --dry-run prints the plan and leaves the install untouched', async () => {
    const fixture = await installedFixture('1.0.0');
    try {
      await pushVersion(fixture, '1.1.0');
      const before = await readMeta(fixture.slug, env);
      vi.mocked(console.log).mockClear();
      const exitCode = await cmdUpdate(argsOf('update', [fixture.slug], ['--yes', '--dry-run']));
      expect(exitCode).toBe(0);
      const logs = logLines();
      expect(logs.some((message) => message.includes('update-available'))).toBe(true);
      expect(logs).toContain('dry-run: nothing was written.');
      const after = await readMeta(fixture.slug, env);
      expect(after?.resolvedCommit).toBe(before?.resolvedCommit);
      expect(after?.manifestVersion).toBe('1.0.0');
      const manifest = JSON.parse(
        await readFile(join(installedRootFor(fixture.slug, env), 'plugin.json'), 'utf8'),
      ) as { version: string };
      expect(manifest.version).toBe('1.0.0');
    } finally {
      await removeFixtureEntry(fixture);
    }
  });

  it('update exits 0 when there is nothing to update on both paths', async () => {
    const fixture = await installedFixture('1.0.0');
    try {
      // Interactive path: prints the empty preview and stops.
      vi.mocked(console.log).mockClear();
      expect(await cmdUpdate(argsOf('update', [fixture.slug]))).toBe(0);
      expect(logLines()).toContain('nothing to update.');

      // `--yes` path: applies the empty status list.
      vi.mocked(console.log).mockClear();
      expect(await cmdUpdate(argsOf('update', [fixture.slug], ['--yes']))).toBe(0);
    } finally {
      await removeFixtureEntry(fixture);
    }
  });

  it('update keeps exit 1 when an attempted update fails', async () => {
    const fixture = await installedFixture('1.0.0');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await writeFile(join(fixture.work, 'plugin.json'), '{ not json', 'utf8');
      await gitCmd(['add', '-A'], fixture.work);
      await gitCmd(['commit', '-m', 'broken'], fixture.work);
      await gitCmd(['push', 'origin', 'main'], fixture.work);
      expect(await cmdUpdate(argsOf('update', [fixture.slug], ['--yes']))).toBe(1);
    } finally {
      err.mockRestore();
      await removeFixtureEntry(fixture);
    }
  });

  it('remove --dry-run prints the full plan and writes nothing', async () => {
    await seedRemoveEntry();
    const root = installedRootFor(SEEDED_SLUG, env);
    const dataDir = dataDirForKey(SEEDED_SLUG, env);
    const seededConfig = await readFile(configPath, 'utf8');
    vi.mocked(console.log).mockClear();
    const exitCode = await cmdRemove(argsOf('remove', [SEEDED_SLUG], ['--dry-run']));
    expect(exitCode).toBe(0);
    const logs = logLines().join('\n');
    expect(logs).toContain(`would remove ${SEEDED_SOURCE} (${SEEDED_SLUG})`);
    expect(logs).toContain(`would delete installed tree ${root}`);
    expect(logs).toContain(`would delete metadata ${metaPathFor(SEEDED_SLUG, env)}`);
    expect(logs).toContain(`would delete PLUGIN_DATA ${dataDir}`);
    expect(logs).toContain('dry-run: nothing was written.');
    // Nothing changed: config, tree, metadata, and data are all intact.
    expect(await readFile(configPath, 'utf8')).toBe(seededConfig);
    expect((await stat(root)).isDirectory()).toBe(true);
    expect(await readMeta(SEEDED_SLUG, env)).not.toBeNull();
    expect(await readFile(join(dataDir, 'state.txt'), 'utf8')).toBe('keep me');
  });

  it.skipIf(process.getuid?.() === 0)(
    'remove reports the restart hint when the config edit succeeds but deletion fails',
    async () => {
      await seedRemoveEntry();
      const installedParent = storeDir('installed', env);
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await chmod(installedParent, 0o500);
        vi.mocked(console.log).mockClear();
        expect(await cmdRemove(argsOf('remove', [SEEDED_SLUG], ['--yes']))).toBe(1);
        expect(logLines()).toContain('Restart OpenCode to drop its tools and skills.');
      } finally {
        await chmod(installedParent, 0o700).catch(() => undefined);
        err.mockRestore();
        await rm(installedRootFor(SEEDED_SLUG, env), { recursive: true, force: true }).catch(
          () => undefined,
        );
        await removeMeta(SEEDED_SLUG, env).catch(() => undefined);
        await rm(dataDirForKey(SEEDED_SLUG, env), { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    },
  );
});

describe('reload wiring', () => {
  it('install --no-reload prints the restart hint', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const scope = await tempDir('oap-cli-flags-no-reload-');
    try {
      const freshPath = join(scope.root, 'opencode.json');
      vi.mocked(console.log).mockClear();
      const exitCode = await cmdInstall(
        parseArgs(['install', plugin.root, '--yes', '--no-reload', '--config', freshPath]),
      );
      expect(exitCode).toBe(0);
      const logs = logLines();
      expect(logs).toContain('Restart OpenCode to use it.');
      expect(logs).not.toContain(
        'OpenCode reloaded; the change applies where this config is loaded.',
      );
    } finally {
      await plugin.cleanup();
      await scope.cleanup();
    }
  });

  it('install --no-register prints the snippet then the config hint', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const scope = await tempDir('oap-cli-flags-no-register-');
    try {
      const freshPath = join(scope.root, 'opencode.json');
      vi.mocked(console.log).mockClear();
      const exitCode = await cmdInstall(
        parseArgs(['install', plugin.root, '--yes', '--no-register', '--config', freshPath]),
      );
      expect(exitCode).toBe(0);
      // The config was not created: the user adds the printed snippet.
      await expect(stat(freshPath)).rejects.toThrow();
      const logs = logLines();
      const snippetAt = logs.findIndex((message) =>
        message.includes('Add this to your opencode config'),
      );
      const hintAt = logs.indexOf('Add the config snippet above, then restart OpenCode to use it.');
      expect(snippetAt).toBeGreaterThanOrEqual(0);
      expect(hintAt).toBeGreaterThan(snippetAt);
      expect(logs).not.toContain('Restart OpenCode to use it.');
    } finally {
      await plugin.cleanup();
      await scope.cleanup();
    }
  });

  it('update --no-reload prints the restart hint', async () => {
    const fixture = await installedFixture('1.0.0');
    try {
      await pushVersion(fixture, '1.1.0');
      vi.mocked(console.log).mockClear();
      const exitCode = await cmdUpdate(argsOf('update', [fixture.slug], ['--yes', '--no-reload']));
      expect(exitCode).toBe(0);
      const logs = logLines();
      expect(logs).toContain('Restart OpenCode to pick it up.');
      expect(logs).not.toContain(
        'OpenCode reloaded; the change applies where this config is loaded.',
      );
    } finally {
      await removeFixtureEntry(fixture);
    }
  });

  it('remove --no-reload deletes the entry and prints the restart hint', async () => {
    await seedRemoveEntry();
    const root = installedRootFor(SEEDED_SLUG, env);
    const dataDir = dataDirForKey(SEEDED_SLUG, env);
    vi.mocked(console.log).mockClear();
    const exitCode = await cmdRemove(
      argsOf('remove', [SEEDED_SLUG], ['--yes', '--keep-data', '--no-reload']),
    );
    expect(exitCode).toBe(0);
    expect(await readFile(configPath, 'utf8')).not.toContain(SEEDED_SOURCE);
    expect(await readMeta(SEEDED_SLUG, env)).toBeNull();
    // --keep-data leaves the data dir in place.
    expect((await stat(dataDir)).isDirectory()).toBe(true);
    const logs = logLines();
    expect(logs).toContain('Restart OpenCode to drop its tools and skills.');
    expect(logs).not.toContain(
      'OpenCode reloaded; the change applies where this config is loaded.',
    );
    await rm(root, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
});
