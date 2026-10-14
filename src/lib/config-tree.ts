/**
 * jsonc-parser node accessors for the OpenCode config's plugin arrays
 * (`docs/explanation/design.md` §5.11).
 *
 * Three loader forms exist: the V2 `plugins` object entry
 * (`{ package, options }`), the V2 bare package string, and the legacy V1
 * `plugin` tuple. These helpers find them and read their source lists;
 * `config-edit.ts` owns the edits.
 */

import { getNodeValue, type Node } from 'jsonc-parser';
import { ConfigEditError } from './config-file.js';

/**
 * The plugin's config identity: the loader entry's `package` value.
 */
export const PLUGIN_PACKAGE_NAME = 'opencode-agent-plugins';

/**
 * Finds the `plugins` array property of the config root (or undefined).
 *
 * @param root - Config root node.
 * @returns The array node, or undefined when absent/not an array.
 */
export function findPluginsArray(root: Node): Node | undefined {
  return arrayProperty(root, 'plugins');
}

/**
 * Index of the V2 loader entry (object or bare string) in the array (or -1).
 *
 * @param plugins - The `plugins` array node, or undefined.
 * @returns The entry index, or -1 when there is none.
 */
export function findLoaderEntryIndex(plugins: Node | undefined): number {
  if (plugins?.children === undefined) {
    return -1;
  }
  return plugins.children.findIndex(
    (element) =>
      (element.type === 'string' && element.value === PLUGIN_PACKAGE_NAME) ||
      (element.type === 'object' &&
        objectProperty(element, 'package')?.value === PLUGIN_PACKAGE_NAME),
  );
}

/**
 * Reads the loader entry's configured sources (best-effort).
 *
 * @param plugins - The `plugins` array node, or undefined.
 * @param index - Index of the loader entry in the array.
 * @returns The source strings; empty when the entry has none.
 */
export function entrySourcesOf(plugins: Node | undefined, index: number): string[] {
  const entry = plugins?.children?.[index];
  if (entry === undefined) {
    return [];
  }
  const options = objectProperty(entry, 'options');
  if (options === undefined || options.type !== 'object') {
    return [];
  }
  return sourceValuesOf(objectProperty(options, 'plugins'));
}

/** A legacy V1 loader tuple found in the `plugin` array. */
export interface LegacyTuple {
  /** Index of the tuple inside the `plugin` array. */
  index: number;
  /** Sources recorded in the tuple's options. */
  sources: string[];
  /** Other loader options (e.g. `prefix`), preserved on migration. */
  options: Record<string, unknown>;
  /** True when the tuple is the only element (the key can go too). */
  only: boolean;
}

/**
 * Finds the legacy V1 loader tuple (or null).
 *
 * @param root - Config root node.
 * @returns The tuple, or null when absent.
 */
export function findLegacyTuple(root: Node): LegacyTuple | null {
  const legacy = findLegacyPluginArray(root);
  if (legacy?.children === undefined) {
    return null;
  }
  const index = legacy.children.findIndex(
    (element) => element.type === 'array' && element.children?.[0]?.value === PLUGIN_PACKAGE_NAME,
  );
  if (index === -1) {
    return null;
  }
  const optionsNode = legacy.children[index]!.children?.[1];
  const optionsValue =
    optionsNode !== undefined && optionsNode.type === 'object'
      ? (getNodeValue(optionsNode) as Record<string, unknown>)
      : {};
  return {
    index,
    sources: sourceValuesOf(
      optionsNode !== undefined && optionsNode.type === 'object'
        ? objectProperty(optionsNode, 'plugins')
        : undefined,
    ),
    options: optionsValue,
    only: legacy.children.length === 1,
  };
}

/**
 * Returns a property value node of an object node (or undefined).
 *
 * @param node - The node to read.
 * @param name - Property name.
 * @returns The value node, or undefined when absent/not an object.
 */
export function objectProperty(node: Node, name: string): Node | undefined {
  if (node.type !== 'object') {
    return undefined;
  }
  const prop = childrenOf(node).find(
    (child) => child.type === 'property' && child.children?.[0]?.value === name,
  );
  return prop?.children?.[1];
}

/**
 * Reads an object node's value (or an empty object for a missing node).
 *
 * @param node - The node to read, or undefined.
 * @returns The object value, or `{}`.
 */
export function objectValueOf(node: Node | undefined): Record<string, unknown> {
  return node !== undefined && node.type === 'object'
    ? (getNodeValue(node) as Record<string, unknown>)
    : {};
}

/**
 * Finds the legacy `plugin` array property of the config root (or undefined).
 *
 * @param root - Config root node.
 * @returns The array node, or undefined when absent/not an array.
 */
function findLegacyPluginArray(root: Node): Node | undefined {
  return arrayProperty(root, 'plugin');
}

/** Returns an array property of an object node (or undefined). */
function arrayProperty(root: Node, name: string): Node | undefined {
  if (root.type !== 'object') {
    throw new ConfigEditError('config root must be an object');
  }
  const prop = childrenOf(root).find(
    (node) => node.type === 'property' && node.children?.[0]?.value === name,
  );
  const value = prop?.children?.[1];
  return value?.type === 'array' ? value : undefined;
}

/** Reads the string elements of an array node. */
function stringValuesOf(node: Node | undefined): string[] {
  if (node?.type !== 'array' || node.children === undefined) {
    return [];
  }
  return node.children
    .filter((element) => element.type === 'string' && typeof element.value === 'string')
    .map((element) => element.value as string);
}

/**
 * Reads a `plugins` option value as source strings.
 *
 * The option accepts a single string or an array (§3.1); a string value is
 * one source.
 *
 * @param node - The `plugins` value node, or undefined.
 * @returns The source strings found.
 */
function sourceValuesOf(node: Node | undefined): string[] {
  if (node?.type === 'string' && typeof node.value === 'string') {
    return [node.value];
  }
  return stringValuesOf(node);
}

/** Returns the child nodes of a node. */
function childrenOf(node: Node): Node[] {
  return node.children ?? [];
}
