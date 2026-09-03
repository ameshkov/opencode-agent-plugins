/**
 * JSONC-preserving editing of the OpenCode config's `plugin` array
 * (`docs/design.md` §5.11–§5.12.4).
 *
 * The CLI registers/removes plugin sources by editing only the `plugin` array
 * of the resolved config file, keeping comments and formatting everywhere
 * else intact (jsonc-parser). Writes are atomic and validated before landing,
 * with a timestamped backup left in the store's `backups/` directory — never
 * a `<config>.bak` next to the user's config.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { applyEdits, modify, parseTree, type Node } from 'jsonc-parser';
import { storeDir } from './data.js';
import { writeFileAtomic } from './store.js';

/** The plugin's config identity: the tuple's package name. */
/** @internal Exported for tests only; not part of the public module API. */
export const PLUGIN_TUPLE_NAME = 'opencode-agent-plugins';

/** Scope of the config file to edit. */
export type ConfigScope =
  { kind: 'project'; cwd: string } | { kind: 'global' } | { kind: 'custom'; path: string };

/** Raised on any config-edit problem (conflict, unparsable, etc.). */
export class ConfigEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigEditError';
  }
}

/**
 * Resolves the config file for a scope.
 *
 * For the project scope `opencode.jsonc` wins over `opencode.json` when both
 * exist (and the CLI says so); when neither exists the default
 * `opencode.json` path is returned (creation happens on write).
 *
 * @param scope - Which config to target.
 * @returns The absolute config file path.
 */
export async function resolveConfigFile(scope: ConfigScope): Promise<string> {
  if (scope.kind === 'custom') {
    return scope.path;
  }
  if (scope.kind === 'global') {
    return join(homedir(), '.config', 'opencode', 'opencode.json');
  }
  const jsonc = join(scope.cwd, 'opencode.jsonc');
  const json = join(scope.cwd, 'opencode.json');
  if (existsSync(jsonc)) {
    return jsonc;
  }
  return json;
}

/**
 * Registers a plugin source into the `plugin` array of a config text.
 *
 * The source is appended to the `plugins` array of the existing
 * `["opencode-agent-plugins", {…}]` tuple when there is one (preserving other
 * options), otherwise a new tuple is appended/created. Already-registered
 * sources are left untouched.
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
  const plugin = findPluginArray(root);
  const tupleIndex = findTupleIndex(plugin);
  if (tupleIndex === -1) {
    const entry = [PLUGIN_TUPLE_NAME, { plugins: [source] }];
    if (plugin === undefined || plugin.children === undefined) {
      return applyEdits(sourceText, modify(sourceText, ['plugin'], [entry], {}));
    }
    return applyEdits(
      sourceText,
      modify(sourceText, ['plugin', plugin.children.length], entry, {
        isArrayInsertion: true,
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    ) as string;
  }
  const tuple = plugin!.children![tupleIndex]!;
  const options = tupleChildren(tuple)[1];
  const existing = isObject(options)
    ? (JSON.parse(sliceOf(sourceText, options)) as Record<string, unknown>)
    : {};
  const plugins = Array.isArray(existing['plugins']) ? existing['plugins'] : [];
  const strings = plugins.filter((p): p is string => typeof p === 'string');
  if (strings.includes(source)) {
    return text;
  }
  const next: Record<string, unknown> = { ...existing, plugins: [...strings, source] };
  const newTuple = [PLUGIN_TUPLE_NAME, next];
  return applyEdits(sourceText, modify(sourceText, ['plugin', tupleIndex], newTuple, {})) as string;
}

/**
 * Removes a plugin source from the `plugin` array of a config text.
 *
 * When the tuple's `plugins` array becomes empty the whole tuple is removed.
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
  const plugin = findPluginArray(root);
  const tupleIndex = findTupleIndex(plugin);
  if (plugin === undefined || tupleIndex === -1) {
    throw new ConfigEditError(`"${source}" is not registered (no plugin tuple found)`);
  }
  const tuple = plugin.children![tupleIndex]!;
  const options = tupleChildren(tuple)[1];
  if (!isObject(options)) {
    throw new ConfigEditError(`"${source}" is not registered in the plugin options`);
  }
  const existing = JSON.parse(sliceOf(text, options)) as Record<string, unknown>;
  const plugins = Array.isArray(existing['plugins']) ? existing['plugins'] : [];
  const strings = plugins.filter((p): p is string => typeof p === 'string');
  if (!strings.includes(source)) {
    throw new ConfigEditError(`"${source}" is not registered`);
  }
  const remaining = strings.filter((s) => s !== source);
  if (remaining.length === 0) {
    return applyEdits(text, modify(text, ['plugin', tupleIndex], undefined, {})) as string;
  }
  const next: Record<string, unknown> = { ...existing, plugins: remaining };
  return applyEdits(
    text,
    modify(text, ['plugin', tupleIndex], [PLUGIN_TUPLE_NAME, next], {}),
  ) as string;
}

/**
 * Validates, backs up and atomically writes an edited config file.
 *
 * The edited text must parse as JSONC (a CLI must never leave OpenCode with a
 * corrupt config); the previous content is backed up to the store's
 * `backups/` dir with a timestamped name, then the file is replaced via
 * temp + rename. A missing parent directory is created, so installing into a
 * config that does not exist yet works (the design creates `opencode.json`).
 *
 * Abort-on-conflict: when `expected` is given, it must match the content
 * read earlier by the caller; if the file changed between the read and the
 * write, nothing is written (the caller's edit would clobber user changes).
 *
 * @param path - Absolute config file path.
 * @param newText - The edited config text.
 * @param env - Environment view for store-root resolution.
 * @param expected - The config content previously read by the caller
 * (null when the file did not exist); omit to skip the conflict check.
 * @returns The path of the written backup (null when there was nothing to
 * back up, i.e. the file was created by this call).
 * @throws {ConfigEditError} When the edit does not parse as JSONC or the file
 * changed on disk since the caller read it.
 */
export async function saveConfig(
  path: string,
  newText: string,
  env = process.env,
  expected?: string | null,
): Promise<{ backupPath: string | null }> {
  if (parseTree(newText) === undefined) {
    throw new ConfigEditError('refusing to write config: result does not parse');
  }
  const previous = await readFile(path, 'utf8').catch(() => null);
  if (expected !== undefined && previous !== expected) {
    throw new ConfigEditError(
      'config file changed on disk since it was read; aborting (nothing written)',
    );
  }
  let backupPath: string | null = null;
  if (previous !== null) {
    backupPath = join(storeDir('backups', env), `${basename(path)}-${timestamp()}.bak`);
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, previous, 'utf8');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, newText);
  return { backupPath };
}

/** Current timestamp for backup names (filesystem-safe, UTC). */
function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** Finds the `plugin` array property of the config root (or undefined). */
function findPluginArray(root: Node): Node | undefined {
  if (root.type !== 'object') {
    throw new ConfigEditError('config root must be an object');
  }
  const prop = childrenOf(root).find(
    (node) =>
      node.type === 'property' &&
      node.children !== undefined &&
      node.children.length >= 2 &&
      node.children[0]!.value === 'plugin',
  );
  const value = prop === undefined ? undefined : prop.children![1];
  return value !== undefined && value.type === 'array' ? value : undefined;
}

/**
 * Extracts the configured source strings from a config text (best-effort).
 *
 * For a `["opencode-agent-plugins", { "plugins": [...] }]` tuple the sources
 * are the `plugins` array entries; plain string entries and tuples without a
 * plugins array contribute nothing. Unreadable/malformed configs yield an
 * empty list.
 *
 * @param text - Config text.
 * @returns The source strings found.
 */
export function configSourcesOf(text: string): string[] {
  const root = parseTree(text);
  if (root === undefined || root.type !== 'object') {
    return [];
  }
  const plugin = findPluginArray(root);
  if (plugin === undefined || plugin.children === undefined) {
    return [];
  }
  const out: string[] = [];
  for (const element of plugin.children) {
    if (element.type !== 'array' || !Array.isArray(element.children)) {
      continue;
    }
    const options = element.children[1];
    if (options === undefined || options.type !== 'object') {
      continue;
    }
    const pluginsProp = childrenOf(options).find(
      (node) => node.type === 'property' && node.children?.[0]?.value === 'plugins',
    );
    const pluginsArray = pluginsProp?.children?.[1];
    if (pluginsArray?.type !== 'array' || pluginsArray.children === undefined) {
      continue;
    }
    for (const source of pluginsArray.children) {
      if (source.type === 'string' && typeof source.value === 'string') {
        out.push(source.value);
      }
    }
  }
  return out;
}

/** Finds the position of the plugin tuple in the array (or -1). */
function findTupleIndex(plugin: Node | undefined): number {
  if (plugin === undefined || plugin.children === undefined) {
    return -1;
  }
  return plugin.children.findIndex(
    (element) => isTuple(element) && tupleChildren(element)[0]?.value === PLUGIN_TUPLE_NAME,
  );
}

/** Checks whether an array element is the `[name, options]` tuple shape. */
function isTuple(node: Node): boolean {
  return node.type === 'array' && node.children !== undefined && node.children.length >= 1;
}

/** Returns the top-level element nodes of an array node. */
function tupleChildren(node: Node): Node[] {
  return node.children ?? [];
}

/** Checks whether a node is an object node. */
function isObject(node: Node | undefined): node is Node {
  return node !== undefined && node.type === 'object';
}

/** Returns the child nodes of a node. */
function childrenOf(node: Node): Node[] {
  return node.children ?? [];
}

/** Extracts the underlying text of a node from the source. */
function sliceOf(text: string, node: Node): string {
  return text.slice(node.offset, node.offset + node.length);
}
