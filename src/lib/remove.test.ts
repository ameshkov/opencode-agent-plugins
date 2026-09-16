/**
 * `removePlugin` robustness (`docs/explanation/design.md` §5.12.2): a missing config
 * reports "not registered" instead of a JSONC parse error, and a failed store
 * deletion is reported as a structured failure — never a raw rejection —
 * after the config entry has already been removed.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removePlugin } from './remove.js';
import { installedRootFor, readMeta, writeMeta, type StoreMeta } from './store.js';
import { storeDir } from './data.js';
import { storeEnv, tempDir, VALID_PLUGIN_JSON } from '../../test/helpers.js';

/**
 * Seeds a store entry without going through install.
 *
 * @param env - Environment view for store-root resolution.
 * @param slug - Store slug.
 * @param source - Registered source string.
 */
async function seedEntry(
  env: Record<string, string | undefined>,
  slug: string,
  source: string,
): Promise<void> {
  const root = installedRootFor(slug, env);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'plugin.json'), VALID_PLUGIN_JSON, 'utf8');
  const meta: StoreMeta = {
    source,
    url: source,
    resolvedCommit: 'a'.repeat(40),
    manifestVersion: '1.0.0',
    installedAt: '2026-09-01T00:00:00.000Z',
  };
  await writeMeta(slug, meta, env);
}

const source = 'https://github.com/org/repo.git';
const slug = 'org-repo';

describe('removePlugin (§5.12.2)', () => {
  it('reports "not registered" for a missing config instead of a JSONC error', async () => {
    const store = await tempDir('oap-remove-');
    const env = storeEnv(store.root);
    try {
      await seedEntry(env, slug, source);
      const result = await removePlugin(slug, {
        configScope: { kind: 'custom', path: join(store.root, 'missing-opencode.json') },
        env,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('config-edit');
        expect(result.failure.message).toContain(`"${source}" is not registered`);
        expect(result.failure.message).not.toContain('not a valid JSONC document');
      }
      // The abort happened before any deletion.
      expect(await readMeta(slug, env)).not.toBeNull();
    } finally {
      await store.cleanup();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'reports leftover paths when deleting the store entry fails',
    async () => {
      const store = await tempDir('oap-remove-');
      const env = storeEnv(store.root);
      const configPath = join(store.root, 'opencode.json');
      const installedParent = storeDir('installed', env);
      try {
        await seedEntry(env, slug, source);
        await writeFile(
          configPath,
          JSON.stringify({ plugin: [['opencode-agent-plugins', { plugins: [source] }]] }),
          'utf8',
        );
        // The entry cannot be unlinked while its parent is unwritable, but
        // the config edit still succeeds first.
        await chmod(installedParent, 0o500);

        const result = await removePlugin(slug, {
          configScope: { kind: 'custom', path: configPath },
          env,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure.kind).toBe('install-fail');
          expect(result.failure.message).toContain('unregistered from the config');
          expect(result.failure.message).toContain(installedRootFor(slug, env));
        }
        // The config entry is gone; the failure describes the partial state.
        expect(await readFile(configPath, 'utf8')).not.toContain(source);
        // The later deletion steps were still attempted.
        expect(await readMeta(slug, env)).toBeNull();
      } finally {
        await chmod(installedParent, 0o700).catch(() => undefined);
        await store.cleanup();
      }
    },
  );
});
