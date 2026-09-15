/**
 * `applyInstall` guard tests — a fatally-invalid plan must abort with nothing
 * changed on disk (`docs/design.md` §5.12.1).
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInstall, prepareInstall } from './install.js';
import { installedRootFor, readMeta } from './store.js';
import { slugOf } from './resolve.js';
import {
  gitBareFixture,
  skillMd,
  storeEnv,
  tempDir,
  tmpPlugin,
  VALID_PLUGIN_JSON,
} from '../../test/helpers.js';

/** A minimal valid manifest for a named subdir package. */
function packageManifest(name: string): string {
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

describe('applyInstall', () => {
  it('refuses a fatally-invalid plan with nothing changed on disk (§5.12.1)', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': '{ not json' });
    const store = await tempDir('oap-lib-install-');
    const configPath = join(store.root, 'opencode.json');
    const env = storeEnv(store.root);
    try {
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
      // No config file was created and the source dir is untouched.
      await expect(readFile(configPath, 'utf8')).rejects.toBeInstanceOf(Error);
      expect((await stat(plugin.root)).isDirectory()).toBe(true);
    } finally {
      await plugin.cleanup();
      await store.cleanup();
    }
  });

  it('--no-register skips the config edit and reports it in the message (§5.11)', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    const store = await tempDir('oap-lib-install-');
    const configPath = join(store.root, 'opencode.json');
    const env = storeEnv(store.root);
    try {
      const prepared = await prepareInstall(plugin.root, process.cwd(), env);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok || prepared.plan === undefined) {
        return;
      }
      const result = await applyInstall(prepared.plan, {
        configScope: { kind: 'custom', path: configPath },
        env,
        noRegister: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.message).toContain('not registered');
        expect(result.message).toContain('validated');
      }
      // No config file was created — registration was skipped.
      await expect(readFile(configPath, 'utf8')).rejects.toBeInstanceOf(Error);
    } finally {
      await plugin.cleanup();
      await store.cleanup();
    }
  });

  it('rolls the store entry back when the config edit fails (§5.12.1)', async () => {
    const fixture = await gitBareFixture({ 'plugin.json': VALID_PLUGIN_JSON });
    const store = await tempDir('oap-lib-install-');
    // A config path whose parent is a file makes the config write fail
    // (ENOTDIR) after the tree has already moved into the store.
    await writeFile(join(store.root, 'blocker'), 'not a directory', 'utf8');
    const configPath = join(store.root, 'blocker', 'opencode.json');
    const env = storeEnv(store.root);
    try {
      const prepared = await prepareInstall(fixture.source, process.cwd(), env);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok || prepared.plan === undefined) return;

      const result = await applyInstall(prepared.plan, {
        configScope: { kind: 'custom', path: configPath },
        env,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('config-edit');
      }
      // Nothing half-applied: the store entry and its metadata were removed.
      expect(fixture.slug).toBe(slugOf(fixture.source));
      expect(await stat(installedRootFor(fixture.slug, env)).catch(() => null)).toBeNull();
      expect(await readMeta(fixture.slug, env)).toBeNull();
    } finally {
      await fixture.cleanup();
      await store.cleanup();
    }
  });

  it('exports only the selected subdir and records it in metadata (§5.3.4)', async () => {
    const fixture = await gitBareFixture({
      'plugin.json': VALID_PLUGIN_JSON,
      'packages/alpha/plugin.json': packageManifest('alpha'),
      'packages/alpha/skills/alpha/SKILL.md': skillMd('alpha', 'Alpha skill'),
    });
    const store = await tempDir('oap-lib-install-');
    const configPath = join(store.root, 'opencode.json');
    const env = storeEnv(store.root);
    try {
      const source = `${fixture.source}#:packages/alpha`;
      const slug = slugOf(fixture.source, 'packages/alpha');
      const prepared = await prepareInstall(source, process.cwd(), env);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok || prepared.plan === undefined) return;
      const stagingDir = prepared.plan.stagingDir;
      expect(prepared.plan.source?.subdir).toBe('packages/alpha');
      const result = await applyInstall(prepared.plan, {
        configScope: { kind: 'custom', path: configPath },
        env,
        noRegister: true,
      });
      expect(result.ok).toBe(true);

      const root = installedRootFor(slug, env);
      // Only the subdir was exported: the repository-root manifest is not here.
      expect(await readFile(join(root, 'plugin.json'), 'utf8')).toContain('"alpha"');
      expect(await stat(join(root, 'skills/alpha/SKILL.md')).catch(() => null)).not.toBeNull();
      const meta = await readMeta(slug, env);
      expect(meta?.subdir).toBe('packages/alpha');
      expect(meta?.source).toBe(source);
      // The staging clone (and its sibling files) is cleaned up on success.
      expect(stagingDir).toBeDefined();
      if (stagingDir !== undefined) {
        expect(await stat(stagingDir).catch(() => null)).toBeNull();
      }
    } finally {
      await fixture.cleanup();
      await store.cleanup();
    }
  });

  it('installs skill resource files alongside SKILL.md (§5.6)', async () => {
    const fixture = await gitBareFixture({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
      'skills/hello/references/notes.md': '# Notes\n\nReferenced by the skill.\n',
    });
    const store = await tempDir('oap-lib-install-');
    const configPath = join(store.root, 'opencode.json');
    const env = storeEnv(store.root);
    try {
      const prepared = await prepareInstall(fixture.source, process.cwd(), env);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok || prepared.plan === undefined) return;
      // Resource files are neither skills nor warnings: only `hello` registers.
      expect(prepared.plan.validated.skills).toEqual(['hello']);
      expect(prepared.plan.validated.warnings).toEqual([]);

      const result = await applyInstall(prepared.plan, {
        configScope: { kind: 'custom', path: configPath },
        env,
        noRegister: true,
      });
      expect(result.ok).toBe(true);

      // The export is the whole tree: the resource file reaches the store too.
      const root = installedRootFor(fixture.slug, env);
      expect(await readFile(join(root, 'skills/hello/references/notes.md'), 'utf8')).toBe(
        '# Notes\n\nReferenced by the skill.\n',
      );
      expect(await stat(join(root, 'skills/hello/SKILL.md')).catch(() => null)).not.toBeNull();
    } finally {
      await fixture.cleanup();
      await store.cleanup();
    }
  });

  it('cleans the staging clone when the subdir fails validation (§5.12.1)', async () => {
    const fixture = await gitBareFixture({
      'packages/alpha/plugin.json': '{ not json',
    });
    const store = await tempDir('oap-lib-install-');
    const configPath = join(store.root, 'opencode.json');
    const env = storeEnv(store.root);
    try {
      const prepared = await prepareInstall(
        `${fixture.source}#:packages/alpha`,
        process.cwd(),
        env,
      );
      expect(prepared.ok).toBe(true);
      if (!prepared.ok || prepared.plan === undefined) return;
      expect(prepared.plan.validated.fatal).toBe(true);
      const stagingDir = prepared.plan.stagingDir;
      const result = await applyInstall(prepared.plan, {
        configScope: { kind: 'custom', path: configPath },
        env,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('install-fail');
      }
      expect(stagingDir).toBeDefined();
      if (stagingDir !== undefined) {
        expect(await stat(stagingDir).catch(() => null)).toBeNull();
      }
    } finally {
      await fixture.cleanup();
      await store.cleanup();
    }
  });

  it('fails without writing when the subdir does not exist (§5.3.4)', async () => {
    const fixture = await gitBareFixture({ 'plugin.json': VALID_PLUGIN_JSON });
    const store = await tempDir('oap-lib-install-');
    const env = storeEnv(store.root);
    try {
      const prepared = await prepareInstall(
        `${fixture.source}#:packages/missing`,
        process.cwd(),
        env,
      );
      expect(prepared.ok).toBe(false);
      if (!prepared.ok) {
        expect(prepared.failure.kind).toBe('install-fail');
        expect(prepared.failure.message).toContain('not found');
      }
      expect(await readMeta(slugOf(fixture.source, 'packages/missing'), env)).toBeNull();
    } finally {
      await fixture.cleanup();
      await store.cleanup();
    }
  });
});
