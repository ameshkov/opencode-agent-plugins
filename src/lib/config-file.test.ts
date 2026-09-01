import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import {
  applyRegisterSource,
  applyRemoveSource,
  configSourcesOf,
  ConfigEditError,
  PLUGIN_TUPLE_NAME,
} from './config-file.js';

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
