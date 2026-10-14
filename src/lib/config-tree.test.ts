import { parseTree } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import {
  entrySourcesOf,
  findLegacyTuple,
  findLoaderEntryIndex,
  findPluginsArray,
  objectProperty,
  objectValueOf,
  PLUGIN_PACKAGE_NAME,
} from './config-tree.js';

/** Parses JSONC text into a root node (fails loudly on invalid input). */
function rootOf(text: string) {
  const root = parseTree(text);
  if (root === undefined) {
    throw new Error(`invalid JSONC in test fixture: ${text}`);
  }
  return root;
}

describe('findPluginsArray', () => {
  it('finds the plugins array and ignores non-arrays', () => {
    expect(findPluginsArray(rootOf('{"plugins":[]}'))).toBeDefined();
    expect(findPluginsArray(rootOf('{"plugins":"x"}'))).toBeUndefined();
    expect(findPluginsArray(rootOf('{}'))).toBeUndefined();
  });

  it('throws when the root is not an object', () => {
    expect(() => findPluginsArray(rootOf('[]'))).toThrow('config root must be an object');
  });
});

describe('findLoaderEntryIndex', () => {
  it('finds object and bare-string loader entries', () => {
    const entry = `{"package":"${PLUGIN_PACKAGE_NAME}","options":{}}`;
    expect(findLoaderEntryIndex(findPluginsArray(rootOf(`{"plugins":[${entry}]}`)))).toBe(0);
    const bare = rootOf(`{"plugins":["other","${PLUGIN_PACKAGE_NAME}"]}`);
    expect(findLoaderEntryIndex(findPluginsArray(bare))).toBe(1);
  });

  it('returns -1 without an array or loader entry', () => {
    expect(findLoaderEntryIndex(undefined)).toBe(-1);
    expect(findLoaderEntryIndex(findPluginsArray(rootOf('{"plugins":["other"]}')))).toBe(-1);
  });
});

describe('entrySourcesOf', () => {
  it('reads array and single-string sources', () => {
    const array = findPluginsArray(
      rootOf(
        `{"plugins":[{"package":"${PLUGIN_PACKAGE_NAME}","options":{"plugins":["./a","./b"]}}]}`,
      ),
    );
    expect(entrySourcesOf(array, 0)).toEqual(['./a', './b']);
    const single = findPluginsArray(
      rootOf(`{"plugins":[{"package":"${PLUGIN_PACKAGE_NAME}","options":{"plugins":"./a"}}]}`),
    );
    expect(entrySourcesOf(single, 0)).toEqual(['./a']);
  });

  it('returns an empty list without an entry or sources', () => {
    expect(entrySourcesOf(undefined, 0)).toEqual([]);
    expect(entrySourcesOf(findPluginsArray(rootOf('{"plugins":[]}')), 0)).toEqual([]);
    expect(
      entrySourcesOf(
        findPluginsArray(rootOf(`{"plugins":[{"package":"${PLUGIN_PACKAGE_NAME}"}]}`)),
        0,
      ),
    ).toEqual([]);
  });
});

describe('findLegacyTuple', () => {
  it('reads the tuple sources, options, and single-element flag', () => {
    const root = rootOf(
      `{"plugin":[["${PLUGIN_PACKAGE_NAME}",{"plugins":["./a"],"prefix":true}]]}`,
    );
    const legacy = findLegacyTuple(root);
    expect(legacy).not.toBeNull();
    expect(legacy!.index).toBe(0);
    expect(legacy!.sources).toEqual(['./a']);
    expect(legacy!.options).toEqual({ plugins: ['./a'], prefix: true });
    expect(legacy!.only).toBe(true);
  });

  it('reads a single-string legacy source and tracks its position', () => {
    const root = rootOf(`{"plugin":[["other",{}],["${PLUGIN_PACKAGE_NAME}",{"plugins":"./a"}]]}`);
    const legacy = findLegacyTuple(root);
    expect(legacy!.index).toBe(1);
    expect(legacy!.sources).toEqual(['./a']);
    expect(legacy!.only).toBe(false);
  });

  it('returns null without a legacy tuple', () => {
    expect(findLegacyTuple(rootOf('{}'))).toBeNull();
    expect(findLegacyTuple(rootOf('{"plugin":[["other",{}]]}'))).toBeNull();
  });
});

describe('objectProperty / objectValueOf', () => {
  it('reads property values and tolerates missing nodes', () => {
    const node = rootOf('{"a":{"b":1},"c":"x"}');
    expect(objectProperty(node, 'c')?.value).toBe('x');
    expect(objectProperty(node, 'nope')).toBeUndefined();
    expect(objectProperty(rootOf('"scalar"'), 'c')).toBeUndefined();
    expect(objectValueOf(objectProperty(node, 'a'))).toEqual({ b: 1 });
    expect(objectValueOf(undefined)).toEqual({});
    expect(objectValueOf(objectProperty(node, 'c'))).toEqual({});
  });
});
