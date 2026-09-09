import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, expect, it, vi } from 'vitest';
import {
  applyRegisterSource,
  applyRemoveSource,
  configHasPluginTuple,
  configPreferenceNote,
  configSourcesOf,
  ConfigEditError,
  PLUGIN_TUPLE_NAME,
  probeConfig,
  resolveConfigFile,
  saveConfig,
} from './config-file.js';
import { storeEnv, tempDir } from '../../test/helpers.js';

/** Controlled `homedir()` for the global-scope tests (§5.11). */
const { mockHomedir } = vi.hoisted(() => ({ mockHomedir: { value: '' } }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHomedir.value };
});

const WITH_COMMENTS = `{
  // user comments must survive
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "plugin": [
    ["some-other-plugin", { "x": 1 }]
  ]
}
`;

const WITH_TUPLE = `{
  "plugin": [
    ["opencode-agent-plugins", { "plugins": ["./local"], "prefix": true }]
  ]
}
`;

describe('applyRegisterSource', () => {
  it('creates the plugin array with a new tuple when missing', () => {
    const edited = applyRegisterSource(
      '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
      './agent-plugins/my-plugin',
    );
    expect(edited).toContain(`["${PLUGIN_TUPLE_NAME}",`);
    const sources = configSourcesOf(edited);
    expect(sources).toEqual(['./agent-plugins/my-plugin']);
    // Valid JSONC after the edit.
    expect(() => JSON.parse(edited)).not.toThrow();
  });

  it('creates a config from an empty file (§5.11)', () => {
    const edited = applyRegisterSource('', './agent-plugins/my-plugin');
    expect(() => JSON.parse(edited)).not.toThrow();
    expect(configSourcesOf(edited)).toEqual(['./agent-plugins/my-plugin']);
  });

  it('treats whitespace-only content as an empty config', () => {
    const edited = applyRegisterSource('   \n\t ', './agent-plugins/my-plugin');
    expect(configSourcesOf(edited)).toEqual(['./agent-plugins/my-plugin']);
  });

  it('appends to an existing tuple preserving other options', () => {
    const edited = applyRegisterSource(WITH_TUPLE, './second');
    const parsed = JSON.parse(edited) as {
      plugin: Array<[string, { prefix: boolean; plugins: string[] }]>;
    };
    const tuple = parsed.plugin[0]!;
    expect(tuple[0]).toBe(PLUGIN_TUPLE_NAME);
    expect(tuple[1].plugins).toEqual(['./local', './second']);
    expect(tuple[1].prefix).toBe(true);
  });

  it('is a no-op for an already-registered source', () => {
    expect(applyRegisterSource(WITH_TUPLE, './local')).toBe(WITH_TUPLE);
  });

  it('keeps comments and unrelated formatting', () => {
    const edited = applyRegisterSource(WITH_COMMENTS, './agent-plugins/my-plugin');
    expect(edited).toContain('// user comments must survive');
    expect(edited).toContain('"theme": "dark"');
    const parsed = parse(edited) as { plugin: unknown[] };
    expect(parsed.plugin[0]).toEqual(['some-other-plugin', { x: 1 }]);
  });
});

describe('applyRemoveSource', () => {
  it('removes the source from the tuple plugins array', () => {
    const edited = applyRemoveSource(WITH_TUPLE, './local');
    expect(edited).not.toContain('"./local"');
    const sources = configSourcesOf(edited);
    expect(sources).toEqual([]);
  });

  it('throws when the source is not registered', () => {
    expect(() => applyRemoveSource(WITH_TUPLE, './nope')).toThrow(ConfigEditError);
  });
});

describe('configSourcesOf', () => {
  it('returns the plugins array of the plugin tuple', () => {
    const text = applyRegisterSource('{"plugin": ["plain"]}', './agent-plugins/x');
    const sources = configSourcesOf(text);
    // Plain string entries are plugin names, not sources.
    expect(sources).toEqual(['./agent-plugins/x']);
    expect(configSourcesOf('{"plugin": ["plain"]}')).toEqual([]);
  });
});

describe('configHasPluginTuple', () => {
  it('detects the loader tuple when present', () => {
    expect(configHasPluginTuple(WITH_TUPLE)).toBe(true);
  });

  it('reports false for a config with only other plugin entries', () => {
    expect(configHasPluginTuple(WITH_COMMENTS)).toBe(false);
    expect(configHasPluginTuple('{"plugin": ["some-other-plugin"]}')).toBe(false);
  });

  it('reports false when the plugin array or tuple is missing', () => {
    expect(configHasPluginTuple('{"$schema": "https://opencode.ai/config.json"}')).toBe(false);
    expect(configHasPluginTuple('{}')).toBe(false);
  });

  it('reports false for malformed or empty configs', () => {
    expect(configHasPluginTuple('')).toBe(false);
    expect(configHasPluginTuple('{ invalid')).toBe(false);
  });
});

describe('probeConfig', () => {
  it('reports the tuple presence for a custom config file', async () => {
    const dir = await tempDir('oap-cfg-probe-');
    try {
      const path = join(dir.root, 'opencode.jsonc');
      await writeFile(path, WITH_TUPLE, 'utf8');
      const probe = await probeConfig({ kind: 'custom', path });
      expect(probe.path).toBe(path);
      expect(probe.jsoncWins).toBe(false);
      expect(probe.hasTuple).toBe(true);
    } finally {
      await dir.cleanup();
    }
  });

  it('reports hasTuple false when the config has no loader tuple', async () => {
    const dir = await tempDir('oap-cfg-probe-');
    try {
      const path = join(dir.root, 'opencode.json');
      await writeFile(path, '{"$schema": "https://opencode.ai/config.json"}', 'utf8');
      const probe = await probeConfig({ kind: 'custom', path });
      expect(probe.hasTuple).toBe(false);
    } finally {
      await dir.cleanup();
    }
  });

  it('reports hasTuple false when the config file does not exist', async () => {
    const dir = await tempDir('oap-cfg-probe-');
    try {
      const path = join(dir.root, 'opencode.json');
      const probe = await probeConfig({ kind: 'custom', path });
      expect(probe.path).toBe(path);
      expect(probe.hasTuple).toBe(false);
    } finally {
      await dir.cleanup();
    }
  });
});

describe('resolveConfigFile', () => {
  it('prefers opencode.jsonc when both exist in the project scope (§5.11)', async () => {
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

  it('prefers opencode.jsonc in the global scope too (§5.11)', async () => {
    const home = await tempDir('oap-cfg-home-');
    try {
      const globalDir = join(home.root, '.config', 'opencode');
      await mkdir(globalDir, { recursive: true });
      await writeFile(join(globalDir, 'opencode.json'), '{}', 'utf8');
      await writeFile(join(globalDir, 'opencode.jsonc'), '{}', 'utf8');
      mockHomedir.value = home.root;
      const resolved = await resolveConfigFile({ kind: 'global' });
      expect(resolved.path).toBe(join(globalDir, 'opencode.jsonc'));
      expect(resolved.jsoncWins).toBe(true);
    } finally {
      mockHomedir.value = '';
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
      const saved = await saveConfig(path, '{"plugin": []}', storeEnv(store.root));
      expect(saved.backupPath).toBeNull();
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ plugin: [] });
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
        '{"plugin": []}',
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
        saveConfig(path, '{"plugin": []}', storeEnv(store.root), '{"a":2}'),
      ).rejects.toThrow(ConfigEditError);
      // Nothing written: the on-disk content is untouched.
      expect(await readFile(path, 'utf8')).toBe('{"a":1}');
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
      await expect(saveConfig(path, '{"plugin": []}', storeEnv(store.root), null)).rejects.toThrow(
        ConfigEditError,
      );
    } finally {
      await home.cleanup();
      await store.cleanup();
    }
  });
});
