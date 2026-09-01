/**
 * Client data directory management (`docs/design.md` §5.8).
 *
 * The client keeps its managed data under
 * `<data-home>/opencode/agent-plugins/` (`data-home` follows opencode's own
 * convention: `$XDG_DATA_HOME`, then `~/.local/share`, `%LOCALAPPDATA%` on
 * Windows). `PLUGIN_DATA` lives at `data/<key>/` **outside** the installed
 * tree so it survives updates and is only removed by the CLI.
 */

import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** Environment view (injectable for tests). */
export type EnvLike = Record<string, string | undefined>;

/** Resolves the data home per the opencode convention. */
/** @internal Exported for tests only; not part of the public module API. */
export function dataHome(env: EnvLike = process.env): string {
  const xdg = env['XDG_DATA_HOME'];
  if (xdg !== undefined && xdg !== '') {
    return xdg;
  }
  if (platform() === 'win32' && env['LOCALAPPDATA'] !== undefined && env['LOCALAPPDATA'] !== '') {
    return env['LOCALAPPDATA'];
  }
  return join(homedir(), '.local', 'share');
}

/** Root of the agent-plugins client store. */
/** @internal Exported for tests only; not part of the public module API. */
export function storeRoot(env: EnvLike = process.env): string {
  return join(dataHome(env), 'opencode', 'agent-plugins');
}

/** Directory of a store subsection (`installed`, `meta`, `data`, `backups`). */
export function storeDir(kind: string, env: EnvLike = process.env): string {
  return join(storeRoot(env), kind);
}

/** Path of the `PLUGIN_DATA` directory for a data key (not created). */
export function dataDirForKey(key: string, env: EnvLike = process.env): string {
  return join(storeDir('data', env), key);
}

/**
 * Ensures the `PLUGIN_DATA` directory for a key exists and is writable.
 *
 * Called during registration only when the plugin has at least one valid
 * stdio server (the spec requires the directory to exist before any
 * subprocess launch). The returned path is realpath-resolved so containment
 * checks on it stay deterministic.
 *
 * @param key - Data key (`<slug>` or `<name>-<hash8>`).
 * @param env - Environment view for store-root resolution.
 * @returns The absolute, filesystem-resolved data dir path.
 */
export async function ensureDataDir(key: string, env: EnvLike = process.env): Promise<string> {
  const dir = dataDirForKey(key, env);
  await mkdir(dir, { recursive: true });
  return realpath(dir);
}

/**
 * Computes the data key for a path-sourced plugin: `<name>-<hash8>`.
 *
 * `hash8` is the first 8 hex chars of the SHA-256 of the plugin root
 * (realpathed — identity is the hash, the name is a debugging hint only, and
 * a renamed plugin keeps its data via the hash).
 *
 * @param pluginRoot - Absolute, realpathed plugin root.
 * @param manifestName - Plugin name from the manifest.
 * @returns The data key for the plugin instance.
 */
export function dataKeyForPath(pluginRoot: string, manifestName: string): string {
  const hash = createHash('sha256').update(pluginRoot).digest('hex').slice(0, 8);
  return `${manifestName}-${hash}`;
}

/**
 * Computes the data key for a git-sourced plugin: the store slug (stable
 * across plugin renames since the slug comes from the URL).
 *
 * @param slug - Store slug of the git source.
 * @returns The data key.
 */
export function dataKeyForSlug(slug: string): string {
  return slug;
}
