import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configDir, dataDirForKey, dataKeyForPath, pathDataHash } from './data.js';
import { pruneDoctor, runDoctor } from './doctor.js';
import { runCheck } from './update.js';
import { installedRootFor, writeMeta } from './store.js';
import type { ConfigScope } from './config-file.js';
import { storeEnv, tempDir, tmpPlugin } from '../../test/helpers.js';

/** A minimal valid manifest with the given name. */
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

/** A config that registers the given sources. */
function configWith(sources: string[]): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    plugins: [{ package: 'opencode-agent-plugins', options: { plugins: sources } }],
  });
}

/** Writes a store entry with a readable manifest and metadata. */
async function writeStoreEntry(
  env: Record<string, string | undefined>,
  slug: string,
  name = 'hello',
): Promise<string> {
  const root = installedRootFor(slug, env);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'plugin.json'), manifestOf(name), 'utf8');
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

describe('doctor path sources', () => {
  it('protects PLUGIN_DATA when the path source manifest is unreadable', async () => {
    const home = await tempDir('oap-doctor-manifest-');
    const plugin = await tmpPlugin({ 'plugin.json': '{ not json' });
    try {
      const env = storeEnv(home.root);
      const configPath = join(home.root, 'opencode.json');
      await writeFile(
        configPath,
        JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          plugins: [{ package: 'opencode-agent-plugins', options: { plugins: [plugin.root] } }],
        }),
        'utf8',
      );
      const root = await realpath(plugin.root);
      const dataKey = `hello-${pathDataHash(root)}`;
      const dataDir = dataDirForKey(dataKey, env);
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'state.txt'), 'keep me', 'utf8');

      const report = await runDoctor({ kind: 'custom', path: configPath }, env);
      const manifestItem = report.items.find((item) => item.kind === 'no-store-entry');
      expect(manifestItem?.detail).toContain('manifest unreadable');
      expect(manifestItem?.referenced).toBe(true);
      // The shared hash suffix protects the data dir from the orphan audit.
      expect(report.items.some((item) => item.kind === 'orphan-data')).toBe(false);

      const pruned = await pruneDoctor(report, env);
      expect(pruned.pruned).not.toContain(dataKey);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
      expect(await readFile(join(dataDir, 'state.txt'), 'utf8')).toBe('keep me');
    } finally {
      await home.cleanup();
      await plugin.cleanup();
    }
  });
});

describe('doctor config scope', () => {
  it('keeps a store entry referenced only by the global config', async () => {
    const home = await tempDir('oap-doctor-scope-');
    const project = await tempDir('oap-doctor-project-');
    try {
      const env = storeEnv(home.root);
      const slug = 'org-repo';
      const root = await writeStoreEntry(env, slug);
      const dataDir = dataDirForKey(slug, env);
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'state.txt'), 'keep me', 'utf8');

      const globalPath = join(configDir(env), 'opencode.json');
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, configWith(['hello']), 'utf8');
      await writeFile(join(project.root, 'opencode.json'), configWith([]), 'utf8');

      const report = await runDoctor({ kind: 'project', cwd: project.root }, env);
      expect(report.referencesComplete).toBe(true);
      expect(report.items.some((item) => item.kind === 'unreferenced-store')).toBe(false);
      expect(await pruneDoctor(report, env)).toEqual({ pruned: [], failures: [] });
      expect((await stat(root)).isDirectory()).toBe(true);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      await home.cleanup();
      await project.cleanup();
    }
  });

  it('reports a missing config and never treats the store as unreferenced', async () => {
    const home = await tempDir('oap-doctor-missing-');
    try {
      const env = storeEnv(home.root);
      const slug = 'org-repo';
      const root = await writeStoreEntry(env, slug);
      const dataDir = dataDirForKey(slug, env);
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'state.txt'), 'keep me', 'utf8');

      const report = await runDoctor(
        { kind: 'custom', path: join(home.root, 'missing.json') },
        env,
      );
      expect(report.referencesComplete).toBe(false);
      expect(report.items.some((item) => item.kind === 'config-missing')).toBe(true);
      expect(report.items.some((item) => item.kind === 'unreferenced-store')).toBe(false);
      expect(report.items.some((item) => item.kind === 'orphan-data')).toBe(false);

      expect(await pruneDoctor(report, env)).toEqual({ pruned: [], failures: [] });
      expect((await stat(root)).isDirectory()).toBe(true);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      await home.cleanup();
    }
  });
});

describe('doctor source resolution', () => {
  it('resolves an installed manifest name to its store entry', async () => {
    const home = await tempDir('oap-doctor-name-');
    const project = await tempDir('oap-doctor-name-project-');
    try {
      const env = storeEnv(home.root);
      const slug = 'org-repo';
      const root = await writeStoreEntry(env, slug, 'hello');
      await writeFile(join(project.root, 'opencode.json'), configWith(['hello']), 'utf8');
      const scope: ConfigScope = { kind: 'project', cwd: project.root };

      const report = await runDoctor(scope, env);
      expect(report.items).toEqual([]);
      expect(await pruneDoctor(report, env)).toEqual({ pruned: [], failures: [] });
      expect((await stat(root)).isDirectory()).toBe(true);

      // `check` must not report the installed name as a local path.
      const statuses = await runCheck(['hello'], scope, env);
      expect(statuses.some((status) => status.status === 'local-path')).toBe(false);
      expect(statuses.some((status) => status.slug === slug)).toBe(true);
    } finally {
      await home.cleanup();
      await project.cleanup();
    }
  });

  it('resolves a relative path against the config directory, not the cwd', async () => {
    const home = await tempDir('oap-doctor-relative-');
    const project = await tempDir('oap-doctor-relative-project-');
    const cwd = process.cwd();
    try {
      const pluginRoot = join(project.root, 'plugin');
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(pluginRoot, 'plugin.json'), manifestOf('hello'), 'utf8');
      await writeFile(join(project.root, 'opencode.json'), configWith(['./plugin']), 'utf8');
      const env = storeEnv(home.root);
      const realRoot = await realpath(pluginRoot);
      const dataKey = dataKeyForPath(realRoot, 'hello');
      const dataDir = dataDirForKey(dataKey, env);
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'state.txt'), 'keep me', 'utf8');

      // Reproduce the reported case: doctor runs from another directory.
      process.chdir(home.root);
      const scope: ConfigScope = { kind: 'project', cwd: project.root };
      const report = await runDoctor(scope, env);
      expect(report.items.some((item) => item.kind === 'no-store-entry')).toBe(false);
      expect(report.items.some((item) => item.kind === 'orphan-data')).toBe(false);
      expect(await pruneDoctor(report, env)).toEqual({ pruned: [], failures: [] });
      expect((await stat(dataDir)).isDirectory()).toBe(true);

      const statuses = await runCheck([], scope, env);
      const local = statuses.filter((status) => status.status === 'local-path');
      expect(local).toHaveLength(1);
      expect(local[0]?.source).toBe('./plugin');
    } finally {
      process.chdir(cwd);
      await home.cleanup();
      await project.cleanup();
    }
  });

  it('does not report orphan data when a global relative path does not resolve', async () => {
    const home = await tempDir('oap-doctor-global-relative-');
    const project = await tempDir('oap-doctor-global-project-');
    try {
      const env = storeEnv(home.root);
      const globalPath = join(configDir(env), 'opencode.json');
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, configWith(['./missing-plugin']), 'utf8');
      await writeFile(join(project.root, 'opencode.json'), configWith([]), 'utf8');
      const dataDir = dataDirForKey('possibly-referenced', env);
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, 'state.txt'), 'keep me', 'utf8');

      const report = await runDoctor({ kind: 'project', cwd: project.root }, env);
      expect(report.items.some((item) => item.kind === 'no-store-entry')).toBe(true);
      expect(report.items.some((item) => item.kind === 'orphan-data')).toBe(false);
      expect(await pruneDoctor(report, env)).toEqual({ pruned: [], failures: [] });
      expect((await stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      await home.cleanup();
      await project.cleanup();
    }
  });
});
