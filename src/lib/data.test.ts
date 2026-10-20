import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configDir,
  configHome,
  dataDirForKey,
  dataKeyForPath,
  dataKeyForSlug,
  ensureDataDir,
  storeRoot,
} from './data.js';
import { tempDir, storeEnv } from '../../test/helpers.js';

describe('configHome / configDir', () => {
  it('prefers XDG_CONFIG_HOME', () => {
    expect(configHome({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg');
    expect(configDir({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/opencode');
  });

  it('lets OPENCODE_CONFIG_DIR replace the whole config directory', () => {
    expect(configDir({ OPENCODE_CONFIG_DIR: '/custom', XDG_CONFIG_HOME: '/xdg' })).toBe('/custom');
  });

  it('falls back to ~/.config/opencode', async () => {
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    expect(configHome({})).toBe(join(homedir(), '.config'));
    expect(configDir({})).toBe(join(homedir(), '.config', 'opencode'));
  });
});

describe('storeRoot / dataDirForKey', () => {
  it('lays out the store under <config-dir>/opencode-agent-plugins', () => {
    expect(storeRoot({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/opencode/opencode-agent-plugins');
    expect(storeRoot({ OPENCODE_CONFIG_DIR: '/custom' })).toBe('/custom/opencode-agent-plugins');
    expect(dataDirForKey('key', { XDG_CONFIG_HOME: '/xdg' })).toBe(
      '/xdg/opencode/opencode-agent-plugins/data/key',
    );
  });
});

describe('data keys', () => {
  it('uses the slug for git sources and name-hash8 for paths', () => {
    expect(dataKeyForSlug('org-repo')).toBe('org-repo');
    const key = dataKeyForPath('/pkg/root', 'hello');
    expect(key).toMatch(/^hello-[0-9a-f]{8}$/);
    expect(dataKeyForPath('/pkg/root', 'hello')).toBe(key); // stable
    expect(dataKeyForPath('/pkg/other', 'hello')).not.toBe(key);
  });
});

describe('ensureDataDir', () => {
  it('creates the PLUGIN_DATA dir and returns its resolved path', async () => {
    const home = await tempDir('oap-data-');
    try {
      const env = storeEnv(home.root);
      const key = 'test-key';
      const created = await ensureDataDir(key, env);
      expect(created).toBe(
        await realpath(join(home.root, 'opencode', 'opencode-agent-plugins', 'data', key)),
      );
      const nested = join(created, 'state');
      await mkdir(nested, { recursive: true });
      await writeFile(join(nested, 'f.txt'), 'x', 'utf8');
      expect(created).toContain(key);
    } finally {
      await home.cleanup();
    }
  });
});
