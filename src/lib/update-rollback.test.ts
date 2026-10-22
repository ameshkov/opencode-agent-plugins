import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  gitBareFixture,
  gitCmd,
  skillMd,
  stdioMcp,
  storeEnv,
  tempDir,
  VALID_PLUGIN_JSON,
  writePluginTree,
} from '../../test/helpers.js';
import { storeDir } from './data.js';
import { applyUpdates } from './update.js';
import { installedRootFor, readMeta, writeMeta } from './store.js';
import type { ConfigScope } from './config-file.js';

describe('update metadata failure', () => {
  it.skipIf(process.getuid?.() === 0)(
    'restores the old tree when the metadata write fails',
    async () => {
      const home = await tempDir('oap-update-meta-');
      const fixture = await gitBareFixture({
        'plugin.json': VALID_PLUGIN_JSON,
        'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
        'mcp.json': stdioMcp(),
      });
      const env = storeEnv(home.root);
      const scope: ConfigScope = { kind: 'custom', path: join(home.root, 'opencode.json') };
      try {
        const installed = installedRootFor(fixture.slug, env);
        await mkdir(installed, { recursive: true });
        await writePluginTree(installed, '1.0.0');
        const commit = (await gitCmd(['rev-parse', 'HEAD'], fixture.work)).trim();
        await writeMeta(
          fixture.slug,
          {
            source: fixture.source,
            url: fixture.source,
            resolvedCommit: commit,
            manifestVersion: '1.0.0',
            installedAt: new Date().toISOString(),
          },
          env,
        );
        await writePluginTree(fixture.work, '1.1.0');
        await gitCmd(['add', '-A'], fixture.work);
        await gitCmd(['commit', '-m', 'v1.1.0'], fixture.work);
        await gitCmd(['push', 'origin', 'main'], fixture.work);

        // The swap succeeds, but the metadata write cannot: the old tree must
        // come back and the failure must be reported, not thrown.
        await chmod(storeDir('meta', env), 0o500);
        const statuses = await applyUpdates([fixture.slug], scope, { env });

        expect(statuses[0]).toMatchObject({ slug: fixture.slug, status: 'corrupted' });
        expect(statuses[0].detail).toMatch(/permission denied/i);
        const manifest = JSON.parse(await readFile(join(installed, 'plugin.json'), 'utf8')) as {
          version: string;
        };
        expect(manifest.version).toBe('1.0.0');
        expect(await readMeta(fixture.slug, env)).toMatchObject({ manifestVersion: '1.0.0' });
      } finally {
        await chmod(storeDir('meta', env), 0o700).catch(() => undefined);
        await fixture.cleanup();
        await home.cleanup();
      }
    },
  );
});

describe('update with a stale swap leftover', () => {
  it('removes a stale .old tree and applies the update', async () => {
    const home = await tempDir('oap-update-stale-');
    const fixture = await gitBareFixture({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
    });
    const env = storeEnv(home.root);
    const scope: ConfigScope = { kind: 'custom', path: join(home.root, 'opencode.json') };
    try {
      const installed = installedRootFor(fixture.slug, env);
      await mkdir(installed, { recursive: true });
      await writePluginTree(installed, '1.0.0');
      const commit = (await gitCmd(['rev-parse', 'HEAD'], fixture.work)).trim();
      await writeMeta(
        fixture.slug,
        {
          source: fixture.source,
          url: fixture.source,
          resolvedCommit: commit,
          manifestVersion: '1.0.0',
          installedAt: new Date().toISOString(),
        },
        env,
      );
      // A crash left an older tree in `.old-<slug>`.
      const old = join(installed, '..', `.old-${fixture.slug}`);
      await mkdir(old, { recursive: true });
      await writePluginTree(old, '0.9.0');
      await writePluginTree(fixture.work, '1.1.0');
      await gitCmd(['add', '-A'], fixture.work);
      await gitCmd(['commit', '-m', 'v1.1.0'], fixture.work);
      await gitCmd(['push', 'origin', 'main'], fixture.work);

      const statuses = await applyUpdates([fixture.slug], scope, { env });

      expect(statuses[0]).toMatchObject({ slug: fixture.slug, status: 'update-available' });
      const manifest = JSON.parse(await readFile(join(installed, 'plugin.json'), 'utf8')) as {
        version: string;
      };
      expect(manifest.version).toBe('1.1.0');
      expect(await readMeta(fixture.slug, env)).toMatchObject({ manifestVersion: '1.1.0' });
      expect(await stat(old).catch(() => null)).toBeNull();
    } finally {
      await fixture.cleanup();
      await home.cleanup();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'keeps the live tree and metadata when the update fails after a stale .old',
    async () => {
      const home = await tempDir('oap-update-stale-fail-');
      const fixture = await gitBareFixture({
        'plugin.json': VALID_PLUGIN_JSON,
        'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
      });
      const env = storeEnv(home.root);
      const scope: ConfigScope = { kind: 'custom', path: join(home.root, 'opencode.json') };
      try {
        const installed = installedRootFor(fixture.slug, env);
        await mkdir(installed, { recursive: true });
        await writePluginTree(installed, '1.0.0');
        const commit = (await gitCmd(['rev-parse', 'HEAD'], fixture.work)).trim();
        await writeMeta(
          fixture.slug,
          {
            source: fixture.source,
            url: fixture.source,
            resolvedCommit: commit,
            manifestVersion: '1.0.0',
            installedAt: new Date().toISOString(),
          },
          env,
        );
        const old = join(installed, '..', `.old-${fixture.slug}`);
        await mkdir(old, { recursive: true });
        await writePluginTree(old, '0.9.0');
        await writePluginTree(fixture.work, '1.1.0');
        await gitCmd(['add', '-A'], fixture.work);
        await gitCmd(['commit', '-m', 'v1.1.0'], fixture.work);
        await gitCmd(['push', 'origin', 'main'], fixture.work);

        // The metadata write fails after the swap. The rollback must restore
        // the live 1.0.0 tree, never the stale 0.9.0 leftover.
        await chmod(storeDir('meta', env), 0o500);
        const statuses = await applyUpdates([fixture.slug], scope, { env });

        expect(statuses[0]).toMatchObject({ slug: fixture.slug, status: 'corrupted' });
        const manifest = JSON.parse(await readFile(join(installed, 'plugin.json'), 'utf8')) as {
          version: string;
        };
        expect(manifest.version).toBe('1.0.0');
        expect(await readMeta(fixture.slug, env)).toMatchObject({ manifestVersion: '1.0.0' });
        expect(await stat(old).catch(() => null)).toBeNull();
      } finally {
        await chmod(storeDir('meta', env), 0o700).catch(() => undefined);
        await fixture.cleanup();
        await home.cleanup();
      }
    },
  );
});
