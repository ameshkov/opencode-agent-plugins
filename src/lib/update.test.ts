import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitBareFixture,
  gitCmd,
  skillMd,
  stdioMcp,
  storeEnv,
  tempDir,
  writePluginTree,
} from '../../test/helpers.js';
import { applyUpdates, checkStoreStatuses, runCheck } from './update.js';
import { installedRootFor, readMeta, writeMeta } from './store.js';
import type { ConfigScope } from './config-file.js';
import { VALID_PLUGIN_JSON } from '../../test/helpers.js';

/**
 * `check`/`update` taxonomy contract (§6 rows 807-808): failure statuses
 * (`unreachable`, `moved-tag`) carry the matching Failure kind
 * (`check-unreachable`, `update-ref`) so the classification is exercised on
 * both surfaces, while non-failure statuses carry none.
 */
describe('update status taxonomy', () => {
  let fixture: Awaited<ReturnType<typeof gitBareFixture>>;
  let storeHome: Awaited<ReturnType<typeof tempDir>>;
  let env: Record<string, string | undefined>;
  let scope: ConfigScope;
  let slug = '';
  let work = '';

  beforeAll(async () => {
    storeHome = await tempDir('oap-update-store-');
    env = storeEnv(storeHome.root);
    scope = { kind: 'custom', path: join(storeHome.root, 'opencode.json') };

    fixture = await gitBareFixture({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
      'mcp.json': stdioMcp(),
    });
    slug = fixture.slug;
    work = fixture.work;

    const installed = installedRootFor(slug, env);
    await mkdir(join(installed, '..'), { recursive: true });
    await mkdir(installed, { recursive: true });

    // Pin the install to a tag at the initial commit.
    await gitCmd(['tag', 'v1.0.0'], work);
    await gitCmd(['push', '--tags'], work);
    const commit = (await gitCmd(['rev-parse', 'HEAD'], work)).trim();
    await writeMeta(
      slug,
      {
        source: fixture.source,
        url: fixture.source,
        ref: 'v1.0.0',
        resolvedCommit: commit,
        manifestVersion: '1.0.0',
        installedAt: new Date().toISOString(),
      },
      env,
    );
  });

  afterAll(async () => {
    await fixture.cleanup();
    await storeHome.cleanup();
  });

  it('reports an unmoved tag as up to date (pinned) without a failure (design §5.11)', async () => {
    const statuses = await checkStoreStatuses(env);
    expect(statuses[0]).toMatchObject({ slug, status: 'up-to-date' });
    expect(statuses[0].detail).toContain('pinned at');
    expect(statuses[0].failure).toBeUndefined();
  });

  it('classifies a moved tag as update-ref (§6 row 808)', async () => {
    await writePluginTree(work, '1.1.0');
    await gitCmd(['add', '-A'], work);
    await gitCmd(['commit', '-m', 'v1.1.0'], work);
    await gitCmd(['push', 'origin', 'main'], work);
    await gitCmd(['tag', '-f', 'v1.0.0'], work);
    await gitCmd(['push', '--force', '--tags'], work);

    const checked = await runCheck([slug], scope, env);
    expect(checked[0].status).toBe('moved-tag');
    // Regression: `checkEntry` routes through the same `statusFor` shape as
    // `applyUpdates`, so the recorded ref is carried (conditionally).
    expect(checked[0].ref).toBe('v1.0.0');
    expect(checked[0].failure?.kind).toBe('update-ref');
    expect(checked[0].failure?.level).toBe('warn');

    const updated = await applyUpdates([slug], scope, { env });
    expect(updated[0].status).toBe('moved-tag');
    expect(updated[0].ref).toBe('v1.0.0');
    expect(updated[0].failure?.kind).toBe('update-ref');
  });

  it('classifies an unreachable remote as check-unreachable (§6 row 807)', async () => {
    const meta = await readMeta(slug, env);
    expect(meta).not.toBeNull();
    await writeMeta(slug, { ...meta!, url: 'file:///definitely/nowhere.git' }, env);

    const checked = await runCheck([slug], scope, env);
    expect(checked[0].status).toBe('unreachable');
    expect(checked[0].ref).toBe('v1.0.0');
    expect(checked[0].failure?.kind).toBe('check-unreachable');
    expect(checked[0].failure?.level).toBe('warn');

    const updated = await applyUpdates([slug], scope, { env });
    expect(updated[0].status).toBe('unreachable');
    expect(updated[0].ref).toBe('v1.0.0');
    expect(updated[0].failure?.kind).toBe('check-unreachable');
  });
});
