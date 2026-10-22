import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  configPreferenceNote,
  ConfigEditError,
  readConfigText,
  resolveConfigFile,
  saveConfig,
} from './config-file.js';
import { storeDir } from './data.js';
import { storeEnv, tempDir } from '../../test/helpers.js';

describe('resolveConfigFile', () => {
  it('prefers opencode.jsonc when both exist in the project scope (cli-lifecycle.md)', async () => {
    const dir = await tempDir('oap-cfg-scope-');
    try {
      await writeFile(join(dir.root, 'opencode.json'), '{}', 'utf8');
      await writeFile(join(dir.root, 'opencode.jsonc'), '{}', 'utf8');
      const resolved = await resolveConfigFile({ kind: 'project', cwd: dir.root });
      expect(resolved.path).toBe(join(dir.root, 'opencode.jsonc'));
      expect(resolved.jsoncWins).toBe(true);
      expect(configPreferenceNote(resolved)).toContain('opencode.jsonc wins over opencode.json');
    } finally {
      await dir.cleanup();
    }
  });

  it('uses opencode.jsonc when it is the only config file', async () => {
    const dir = await tempDir('oap-cfg-scope-');
    try {
      await writeFile(join(dir.root, 'opencode.jsonc'), '{}', 'utf8');
      const resolved = await resolveConfigFile({ kind: 'project', cwd: dir.root });
      expect(resolved.path).toBe(join(dir.root, 'opencode.jsonc'));
      expect(resolved.jsoncWins).toBe(false);
      expect(configPreferenceNote(resolved)).toBeNull();
    } finally {
      await dir.cleanup();
    }
  });

  it('falls back to opencode.json when no config file exists', async () => {
    const dir = await tempDir('oap-cfg-scope-');
    try {
      const resolved = await resolveConfigFile({ kind: 'project', cwd: dir.root });
      expect(resolved.path).toBe(join(dir.root, 'opencode.json'));
      expect(resolved.jsoncWins).toBe(false);
      expect(configPreferenceNote(resolved)).toBeNull();
    } finally {
      await dir.cleanup();
    }
  });

  it('prefers opencode.jsonc in the global scope too (cli-lifecycle.md)', async () => {
    const home = await tempDir('oap-cfg-home-');
    try {
      const globalDir = join(home.root, 'opencode');
      await mkdir(globalDir, { recursive: true });
      await writeFile(join(globalDir, 'opencode.json'), '{}', 'utf8');
      await writeFile(join(globalDir, 'opencode.jsonc'), '{}', 'utf8');
      const resolved = await resolveConfigFile({ kind: 'global' }, storeEnv(home.root));
      expect(resolved.path).toBe(join(globalDir, 'opencode.jsonc'));
      expect(resolved.jsoncWins).toBe(true);
    } finally {
      await home.cleanup();
    }
  });

  it('uses OPENCODE_CONFIG_DIR for the global scope when set', async () => {
    const home = await tempDir('oap-cfg-home-');
    try {
      const customDir = join(home.root, 'custom-opencode');
      await mkdir(customDir, { recursive: true });
      await writeFile(join(customDir, 'opencode.json'), '{}', 'utf8');
      const resolved = await resolveConfigFile(
        { kind: 'global' },
        { OPENCODE_CONFIG_DIR: customDir },
      );
      expect(resolved.path).toBe(join(customDir, 'opencode.json'));
    } finally {
      await home.cleanup();
    }
  });

  it('returns a custom path verbatim', async () => {
    const resolved = await resolveConfigFile({ kind: 'custom', path: '/tmp/opencode.json' });
    expect(resolved.path).toBe('/tmp/opencode.json');
    expect(resolved.jsoncWins).toBe(false);
  });
});

describe('saveConfig', () => {
  it('creates the config file and its parent directory when missing', async () => {
    const home = await tempDir('oap-cfg-home-');
    const store = await tempDir('oap-cfg-store-');
    try {
      const path = join(home.root, 'nested', 'opencode.json');
      const saved = await saveConfig(path, '{"plugins": []}', storeEnv(store.root));
      expect(saved.backupPath).toBeNull();
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ plugins: [] });
    } finally {
      await home.cleanup();
      await store.cleanup();
    }
  });

  it('backs up the previous content with a timestamped name', async () => {
    const home = await tempDir('oap-cfg-home-');
    const store = await tempDir('oap-cfg-store-');
    try {
      const path = join(home.root, 'opencode.json');
      await writeFile(path, '{"theme":"dark"}', 'utf8');
      const saved = await saveConfig(
        path,
        '{"plugins": []}',
        storeEnv(store.root),
        '{"theme":"dark"}',
      );
      expect(saved.backupPath).not.toBeNull();
      expect(await readFile(saved.backupPath!, 'utf8')).toBe('{"theme":"dark"}');
    } finally {
      await home.cleanup();
      await store.cleanup();
    }
  });

  it('aborts when the config changed since the caller read it', async () => {
    const home = await tempDir('oap-cfg-home-');
    const store = await tempDir('oap-cfg-store-');
    try {
      const path = join(home.root, 'opencode.json');
      await writeFile(path, '{"a":1}', 'utf8');
      await expect(
        saveConfig(path, '{"plugins": []}', storeEnv(store.root), '{"a":2}'),
      ).rejects.toThrow(ConfigEditError);
      // Nothing written: the on-disk content is untouched.
      expect(await readFile(path, 'utf8')).toBe('{"a":1}');
    } finally {
      await home.cleanup();
      await store.cleanup();
    }
  });

  it('refuses to write a corrupt result instead of corrupting the config', async () => {
    const home = await tempDir('oap-cfg-home-');
    const store = await tempDir('oap-cfg-store-');
    try {
      const path = join(home.root, 'opencode.json');
      await writeFile(path, '{"plugins": ["other"]}', 'utf8');
      // A stray `]` from a broken edit must abort the write.
      await expect(
        saveConfig(path, '{"plugins": ["other"}]}', storeEnv(store.root)),
      ).rejects.toThrow(ConfigEditError);
      expect(await readFile(path, 'utf8')).toBe('{"plugins": ["other"]}');
    } finally {
      await home.cleanup();
      await store.cleanup();
    }
  });

  it('writes a result with a trailing comma (OpenCode accepts it)', async () => {
    const home = await tempDir('oap-cfg-home-');
    const store = await tempDir('oap-cfg-store-');
    try {
      const path = join(home.root, 'opencode.json');
      const saved = await saveConfig(path, '{"plugins": ["a",],}', storeEnv(store.root));
      expect(saved.backupPath).toBeNull();
      expect(await readFile(path, 'utf8')).toBe('{"plugins": ["a",],}');
    } finally {
      await home.cleanup();
      await store.cleanup();
    }
  });

  it('aborts when an expected-missing config appeared meanwhile', async () => {
    const home = await tempDir('oap-cfg-home-');
    const store = await tempDir('oap-cfg-store-');
    try {
      const path = join(home.root, 'opencode.json');
      await writeFile(path, '{"a":1}', 'utf8');
      await expect(saveConfig(path, '{"plugins": []}', storeEnv(store.root), null)).rejects.toThrow(
        ConfigEditError,
      );
    } finally {
      await home.cleanup();
      await store.cleanup();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses to overwrite an existing unreadable config without a backup',
    async () => {
      const home = await tempDir('oap-cfg-home-');
      const store = await tempDir('oap-cfg-store-');
      const env = storeEnv(store.root);
      const path = join(home.root, 'opencode.json');
      const before = '{"theme":"dark"}';
      try {
        await writeFile(path, before, 'utf8');
        await chmod(path, 0o200);
        try {
          await expect(saveConfig(path, '{"plugins": []}', env)).rejects.toThrow(
            /config exists but could not be read/,
          );
        } finally {
          await chmod(path, 0o600);
        }
        // Byte-identical content, no backup, no partial write.
        expect(await readFile(path, 'utf8')).toBe(before);
        expect(await readdir(storeDir('backups', env)).catch(() => [])).toEqual([]);
      } finally {
        await home.cleanup();
        await store.cleanup();
      }
    },
  );
});

describe('readConfigText', () => {
  it('returns null for a missing config and the text for an existing one', async () => {
    const dir = await tempDir('oap-cfg-read-');
    try {
      const path = join(dir.root, 'opencode.json');
      expect(await readConfigText(path)).toBeNull();
      await writeFile(path, '{"theme":"dark"}', 'utf8');
      expect(await readConfigText(path)).toBe('{"theme":"dark"}');
    } finally {
      await dir.cleanup();
    }
  });

  it.skipIf(process.getuid?.() === 0)('reports an unreadable config as an edit error', async () => {
    const dir = await tempDir('oap-cfg-read-');
    const path = join(dir.root, 'opencode.json');
    try {
      await writeFile(path, '{}', 'utf8');
      await chmod(path, 0o200);
      try {
        await expect(readConfigText(path)).rejects.toThrow(ConfigEditError);
        await expect(readConfigText(path)).rejects.toThrow(/could not be read/);
      } finally {
        await chmod(path, 0o600);
      }
    } finally {
      await dir.cleanup();
    }
  });
});
