/**
 * JSONC-preserving edits of the OpenCode config's plugin arrays
 * (`docs/explanation/design.md` §5.11–§5.12.4).
 *
 * V2 registers plugins in the `plugins` array as `{ package, options }`
 * objects; a bare package string (`"opencode-agent-plugins"`) is a valid loader
 * entry too — detection recognises both, and the first write replaces the bare
 * string with the object form. The CLI also recognises the legacy V1 `plugin`
 * array tuple (`["opencode-agent-plugins", { plugins: [...] }]`): reads merge
 * its sources, and the first install write migrates it to the V2 form (its
 * options merged, the V2 entry's keys win), so V2 never loads the loader
 * twice. Only the affected arrays change (jsonc-parser); comments and
 * formatting elsewhere stay intact.
 */

import { readFile } from 'node:fs/promises';
import {
  applyEdits,
  findNodeAtLocation,
  modify,
  parseTree,
  type Edit,
  type Node,
} from 'jsonc-parser';
import { ConfigEditError, resolveConfigFile, type ConfigScope } from './config-file.js';
import {
  entrySourcesOf,
  findLegacyTuple,
  findLoaderEntryIndex,
  findPluginsArray,
  objectProperty,
  objectValueOf,
  PLUGIN_PACKAGE_NAME,
  type LegacyTuple,
} from './config-tree.js';

/** Formatting used for inserted entries (matches the project's 2-space style). */
const FORMAT = { insertSpaces: true, tabSize: 2 };

/**
 * Registers a plugin source into the config's `plugins` entry.
 *
 * The source is appended to the existing loader entry's `options.plugins`
 * array when there is one (preserving other options); otherwise a new
 * `{ package, options }` entry is appended/created. A legacy V1 tuple is
 * migrated: its sources and other options are merged into the V2 entry (the
 * entry's keys win) and the tuple is removed. Already-registered sources are
 * left untouched.
 *
 * @param text - Current config text.
 * @param source - The source string to register.
 * @returns The edited config text.
 * @throws {ConfigEditError} When the config structure cannot be edited safely.
 */
export function applyRegisterSource(text: string, source: string): string {
  // A missing or empty config file is treated as an empty object: the design
  // creates the config file when none exists (§5.11). Whitespace-only content
  // is not valid JSONC, so normalize it to `{}` as well.
  const sourceText = text.trim() === '' ? '{}' : text;
  const root = parseTree(sourceText);
  if (root === undefined) {
    throw new ConfigEditError('config is not a valid JSONC document');
  }
  const pluginsProperty = objectProperty(root, 'plugins');
  if (pluginsProperty !== undefined && pluginsProperty.type !== 'array') {
    throw new ConfigEditError('config "plugins" must be an array');
  }
  const plugins = findPluginsArray(root);
  const entryIndex = findLoaderEntryIndex(plugins);
  const legacy = findLegacyTuple(root);
  const current = entrySourcesOf(plugins, entryIndex);
  const merged = mergedSources(current, legacy, source);
  if (legacy === null && entryIndex !== -1 && current.includes(source)) {
    return text;
  }

  // Remove a legacy tuple first, then re-parse: the insertion point for a new
  // `plugins` property and the tuple removal can otherwise overlap.
  const edited = removeLegacyTuple(sourceText, legacy);
  const editedRoot = parseTree(edited);
  if (editedRoot === undefined) {
    throw new ConfigEditError('config is not a valid JSONC document');
  }
  const editedPlugins = findPluginsArray(editedRoot);
  const editedIndex = findLoaderEntryIndex(editedPlugins);
  if (editedIndex === -1) {
    return addLoaderEntry(edited, editedPlugins, legacy, merged);
  }
  const entry = editedPlugins!.children![editedIndex]!;
  if (entry.type === 'string') {
    return replaceStringEntry(edited, editedIndex, legacy, merged);
  }
  assertEditableEntry(entry);
  const entryText = mergeLegacyOptions(edited, editedIndex, entry, legacy);
  return applyEdits(
    entryText,
    modify(entryText, ['plugins', editedIndex, 'options', 'plugins'], merged, {}),
  ) as string;
}

/**
 * Removes a plugin source from the config's `plugins` entry (and any legacy
 * V1 tuple).
 *
 * When the loader entry's `options.plugins` array becomes empty the whole
 * entry is removed; a legacy tuple is removed when its last source goes.
 *
 * @param text - Current config text.
 * @param source - The registered source string to remove.
 * @returns The edited config text.
 * @throws {ConfigEditError} When the source is not registered.
 */
export function applyRemoveSource(text: string, source: string): string {
  const root = parseTree(text);
  if (root === undefined) {
    throw new ConfigEditError('config is not a valid JSONC document');
  }
  const plugins = findPluginsArray(root);
  const entryIndex = findLoaderEntryIndex(plugins);
  const legacy = findLegacyTuple(root);
  const entrySources = entrySourcesOf(plugins, entryIndex);
  const inEntry = entrySources.includes(source);
  const inLegacy = legacy?.sources.includes(source) ?? false;
  if (!inEntry && !inLegacy) {
    throw new ConfigEditError(`"${source}" is not registered`);
  }

  const edits: Edit[] = [];
  if (inEntry) {
    assertEditableEntry(plugins!.children![entryIndex]!);
    const remaining = entrySources.filter((candidate) => candidate !== source);
    if (remaining.length === 0) {
      edits.push(...removeElementEdits(text, ['plugins'], entryIndex));
    } else {
      edits.push(...modify(text, ['plugins', entryIndex, 'options', 'plugins'], remaining, {}));
    }
  }
  if (inLegacy && legacy !== null) {
    const remaining = legacy.sources.filter((candidate) => candidate !== source);
    if (remaining.length === 0) {
      edits.push(...legacyRemovalEdits(text, legacy));
    } else {
      edits.push(...modify(text, ['plugin', legacy.index, 1, 'plugins'], remaining, {}));
    }
  }
  return applyEdits(text, edits) as string;
}

/**
 * Extracts the configured source strings from a config text (best-effort).
 *
 * Reads the V2 loader entry's `options.plugins` array plus any legacy V1
 * tuple, so store entries referenced through either form stay protected from
 * `doctor`/`prune`. Unreadable/malformed configs yield an empty list.
 *
 * @param text - Config text.
 * @returns The source strings found.
 */
export function configSourcesOf(text: string): string[] {
  const root = parseTree(text);
  if (root === undefined || root.type !== 'object') {
    return [];
  }
  const plugins = findPluginsArray(root);
  const sources = entrySourcesOf(plugins, findLoaderEntryIndex(plugins));
  const legacy = findLegacyTuple(root);
  if (legacy !== null) {
    for (const source of legacy.sources) {
      if (!sources.includes(source)) {
        sources.push(source);
      }
    }
  }
  return sources;
}

/**
 * `true` when a config text contains a loader entry for this package — the
 * V2 `{ package: "opencode-agent-plugins", … }` object, a bare package
 * string, or a legacy V1 `["opencode-agent-plugins", {…}]` tuple (V2 reads
 * all three).
 *
 * The CLI uses this before `install` registers a source: when the loader
 * entry is absent, registering the source alone is inert (OpenCode never
 * loads the loader plugin), so the CLI warns and offers to add the entry.
 *
 * @param text - Config text.
 * @returns `true` when a loader entry is present.
 * @internal Exported for tests only; production callers go through
 * {@link probeConfig}. Not part of the public module API.
 */
export function configHasPluginEntry(text: string): boolean {
  const root = parseTree(text);
  if (root === undefined || root.type !== 'object') {
    return false;
  }
  const plugins = findPluginsArray(root);
  return findLoaderEntryIndex(plugins) !== -1 || findLegacyTuple(root) !== null;
}

/**
 * `true` when a config text still contains a legacy V1 loader tuple (V2
 * reads it, but the next install write migrates it).
 *
 * @param text - Config text.
 * @returns `true` when a legacy tuple is present.
 * @internal Exported for tests only; not part of the public module API.
 */
export function configHasLegacyTuple(text: string): boolean {
  const root = parseTree(text);
  if (root === undefined || root.type !== 'object') {
    return false;
  }
  return findLegacyTuple(root) !== null;
}

/** Result of probing the resolved config for the loader entry (§5.11). */
export interface ConfigProbe {
  /** Absolute path of the resolved config file. */
  path: string;
  /** True when `opencode.jsonc` won over an existing `opencode.json`. */
  jsoncWins: boolean;
  /** True when the config contains a loader entry (V2 or legacy). */
  hasEntry: boolean;
  /** True when the config contains a legacy V1 loader tuple (possibly alongside a V2 entry). */
  legacyTuple: boolean;
}

/**
 * Resolves and reads the config for a scope without writing anything.
 *
 * The CLI probes this before `install` registers a source: when the loader
 * entry is absent, registering the source alone would never be loaded by
 * OpenCode, so the CLI warns and asks the user first (§5.11). A missing or
 * unreadable config file reports `hasEntry: false` (the entry cannot exist
 * there; the config is created on registration).
 *
 * @param scope - Which config to inspect.
 * @returns The resolved path plus whether the loader entry is present.
 */
export async function probeConfig(scope: ConfigScope): Promise<ConfigProbe> {
  const resolved = await resolveConfigFile(scope);
  const text = await readFile(resolved.path, 'utf8').catch(() => null);
  return {
    path: resolved.path,
    jsoncWins: resolved.jsoncWins,
    hasEntry: text === null ? false : configHasPluginEntry(text),
    legacyTuple: text === null ? false : configHasLegacyTuple(text),
  };
}

/** Ensures an existing V2 entry is safe to edit (throws otherwise). */
function assertEditableEntry(entry: Node): void {
  const options = objectProperty(entry, 'options');
  if (options !== undefined && options.type !== 'object') {
    throw new ConfigEditError('loader entry "options" must be an object');
  }
  if (options !== undefined && options.type === 'object') {
    const sources = objectProperty(options, 'plugins');
    if (sources !== undefined && sources.type !== 'array' && sources.type !== 'string') {
      throw new ConfigEditError('loader entry "options.plugins" must be a string or an array');
    }
  }
}

/**
 * Merges the V2 entry's sources, the legacy tuple's sources, and the new
 * source into one list (duplicates dropped, registration order preserved).
 *
 * @param current - Sources already registered in the V2 entry.
 * @param legacy - The legacy tuple, or null.
 * @param source - The source to register.
 * @returns The merged source list.
 */
function mergedSources(current: string[], legacy: LegacyTuple | null, source: string): string[] {
  const merged = new Set<string>(current);
  for (const legacySource of legacy?.sources ?? []) {
    merged.add(legacySource);
  }
  merged.add(source);
  return [...merged];
}

/**
 * Removes the legacy tuple from the config text (a no-op without one).
 *
 * @param text - Config text.
 * @param legacy - The legacy tuple, or null.
 * @returns The edited text.
 */
function removeLegacyTuple(text: string, legacy: LegacyTuple | null): string {
  return legacy === null ? text : (applyEdits(text, legacyRemovalEdits(text, legacy)) as string);
}

/**
 * Creates the V2 loader entry with the merged sources, carrying over the
 * legacy tuple's other options (`prefix`, `logLevel`).
 *
 * @param text - Config text with the legacy tuple already removed.
 * @param plugins - The `plugins` array node, or undefined when absent.
 * @param legacy - The removed legacy tuple, or null.
 * @param merged - The merged source list.
 * @returns The edited text.
 */
function addLoaderEntry(
  text: string,
  plugins: Node | undefined,
  legacy: LegacyTuple | null,
  merged: string[],
): string {
  const entry = loaderEntryOf(legacy, merged);
  const edits =
    plugins?.children === undefined
      ? modify(text, ['plugins'], [entry], { formattingOptions: FORMAT })
      : modify(text, ['plugins', plugins.children.length], entry, {
          isArrayInsertion: true,
          formattingOptions: FORMAT,
        });
  return applyEdits(text, edits) as string;
}

/**
 * Replaces a bare-string loader entry with the object form, keeping its array
 * position.
 *
 * jsonc-parser cannot add properties to a string node, so the element itself
 * is replaced; the legacy tuple's options carry over like in
 * {@link addLoaderEntry}.
 *
 * @param text - Config text with the legacy tuple already removed.
 * @param entryIndex - Index of the bare-string entry in the `plugins` array.
 * @param legacy - The removed legacy tuple, or null.
 * @param merged - The merged source list.
 * @returns The edited text.
 */
function replaceStringEntry(
  text: string,
  entryIndex: number,
  legacy: LegacyTuple | null,
  merged: string[],
): string {
  return applyEdits(
    text,
    modify(text, ['plugins', entryIndex], loaderEntryOf(legacy, merged), {
      formattingOptions: FORMAT,
    }),
  ) as string;
}

/** Builds the V2 loader entry object, carrying over the legacy options. */
function loaderEntryOf(legacy: LegacyTuple | null, merged: string[]): Record<string, unknown> {
  return {
    package: PLUGIN_PACKAGE_NAME,
    options: { ...(legacy?.options ?? {}), plugins: merged },
  };
}

/**
 * Adds the legacy tuple's other options to an existing V2 entry (missing keys
 * only — the entry's keys win), so a migration never drops `prefix`/`logLevel`.
 *
 * @param text - Config text with the legacy tuple already removed.
 * @param entryIndex - Index of the loader entry in the `plugins` array.
 * @param entry - The loader entry node.
 * @param legacy - The removed legacy tuple, or null.
 * @returns The edited text.
 */
function mergeLegacyOptions(
  text: string,
  entryIndex: number,
  entry: Node,
  legacy: LegacyTuple | null,
): string {
  const entryOptions = objectValueOf(objectProperty(entry, 'options'));
  let edited = text;
  for (const [key, value] of Object.entries(legacy?.options ?? {})) {
    if (key !== 'plugins' && !(key in entryOptions)) {
      edited = applyEdits(
        edited,
        modify(edited, ['plugins', entryIndex, 'options', key], value, {}),
      ) as string;
    }
  }
  return edited;
}

/**
 * Edits that remove the element at `index` of the array at `path`.
 *
 * jsonc-parser's last-element removal assumes whitespace or a trailing comma
 * before `]`; when the bracket directly follows the element, the edit stops
 * one character short and leaves the element's closing brace behind. Compute
 * that one case from the tree instead.
 *
 * @param text - Config text.
 * @param path - Path of the array.
 * @param index - Index of the element to remove.
 * @returns The edits that remove it.
 */
function removeElementEdits(text: string, path: (string | number)[], index: number): Edit[] {
  const root = parseTree(text);
  const array = root === undefined ? undefined : findNodeAtLocation(root, path);
  const children = array?.type === 'array' ? array.children : undefined;
  if (children === undefined || children.length <= 1 || index !== children.length - 1) {
    return modify(text, [...path, index], undefined, {});
  }
  const previous = children[index - 1]!;
  const begin = previous.offset + previous.length;
  const end = array!.offset + array!.length - 1; // keep the closing `]`
  return [{ offset: begin, length: end - begin, content: '' }];
}

/** Builds the edits that remove a legacy tuple (and its key when empty). */
function legacyRemovalEdits(text: string, legacy: LegacyTuple): Edit[] {
  if (legacy.only) {
    return modify(text, ['plugin'], undefined, {});
  }
  return removeElementEdits(text, ['plugin'], legacy.index);
}
