import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findStoreEntry,
  installedRootFor,
  listInstalled,
  metaPathFor,
  readMeta,
  writeMeta,
  type StoreMeta,
} from './store.js';
import { storeDir } from './data.js';
import { tempDir, storeEnv, tmpPlugin, VALID_PLUGIN_JSON } from '../../test/helpers.js';

const META: StoreMeta = {
  source: 'git+https://github.com/org/hello.git#v1.0.0',
  url: 'https://github.com/org/hello.git',
  ref: 'v1.0.0',
  resolvedCommit: 'a'.repeat(40),
  manifestVersion: '1.0.0',
  installedAt: '2026-09-01T00:00:00.000Z',
};

describe('store metadata', () => {
  it('round-trips meta and lists installed entries', async () => {
    const home = await tempDir('oap-store-');
    try {
      const env = storeEnv(home.root);
      const root = installedRootFor('org-hello', env);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'plugin.json'), VALID_PLUGIN_JSON, 'utf8');
      await writeMeta('org-hello', META, env);

      expect(await readMeta('org-hello', env)).toEqual(META);
      const entries = await listInstalled(env);
      expect(entries.map((e) => e.slug)).toEqual(['org-hello']);
      expect(entries[0]!.meta).toEqual(META);
    } finally {
      await home.cleanup();
    }
  });

  it('returns null meta for a missing file', async () => {
    const home = await tempDir('oap-store-');
    try {
      expect(await readMeta('nope', storeEnv(home.root))).toBeNull();
    } finally {
      await home.cleanup();
    }
  });

  it('round-trips an optional subdir field (sources.md)', async () => {
    const home = await tempDir('oap-store-');
    try {
      const env = storeEnv(home.root);
      const slug = 'org-mono-packages-alpha';
      const root = installedRootFor(slug, env);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'plugin.json'), VALID_PLUGIN_JSON, 'utf8');
      const meta: StoreMeta = {
        ...META,
        source: `${META.url}#:packages/alpha`,
        subdir: 'packages/alpha',
      };
      await writeMeta(slug, meta, env);
      expect(await readMeta(slug, env)).toEqual(meta);
      const listed = (await listInstalled(env)).find((entry) => entry.slug === slug);
      expect(listed?.meta?.subdir).toBe('packages/alpha');
    } finally {
      await home.cleanup();
    }
  });

  it('ignores .old-* swap leftovers when listing', async () => {
    const home = await tempDir('oap-store-');
    try {
      const env = storeEnv(home.root);
      const root = installedRootFor('org-hello', env);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'plugin.json'), VALID_PLUGIN_JSON, 'utf8');
      await writeMeta('org-hello', META, env);
      // A stray swap leftover (crashed update, cli-lifecycle.md) must not look like
      // a corrupted store entry to listInstalled/doctor.
      await mkdir(join(storeDir('installed', env), '.old-org-hello'), { recursive: true });

      expect((await listInstalled(env)).map((e) => e.slug)).toEqual(['org-hello']);
    } finally {
      await home.cleanup();
    }
  });
});

describe('store metadata shape', () => {
  it.each([
    ['an empty object', '{}'],
    ['an array', '[]'],
    [
      'a missing resolvedCommit',
      JSON.stringify({
        source: 'https://github.com/org/hello.git',
        url: 'https://github.com/org/hello.git',
        installedAt: '2026-09-01T00:00:00.000Z',
      }),
    ],
    [
      'empty required fields',
      JSON.stringify({ source: '', url: '', resolvedCommit: '', installedAt: '' }),
    ],
  ])('treats %s as corrupted metadata', async (_label, text) => {
    const home = await tempDir('oap-store-shape-');
    try {
      const env = storeEnv(home.root);
      const slug = 'org-hello';
      await mkdir(installedRootFor(slug, env), { recursive: true });
      await mkdir(storeDir('meta', env), { recursive: true });
      await writeFile(metaPathFor(slug, env), text, 'utf8');

      expect(await readMeta(slug, env)).toBeNull();
      const listed = (await listInstalled(env)).find((entry) => entry.slug === slug);
      expect(listed?.meta).toBeNull();
    } finally {
      await home.cleanup();
    }
  });
});

describe('findStoreEntry', () => {
  it('matches by slug first, then manifest name', async () => {
    const home = await tempDir('oap-store-');
    try {
      const env = storeEnv(home.root);
      const root = installedRootFor('org-hello', env);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'plugin.json'), VALID_PLUGIN_JSON, 'utf8');
      await writeMeta('org-hello', META, env);

      expect((await findStoreEntry('org-hello', env)).map((e) => e.slug)).toEqual(['org-hello']);
      expect((await findStoreEntry('hello', env)).map((e) => e.slug)).toEqual(['org-hello']);
      expect(await findStoreEntry('missing', env)).toEqual([]);
    } finally {
      await home.cleanup();
    }
  });

  it('returns several entries when names are ambiguous', async () => {
    const home = await tempDir('oap-store-');
    try {
      const env = storeEnv(home.root);
      for (const slug of ['org-one', 'org-two']) {
        const root = installedRootFor(slug, env);
        await mkdir(root, { recursive: true });
        await writeFile(join(root, 'plugin.json'), VALID_PLUGIN_JSON, 'utf8');
        await writeMeta(
          slug,
          { ...META, source: slug, url: `https://github.com/org/${slug}.git` },
          env,
        );
      }
      const entries = await findStoreEntry('hello', env);
      expect(entries.length).toBe(2);
    } finally {
      await home.cleanup();
    }
  });
});

describe('doctor', () => {
  it('reports no-store-entry and orphaned data dirs', async () => {
    const home = await tempDir('oap-doctor-');
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    try {
      const env = storeEnv(home.root);
      // Data dir that no plugin references.
      await mkdir(storeDir('data', env) + '/orphan', { recursive: true });
      const configPath = join(plugin.root, 'opencode.json');
      await writeFile(configPath, '{}', 'utf8');
      const { runDoctor } = await import('./doctor.js');
      const report = await runDoctor({ kind: 'custom', path: configPath }, env);
      expect(report.items.some((i) => i.kind === 'orphan-data' && i.id === 'orphan')).toBe(true);
    } finally {
      await home.cleanup();
      await plugin.cleanup();
    }
  });

  it('keeps a store entry referenced through a single-string source (cli-lifecycle.md)', async () => {
    const home = await tempDir('oap-doctor-');
    try {
      const env = storeEnv(home.root);
      const root = installedRootFor('org-repo', env);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'plugin.json'), VALID_PLUGIN_JSON, 'utf8');
      const meta: StoreMeta = {
        source: 'https://github.com/org/repo.git',
        url: 'https://github.com/org/repo.git',
        resolvedCommit: 'a'.repeat(40),
        manifestVersion: '1.0.0',
        installedAt: '2026-09-01T00:00:00.000Z',
      };
      await writeMeta('org-repo', meta, env);
      const configPath = join(home.root, 'opencode.json');
      await writeFile(
        configPath,
        `{
          "plugins": [
            {
              "package": "opencode-agent-plugins",
              "options": { "plugins": "https://github.com/org/repo.git" }
            }
          ]
        }`,
        'utf8',
      );
      const { runDoctor } = await import('./doctor.js');
      const report = await runDoctor({ kind: 'custom', path: configPath }, env);
      // The string-form reference must protect the store entry from prune.
      expect(report.items.some((item) => item.kind === 'unreferenced-store')).toBe(false);
      expect(report.items.some((item) => item.kind === 'no-store-entry')).toBe(false);
    } finally {
      await home.cleanup();
    }
  });
});
