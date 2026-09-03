/**
 * `applyInstall` guard tests — a fatally-invalid plan must abort with nothing
 * changed on disk (`docs/design.md` §5.12.1).
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyInstall, prepareInstall } from './install.js';
import { storeEnv, tempDir, tmpPlugin } from '../../test/helpers.js';

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
});
