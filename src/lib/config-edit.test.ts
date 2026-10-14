import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, parseTree, type ParseError } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import {
  applyRegisterSource,
  applyRemoveSource,
  configHasLegacyTuple,
  configHasPluginEntry,
  configSourcesOf,
  probeConfig,
} from './config-edit.js';
import { PLUGIN_PACKAGE_NAME } from './config-tree.js';
import { ConfigEditError } from './config-file.js';
import { tempDir } from '../../test/helpers.js';

const WITH_COMMENTS = `{
  // user comments must survive
  "$schema": "https://opencode.ai/config.json",
  "theme": "dark",
  "plugins": [
    "some-other-plugin",
    { "package": "other-plugin", "options": { "x": 1 } }
  ]
}
`;

const WITH_ENTRY = `{
  "plugins": [
    { "package": "opencode-agent-plugins", "options": { "plugins": ["./local"], "prefix": true } }
  ]
}
`;

const WITH_LEGACY = `{
  "plugin": [
    ["opencode-agent-plugins", { "plugins": ["./local"], "prefix": true }]
  ]
}
`;

const WITH_LEGACY_AND_OTHER = `{
  "plugin": [
    ["other-plugin", {}],
    ["opencode-agent-plugins", { "plugins": ["./local"] }]
  ]
}
`;

const WITH_BOTH_FORMS = `{
  "plugin": [
    ["opencode-agent-plugins", { "plugins": ["./legacy"], "prefix": true, "logLevel": "debug" }]
  ],
  "plugins": [
    { "package": "opencode-agent-plugins", "options": { "plugins": ["./v2"], "logLevel": "warn" } }
  ]
}
`;

const WITH_BARE_STRING = `{
  // the bare-string loader entry
  "plugins": ["some-other-plugin", "opencode-agent-plugins"]
}
`;

const WITH_BARE_STRING_AND_LEGACY = `{
  "plugin": [
    ["opencode-agent-plugins", { "plugins": ["./legacy"], "prefix": true }]
  ],
  "plugins": ["opencode-agent-plugins"]
}
`;

const WITH_STRING_SOURCE = `{
  "plugins": [
    { "package": "opencode-agent-plugins", "options": { "plugins": "./a" } }
  ]
}
`;

const WITH_LEGACY_STRING_SOURCE = `{
  "plugin": [
    ["opencode-agent-plugins", { "plugins": "./a", "prefix": true }]
  ]
}
`;

/** Parse errors of a config text under OpenCode's tolerant parser options. */
function parseErrors(text: string): number[] {
  const errors: ParseError[] = [];
  parseTree(text, errors, { allowTrailingComma: true });
  return errors.map((error) => error.error);
}

describe('applyRegisterSource', () => {
  it('creates the plugins array with a new entry when missing', () => {
    const edited = applyRegisterSource(
      '{\n  "$schema": "https://opencode.ai/config.json"\n}\n',
      './agent-plugins/my-plugin',
    );
    expect(edited).toContain(`"package": "${PLUGIN_PACKAGE_NAME}"`);
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

  it('appends to an existing entry preserving other options', () => {
    const edited = applyRegisterSource(WITH_ENTRY, './second');
    const parsed = JSON.parse(edited) as {
      plugins: Array<{ package: string; options: { prefix: boolean; plugins: string[] } }>;
    };
    const entry = parsed.plugins[0]!;
    expect(entry.package).toBe(PLUGIN_PACKAGE_NAME);
    expect(entry.options.plugins).toEqual(['./local', './second']);
    expect(entry.options.prefix).toBe(true);
  });

  it('is a no-op for an already-registered source', () => {
    expect(applyRegisterSource(WITH_ENTRY, './local')).toBe(WITH_ENTRY);
  });

  it('keeps comments and unrelated plugin entries', () => {
    const edited = applyRegisterSource(WITH_COMMENTS, './agent-plugins/my-plugin');
    expect(edited).toContain('// user comments must survive');
    expect(edited).toContain('"theme": "dark"');
    const parsed = parse(edited) as { plugins: unknown[] };
    expect(parsed.plugins[0]).toBe('some-other-plugin');
    expect(parsed.plugins[1]).toEqual({ package: 'other-plugin', options: { x: 1 } });
  });

  it('migrates a legacy V1 tuple to a V2 entry, preserving its options', () => {
    const edited = applyRegisterSource(WITH_LEGACY, './second');
    const parsed = JSON.parse(edited) as {
      plugin?: unknown;
      plugins: Array<{ package: string; options: { prefix?: boolean; plugins: string[] } }>;
    };
    expect(parsed.plugin).toBeUndefined();
    expect(parsed.plugins).toHaveLength(1);
    expect(parsed.plugins[0]!.package).toBe(PLUGIN_PACKAGE_NAME);
    expect(parsed.plugins[0]!.options).toEqual({ plugins: ['./local', './second'], prefix: true });
  });

  it('migrates the loader tuple without touching other legacy entries', () => {
    const edited = applyRegisterSource(WITH_LEGACY_AND_OTHER, './second');
    const parsed = JSON.parse(edited) as {
      plugin?: unknown[];
      plugins: Array<{ options: { plugins: string[] } }>;
    };
    expect(parsed.plugin).toEqual([['other-plugin', {}]]);
    expect(parsed.plugins[0]!.options.plugins).toEqual(['./local', './second']);
  });

  it('merges legacy tuple options into an existing V2 entry (entry keys win)', () => {
    const edited = applyRegisterSource(WITH_BOTH_FORMS, './new');
    const parsed = JSON.parse(edited) as {
      plugin?: unknown;
      plugins: Array<{ options: { prefix?: boolean; logLevel?: string; plugins: string[] } }>;
    };
    expect(parsed.plugin).toBeUndefined();
    expect(parsed.plugins).toHaveLength(1);
    // `logLevel` keeps the entry's value; `prefix` is carried over.
    expect(parsed.plugins[0]!.options).toEqual({
      logLevel: 'warn',
      plugins: ['./v2', './legacy', './new'],
      prefix: true,
    });
  });

  it('replaces a bare-string loader entry with the object form in place', () => {
    const edited = applyRegisterSource(WITH_BARE_STRING, './local');
    const parsed = parse(edited) as {
      plugins: Array<string | { package: string; options: { plugins: string[] } }>;
    };
    // The comment and the unrelated string entry survive the replacement.
    expect(edited).toContain('// the bare-string loader entry');
    expect(parsed.plugins[0]).toBe('some-other-plugin');
    expect(parsed.plugins[1]).toEqual({
      package: PLUGIN_PACKAGE_NAME,
      options: { plugins: ['./local'] },
    });
    expect(configSourcesOf(edited)).toEqual(['./local']);
  });

  it('merges legacy tuple options into a replaced bare-string entry', () => {
    const edited = applyRegisterSource(WITH_BARE_STRING_AND_LEGACY, './new');
    const parsed = JSON.parse(edited) as {
      plugin?: unknown;
      plugins: Array<{ options: { prefix?: boolean; plugins: string[] } }>;
    };
    expect(parsed.plugin).toBeUndefined();
    expect(parsed.plugins).toEqual([
      { package: PLUGIN_PACKAGE_NAME, options: { prefix: true, plugins: ['./legacy', './new'] } },
    ]);
  });

  it('registers into a single-string source entry, normalizing to an array', () => {
    const edited = applyRegisterSource(WITH_STRING_SOURCE, './b');
    const parsed = JSON.parse(edited) as {
      plugins: Array<{ options: { plugins: string[] } }>;
    };
    expect(parsed.plugins[0]!.options.plugins).toEqual(['./a', './b']);
    expect(configSourcesOf(edited)).toEqual(['./a', './b']);
  });

  it('preserves a single-string source through the legacy tuple migration', () => {
    const edited = applyRegisterSource(WITH_LEGACY_STRING_SOURCE, './b');
    const parsed = JSON.parse(edited) as {
      plugin?: unknown;
      plugins: Array<{ options: { prefix?: boolean; plugins: string[] } }>;
    };
    expect(parsed.plugin).toBeUndefined();
    expect(parsed.plugins[0]!.options).toEqual({ prefix: true, plugins: ['./a', './b'] });
  });

  it('migrates a compact legacy tuple without corrupting the array', () => {
    const edited = applyRegisterSource(
      '{"plugin": [["other-plugin", {}], ["opencode-agent-plugins", {"plugins": []}]]}',
      './y',
    );
    expect(parseErrors(edited)).toEqual([]);
    const parsed = JSON.parse(edited) as { plugin?: unknown[] };
    expect(parsed.plugin).toEqual([['other-plugin', {}]]);
    expect(configHasLegacyTuple(edited)).toBe(false);
    expect(configSourcesOf(edited)).toContain('./y');
  });

  it('refuses a non-array plugins value instead of overwriting it', () => {
    expect(() => applyRegisterSource('{"plugins": "x"}', './a')).toThrow(
      'config "plugins" must be an array',
    );
    expect(() => applyRegisterSource('{"plugins": {}}', './a')).toThrow(ConfigEditError);
  });
});

describe('applyRemoveSource', () => {
  it('removes the source and the entry when it becomes empty', () => {
    const edited = applyRemoveSource(WITH_ENTRY, './local');
    expect(edited).not.toContain('"./local"');
    expect(configSourcesOf(edited)).toEqual([]);
    expect(configHasPluginEntry(edited)).toBe(false);
  });

  it('removes a source registered through a legacy tuple', () => {
    const edited = applyRemoveSource(WITH_LEGACY, './local');
    const parsed = JSON.parse(edited) as { plugin?: unknown };
    expect(parsed.plugin).toBeUndefined();
    expect(configSourcesOf(edited)).toEqual([]);
  });

  it('throws for a source in a bare-string-only config', () => {
    expect(() => applyRemoveSource(WITH_BARE_STRING, './local')).toThrow(ConfigEditError);
  });

  it('removes the whole entry after a bare-string entry was converted', () => {
    const registered = applyRegisterSource('{"plugins":["opencode-agent-plugins"]}', './local');
    const removed = applyRemoveSource(registered, './local');
    expect(configHasPluginEntry(removed)).toBe(false);
    expect(configSourcesOf(removed)).toEqual([]);
  });

  it('removes the sole single-string source and the whole entry', () => {
    const edited = applyRemoveSource(WITH_STRING_SOURCE, './a');
    expect(configHasPluginEntry(edited)).toBe(false);
    expect(configSourcesOf(edited)).toEqual([]);
  });

  it('removes the last compact entry without corrupting the array', () => {
    const edited = applyRemoveSource(
      '{"plugins": ["other", {"package": "opencode-agent-plugins", "options": {"plugins": ["./x"]}}]}',
      './x',
    );
    expect(edited).toBe('{"plugins": ["other"]}');
    expect(parseErrors(edited)).toEqual([]);
  });

  it('removes a middle compact entry', () => {
    const edited = applyRemoveSource(
      '{"plugins": [{"package": "opencode-agent-plugins", "options": {"plugins": ["./x"]}}, "other"]}',
      './x',
    );
    expect(parseErrors(edited)).toEqual([]);
    expect(configSourcesOf(edited)).toEqual([]);
  });

  it('throws when the source is not registered', () => {
    expect(() => applyRemoveSource(WITH_ENTRY, './nope')).toThrow(ConfigEditError);
  });
});

describe('configSourcesOf', () => {
  it('returns the sources of the V2 entry', () => {
    const text = applyRegisterSource('{"plugins": ["plain"]}', './agent-plugins/x');
    const sources = configSourcesOf(text);
    // Plain string entries are plugin names, not sources.
    expect(sources).toEqual(['./agent-plugins/x']);
    expect(configSourcesOf('{"plugins": ["plain"]}')).toEqual([]);
  });

  it('merges sources from a legacy tuple (best-effort)', () => {
    expect(configSourcesOf(WITH_LEGACY)).toEqual(['./local']);
  });

  it('reads single-string sources from both entry forms', () => {
    expect(configSourcesOf(WITH_STRING_SOURCE)).toEqual(['./a']);
    expect(configSourcesOf(WITH_LEGACY_STRING_SOURCE)).toEqual(['./a']);
  });
});

describe('configHasPluginEntry', () => {
  it('detects the V2 entry and the legacy tuple', () => {
    expect(configHasPluginEntry(WITH_ENTRY)).toBe(true);
    expect(configHasPluginEntry(WITH_LEGACY)).toBe(true);
  });

  it('detects the bare-string loader entry', () => {
    expect(configHasPluginEntry('{"plugins":["opencode-agent-plugins"]}')).toBe(true);
    expect(configHasPluginEntry(WITH_BARE_STRING)).toBe(true);
    expect(configHasPluginEntry('{"plugins":["other-plugin"]}')).toBe(false);
  });

  it('reports false for a config with only other plugin entries', () => {
    expect(configHasPluginEntry(WITH_COMMENTS)).toBe(false);
    expect(configHasPluginEntry('{"plugins": ["some-other-plugin"]}')).toBe(false);
  });

  it('reports false when the arrays or entry are missing', () => {
    expect(configHasPluginEntry('{"$schema": "https://opencode.ai/config.json"}')).toBe(false);
    expect(configHasPluginEntry('{}')).toBe(false);
  });

  it('reports false for malformed or empty configs', () => {
    expect(configHasPluginEntry('')).toBe(false);
    expect(configHasPluginEntry('{ invalid')).toBe(false);
  });
});

describe('configHasLegacyTuple', () => {
  it('detects only the legacy tuple form', () => {
    expect(configHasLegacyTuple(WITH_LEGACY)).toBe(true);
    expect(configHasLegacyTuple(WITH_ENTRY)).toBe(false);
    expect(configHasLegacyTuple(WITH_COMMENTS)).toBe(false);
  });
});

describe('probeConfig', () => {
  it('reports the entry and legacy state for a custom config file', async () => {
    const dir = await tempDir('oap-cfg-probe-');
    try {
      const path = join(dir.root, 'opencode.jsonc');
      await writeFile(path, WITH_LEGACY, 'utf8');
      const probe = await probeConfig({ kind: 'custom', path });
      expect(probe.path).toBe(path);
      expect(probe.jsoncWins).toBe(false);
      expect(probe.hasEntry).toBe(true);
      expect(probe.legacyTuple).toBe(true);
    } finally {
      await dir.cleanup();
    }
  });

  it('reports hasEntry false when the config has no loader entry', async () => {
    const dir = await tempDir('oap-cfg-probe-');
    try {
      const path = join(dir.root, 'opencode.json');
      await writeFile(path, '{"$schema": "https://opencode.ai/config.json"}', 'utf8');
      const probe = await probeConfig({ kind: 'custom', path });
      expect(probe.hasEntry).toBe(false);
      expect(probe.legacyTuple).toBe(false);
    } finally {
      await dir.cleanup();
    }
  });

  it('reports hasEntry false when the config file does not exist', async () => {
    const dir = await tempDir('oap-cfg-probe-');
    try {
      const path = join(dir.root, 'opencode.json');
      const probe = await probeConfig({ kind: 'custom', path });
      expect(probe.path).toBe(path);
      expect(probe.hasEntry).toBe(false);
    } finally {
      await dir.cleanup();
    }
  });
});
