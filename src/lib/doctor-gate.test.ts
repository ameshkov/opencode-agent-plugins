/**
 * Prune completeness gate and config-scope audits
 * (`docs/explanation/cli-lifecycle.md`).
 *
 * Every probe ends with `pruneDoctor` refusing (an empty result) and leaving
 * the store and data untouched; `doctor` still reports the finding.
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configDir, dataDirForKey, dataKeyForPath } from './data.js';
import { pruneDoctor, runDoctor } from './doctor.js';
import { installedRootFor, writeMeta } from './store.js';
import { slugOf } from './resolve.js';
import { storeEnv, tempDir } from '../../test/helpers.js';

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

/** The result of a refused prune. */
const REFUSED = { pruned: [], failures: [] };

describe('prune completeness gate', () => {
  it('refuses an unresolved (malformed) git source with data', async () => {
    const home = await tempDir('oap-gate-git-');
    try {
      const env = storeEnv(home.root);
      const configPath = join(home.root, 'opencode.json');
      await writeFile(configPath, configWith(['https://github.com/org/repo.git#bad ref']), 'utf8');
      const dataDir = await writeData(env, 'org-repo');

      const report = await runDoctor({ kind: 'custom', path: configPath }, env);
      expect(report.referencesComplete).toBe(false);
      expect(report.items.some((item) => item.kind === 'no-store-entry')).toBe(true);
      expect(await pruneDoctor(report, env)).toEqual(REFUSED);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
      expect(await readFile(join(dataDir, 'state.txt'), 'utf8')).toBe('keep me');
    } finally {
      await home.cleanup();
    }
  });

  it('refuses a project relative path that does not resolve and has data', async () => {
    const home = await tempDir('oap-gate-relative-');
    const project = await tempDir('oap-gate-relative-project-');
    try {
      const env = storeEnv(home.root);
      await writeFile(
        join(project.root, 'opencode.json'),
        configWith(['./missing-plugin']),
        'utf8',
      );
      const dataDir = await writeData(env, 'possibly-referenced');

      const report = await runDoctor({ kind: 'project', cwd: project.root }, env);
      expect(report.referencesComplete).toBe(false);
      expect(report.items.some((item) => item.kind === 'no-store-entry')).toBe(true);
      expect(await pruneDoctor(report, env)).toEqual(REFUSED);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      await home.cleanup();
      await project.cleanup();
    }
  });

  it('refuses a malformed config', async () => {
    const home = await tempDir('oap-gate-malformed-');
    try {
      const env = storeEnv(home.root);
      const configPath = join(home.root, 'opencode.json');
      await writeFile(configPath, '{ not json', 'utf8');
      const slug = 'org-repo';
      const root = await writeStoreEntry(env, slug);
      const dataDir = await writeData(env, slug);

      const report = await runDoctor({ kind: 'custom', path: configPath }, env);
      expect(report.referencesComplete).toBe(false);
      const missing = report.items.find((item) => item.kind === 'config-missing');
      expect(missing?.detail).toBe('config is not a valid JSONC document');
      expect(await pruneDoctor(report, env)).toEqual(REFUSED);
      expect((await stat(root)).isDirectory()).toBe(true);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      await home.cleanup();
    }
  });

  it('refuses when a configured name matches an entry with an unreadable manifest', async () => {
    const home = await tempDir('oap-gate-manifest-');
    try {
      const env = storeEnv(home.root);
      const configPath = join(home.root, 'opencode.json');
      await writeFile(configPath, configWith(['hello']), 'utf8');
      const slug = 'org-repo';
      const root = await writeStoreEntry(env, slug, '{ not json');
      const dataDir = await writeData(env, slug);

      const report = await runDoctor({ kind: 'custom', path: configPath }, env);
      expect(report.referencesComplete).toBe(false);
      expect(report.items.some((item) => item.kind === 'no-store-entry')).toBe(true);
      // The entry is not reported as unreferenced while references are unknown.
      expect(report.items.some((item) => item.kind === 'unreferenced-store')).toBe(false);
      expect(await pruneDoctor(report, env)).toEqual(REFUSED);
      expect((await stat(root)).isDirectory()).toBe(true);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      await home.cleanup();
    }
  });

  it('protects a configured-but-not-installed git source data dir', async () => {
    const home = await tempDir('oap-gate-config-slug-');
    try {
      const env = storeEnv(home.root);
      const configPath = join(home.root, 'opencode.json');
      const source = 'https://github.com/org/repo.git';
      await writeFile(configPath, configWith([source]), 'utf8');
      const configuredData = await writeData(env, slugOf(source));
      const orphanData = await writeData(env, 'orphan');

      const report = await runDoctor({ kind: 'custom', path: configPath }, env);
      expect(report.referencesComplete).toBe(true);
      expect(report.items.some((item) => item.kind === 'no-store-entry')).toBe(true);
      expect(report.items.some((item) => item.kind === 'orphan-data' && item.id === 'orphan')).toBe(
        true,
      );
      const result = await pruneDoctor(report, env);
      expect(result.pruned).toEqual(['orphan']);
      expect(result.failures).toEqual([]);
      expect((await stat(configuredData)).isDirectory()).toBe(true);
      await expect(stat(orphanData)).rejects.toThrow();
    } finally {
      await home.cleanup();
    }
  });
});

describe('global prune audits the cwd project config', () => {
  it('keeps entries the cwd project config references when pruning the global config', async () => {
    const home = await tempDir('oap-global-scope-');
    const project = await tempDir('oap-global-scope-project-');
    const cwd = process.cwd();
    try {
      const env = storeEnv(home.root);
      const slug = 'org-repo';
      const root = await writeStoreEntry(env, slug);
      const dataDir = await writeData(env, slug);
      const globalPath = join(configDir(env), 'opencode.json');
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, configWith([]), 'utf8');
      await writeFile(join(project.root, 'opencode.json'), configWith(['hello']), 'utf8');

      process.chdir(project.root);
      const report = await runDoctor({ kind: 'global' }, env);
      expect(report.referencesComplete).toBe(true);
      expect(report.items.some((item) => item.kind === 'unreferenced-store')).toBe(false);
      expect(await pruneDoctor(report, env)).toEqual(REFUSED);
      expect((await stat(root)).isDirectory()).toBe(true);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      process.chdir(cwd);
      await home.cleanup();
      await project.cleanup();
    }
  });

  it('refuses --global when the cwd project config is unreadable', async () => {
    const home = await tempDir('oap-global-unreadable-');
    const project = await tempDir('oap-global-unreadable-project-');
    const cwd = process.cwd();
    try {
      const env = storeEnv(home.root);
      const slug = 'org-repo';
      const root = await writeStoreEntry(env, slug);
      const dataDir = await writeData(env, slug);
      const globalPath = join(configDir(env), 'opencode.json');
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, configWith([]), 'utf8');
      await writeFile(join(project.root, 'opencode.json'), '{ not json', 'utf8');

      process.chdir(project.root);
      const report = await runDoctor({ kind: 'global' }, env);
      expect(report.referencesComplete).toBe(false);
      expect(report.items.some((item) => item.kind === 'config-missing')).toBe(true);
      expect(await pruneDoctor(report, env)).toEqual(REFUSED);
      expect((await stat(root)).isDirectory()).toBe(true);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      process.chdir(cwd);
      await home.cleanup();
      await project.cleanup();
    }
  });
});

describe('global relative path resolution', () => {
  it('resolves against the location directory, not the config directory', async () => {
    const home = await tempDir('oap-global-relative-');
    const project = await tempDir('oap-global-relative-project-');
    const cwd = process.cwd();
    try {
      const env = storeEnv(home.root);
      const pluginRoot = join(project.root, 'plugin');
      await mkdir(pluginRoot, { recursive: true });
      await writeFile(join(pluginRoot, 'plugin.json'), manifestOf('hello'), 'utf8');
      const globalPath = join(configDir(env), 'opencode.json');
      await mkdir(dirname(globalPath), { recursive: true });
      await writeFile(globalPath, configWith(['./plugin']), 'utf8');
      await writeFile(join(project.root, 'opencode.json'), configWith([]), 'utf8');
      const dataKey = dataKeyForPath(await realpath(pluginRoot), 'hello');
      const dataDir = await writeData(env, dataKey);

      process.chdir(project.root);
      // `--global`: the location directory is the process cwd.
      const globalReport = await runDoctor({ kind: 'global' }, env);
      expect(globalReport.referencesComplete).toBe(true);
      expect(globalReport.items).toEqual([]);
      expect(await pruneDoctor(globalReport, env)).toEqual(REFUSED);

      // A project scope: the global config resolves against the project cwd.
      const projectReport = await runDoctor({ kind: 'project', cwd: project.root }, env);
      expect(projectReport.referencesComplete).toBe(true);
      expect(projectReport.items).toEqual([]);
      expect((await stat(dataDir)).isDirectory()).toBe(true);
    } finally {
      process.chdir(cwd);
      await home.cleanup();
      await project.cleanup();
    }
  });
});
