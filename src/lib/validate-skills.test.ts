/**
 * Unreadable top-level `skills/` (`docs/explanation/failures.md`).
 *
 * `discoverSkills` never throws: an unreadable `skills/` is a fatal
 * `skills-invalid` discovery, so install and update abort without a raw
 * stack. The update test mocks `stageTree` because a git checkout cannot
 * preserve a mode-000 directory; the staged tree itself is real.
 */

import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { applyInstall, prepareInstall } from './install.js';
import { swapUpdate } from './update-swap.js';
import { discoverSkills } from './skills.js';
import { validatePluginTree } from './validate.js';
import { installedRootFor, readMeta, writeMeta } from './store.js';
import {
  skillMd,
  storeEnv,
  tempDir,
  tmpPlugin,
  VALID_PLUGIN_JSON,
  writePluginTree,
  type TempDir,
} from '../../test/helpers.js';

const stageTreeMock = vi.hoisted(() => vi.fn());
vi.mock('./clone.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./clone.js')>();
  return { ...actual, stageTree: stageTreeMock };
});

/** Makes `skills/` unreadable so `readdir` fails with EACCES/EPERM. */
async function lockSkills(root: string): Promise<void> {
  await chmod(join(root, 'skills'), 0o000);
}

/** Restores `skills/` permissions before removing the temporary tree. */
async function cleanupPlugin(plugin: TempDir): Promise<void> {
  await chmod(join(plugin.root, 'skills'), 0o700).catch(() => undefined);
  await plugin.cleanup();
}

/** Creates a plugin tree with a valid manifest and a locked `skills/` dir. */
async function lockedPlugin(): Promise<TempDir> {
  const plugin = await tmpPlugin({
    'plugin.json': VALID_PLUGIN_JSON,
    'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
  });
  await lockSkills(plugin.root);
  return plugin;
}

describe('unreadable skills directory', () => {
  it.skipIf(process.getuid?.() === 0)(
    'reports a fatal skills-invalid discovery instead of throwing',
    async () => {
      const plugin = await lockedPlugin();
      try {
        const result = await discoverSkills(plugin.root);
        expect(result.fatal).toBe(true);
        expect(result.skills).toEqual([]);
        expect(result.failures.map((failure) => failure.kind)).toEqual(['skills-invalid']);
        expect(result.failures[0]?.message).toContain('unreadable');
      } finally {
        await cleanupPlugin(plugin);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'makes install validation fatal and aborts with nothing written',
    async () => {
      const plugin = await lockedPlugin();
      const store = await tempDir('oap-skills-install-');
      const configPath = join(store.root, 'opencode.json');
      const env = storeEnv(store.root);
      try {
        const validated = await validatePluginTree(plugin.root, env);
        expect(validated.fatal).toBe(true);
        expect(validated.warnings.map((warning) => warning.kind)).toContain('skills-invalid');

        const prepared = await prepareInstall(plugin.root, process.cwd(), env);
        expect(prepared.ok).toBe(true);
        if (!prepared.ok || prepared.plan === undefined) {
          return;
        }
        expect(prepared.plan.validated.fatal).toBe(true);
        const result = await applyInstall(prepared.plan, {
          configScope: { kind: 'custom', path: configPath },
          env,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure.kind).toBe('install-fail');
        }
        // The path source is untouched and no config was created.
        expect((await stat(plugin.root)).isDirectory()).toBe(true);
        await expect(readFile(configPath, 'utf8')).rejects.toThrow();
      } finally {
        await store.cleanup();
        await cleanupPlugin(plugin);
      }
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    'makes update validation fail as corrupted and keeps the previous install',
    async () => {
      const home = await tempDir('oap-skills-update-');
      const env = storeEnv(home.root);
      const slug = 'org-repo';
      const staged = await tmpPlugin({
        'plugin.json': VALID_PLUGIN_JSON,
        'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
      });
      try {
        const installed = installedRootFor(slug, env);
        await mkdir(installed, { recursive: true });
        await writePluginTree(installed, '1.0.0');
        const meta = {
          source: 'file:///nowhere/org-repo.git',
          url: 'file:///nowhere/org-repo.git',
          resolvedCommit: 'a'.repeat(40),
          manifestVersion: '1.0.0',
          installedAt: '2026-01-01T00:00:00.000Z',
        };
        await writeMeta(slug, meta, env);
        await lockSkills(staged.root);
        stageTreeMock.mockResolvedValue({ ok: true, dir: staged.root });

        const status = await swapUpdate(slug, meta, 'b'.repeat(40), env);

        expect(status.status).toBe('corrupted');
        expect(status.detail).toContain('kept previous install');
        // The throwaway staged tree is removed even though its skills/ dir
        // was unreadable.
        await expect(stat(staged.root)).rejects.toThrow();
        const manifest = JSON.parse(await readFile(join(installed, 'plugin.json'), 'utf8')) as {
          version: string;
        };
        expect(manifest.version).toBe('1.0.0');
        expect(await readMeta(slug, env)).toMatchObject({ manifestVersion: '1.0.0' });
      } finally {
        await cleanupPlugin(staged);
        await home.cleanup();
      }
    },
  );
});
