/**
 * Subdir update behavior (`docs/explanation/design.md` §5.3.4, §5.12.3): an update
 * re-derives the recorded subdir, swaps only that tree, keeps the previous
 * install when the subdir disappears, and preserves the metadata `subdir`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitBareFixture,
  gitCmd,
  skillMd,
  storeEnv,
  tempDir,
  type GitBareFixture,
  type TempDir,
} from '../../test/helpers.js';
import { applyInstall, prepareInstall } from './install.js';
import { applyUpdates } from './update.js';
import { installedRootFor, readMeta } from './store.js';
import { slugOf } from './resolve.js';
import type { ConfigScope } from './config-file.js';

/** A minimal valid manifest for a named subdir package. */
function packageManifest(name: string, version: string): string {
  return JSON.stringify(
    {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name,
      version,
      description: `${name} plugin`,
    },
    undefined,
    2,
  );
}

/** Reads the installed manifest version of a slug. */
async function installedVersion(
  slug: string,
  env: Record<string, string | undefined>,
): Promise<string> {
  const text = await readFile(join(installedRootFor(slug, env), 'plugin.json'), 'utf8');
  return (JSON.parse(text) as { version?: string }).version ?? '';
}

describe('subdir updates (§5.3.4)', () => {
  let fixture: GitBareFixture;
  let storeHome: TempDir;
  let env: Record<string, string | undefined>;
  let scope: ConfigScope;
  let alphaSlug = '';
  let betaSlug = '';

  beforeAll(async () => {
    storeHome = await tempDir('oap-update-subdir-');
    env = storeEnv(storeHome.root);
    scope = { kind: 'custom', path: join(storeHome.root, 'opencode.json') };
    fixture = await gitBareFixture({
      'packages/alpha/plugin.json': packageManifest('alpha', '1.0.0'),
      'packages/alpha/skills/alpha/SKILL.md': skillMd('alpha', 'Alpha skill'),
      'packages/beta/plugin.json': packageManifest('beta', '1.0.0'),
      'packages/beta/skills/beta/SKILL.md': skillMd('beta', 'Beta skill'),
    });
    alphaSlug = slugOf(fixture.source, 'packages/alpha');
    betaSlug = slugOf(fixture.source, 'packages/beta');
    for (const subdir of ['packages/alpha', 'packages/beta']) {
      const prepared = await prepareInstall(`${fixture.source}#:${subdir}`, '/', env);
      if (!prepared.ok || prepared.plan === undefined) {
        throw new Error(`failed to prepare ${subdir}`);
      }
      const applied = await applyInstall(prepared.plan, {
        configScope: scope,
        env,
        noRegister: true,
      });
      if (!applied.ok) {
        throw new Error(`failed to install ${subdir}`);
      }
    }
  });

  afterAll(async () => {
    await fixture.cleanup();
    await storeHome.cleanup();
  });

  it('updates only the selected subdir and keeps its metadata subdir (§5.12.3)', async () => {
    const betaBefore = await readMeta(betaSlug, env);
    await writeFile(
      join(fixture.work, 'packages/alpha/plugin.json'),
      packageManifest('alpha', '1.1.0'),
      'utf8',
    );
    await gitCmd(['add', '-A'], fixture.work);
    await gitCmd(['commit', '-m', 'alpha 1.1.0'], fixture.work);
    await gitCmd(['push', 'origin', 'main'], fixture.work);

    const before = await readMeta(alphaSlug, env);
    const statuses = await applyUpdates([alphaSlug], scope, { env });
    expect(statuses[0]).toMatchObject({ slug: alphaSlug, status: 'update-available' });
    expect(statuses[0].detail).toContain('1.1.0');

    const after = await readMeta(alphaSlug, env);
    expect(after?.manifestVersion).toBe('1.1.0');
    expect(after?.subdir).toBe('packages/alpha');
    expect(after?.resolvedCommit).not.toBe(before?.resolvedCommit);
    expect(await installedVersion(alphaSlug, env)).toBe('1.1.0');

    // Beta is untouched: same commit, same version.
    const betaAfter = await readMeta(betaSlug, env);
    expect(betaAfter?.resolvedCommit).toBe(betaBefore?.resolvedCommit);
    expect(await installedVersion(betaSlug, env)).toBe('1.0.0');
  });

  it('keeps the previous install when the subdir disappears (§5.3.4)', async () => {
    await gitCmd(['rm', '-r', 'packages/alpha'], fixture.work);
    await gitCmd(['commit', '-m', 'drop alpha'], fixture.work);
    await gitCmd(['push', 'origin', 'main'], fixture.work);

    const before = await readMeta(alphaSlug, env);
    const statuses = await applyUpdates([alphaSlug], scope, { env });
    expect(statuses[0].status).toBe('corrupted');
    expect(statuses[0].detail).toContain('kept previous install');

    const after = await readMeta(alphaSlug, env);
    expect(after?.resolvedCommit).toBe(before?.resolvedCommit);
    expect(await installedVersion(alphaSlug, env)).toBe('1.1.0');
  });
});
