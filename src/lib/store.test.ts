import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findStoreEntry,
  installedRootFor,
  listInstalled,
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
      const { runDoctor } = await import('./doctor.js');
      const report = await runDoctor({ kind: 'custom', path: plugin.root }, env);
      expect(report.items.some((i) => i.kind === 'orphan-data' && i.id === 'orphan')).toBe(true);
    } finally {
      await home.cleanup();
      await plugin.cleanup();
    }
  });
});
