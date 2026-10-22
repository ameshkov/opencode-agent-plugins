/**
 * Client store directory management (`docs/explanation/sources.md`).
 *
 * The client keeps its managed data under
 * `<config-dir>/opencode-agent-plugins/`, where `<config-dir>` is OpenCode's
 * config directory: `$OPENCODE_CONFIG_DIR` when set, else
 * `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode` (OpenCode uses the
 * same path on Windows). `PLUGIN_DATA` lives at `data/<key>/` **outside** the
 * installed tree so it survives updates and is only removed by the CLI.
 */

import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Environment view (injectable for tests). */
export type EnvLike = Record<string, string | undefined>;

/**
 * Resolves the XDG config home.
 *
 * @param env - Environment view for the lookup.
 * @returns `$XDG_CONFIG_HOME` when set, else `~/.config`.
 */
/** @internal Exported for tests only; not part of the public module API. */
export function configHome(env: EnvLike = process.env): string {
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg !== '') {
    return xdg;
  }
  return join(homedir(), '.config');
}

/**
 * Resolves OpenCode's config directory.
 *
 * `$OPENCODE_CONFIG_DIR` replaces the whole directory, exactly as OpenCode
 * does. Otherwise the `opencode` app directory under the XDG config home is
 * used.
 *
 * @param env - Environment view for the lookup.
 * @returns The absolute OpenCode config directory.
 */
export function configDir(env: EnvLike = process.env): string {
  const override = env['OPENCODE_CONFIG_DIR'];
  if (override !== undefined && override !== '') {
    return override;
  }
  return join(configHome(env), 'opencode');
}

/** Root of the agent-plugins client store. */
/** @internal Exported for tests only; not part of the public module API. */
export function storeRoot(env: EnvLike = process.env): string {
  return join(configDir(env), 'opencode-agent-plugins');
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
 * Computes the `hash8` suffix that identifies a path-sourced plugin instance.
 *
 * `hash8` is the first 8 hex chars of the SHA-256 of the plugin root
 * (realpathed). {@link dataKeyForPath} appends it to the manifest name, and
 * `doctor` uses it to protect a configured path source's data directory even
 * when the manifest is unreadable.
 *
 * @param pluginRoot - Absolute, realpathed plugin root.
 * @returns The eight-character instance hash.
 */
export function pathDataHash(pluginRoot: string): string {
  return createHash('sha256').update(pluginRoot).digest('hex').slice(0, 8);
}

/**
 * Computes the data key for a path-sourced plugin: `<name>-<hash8>`.
 *
 * The key is `<manifest-name>-<hash8>`: the hash identifies the instance, but
 * the name is part of the key, so a manifest rename changes the key and starts
 * a fresh data dir. `doctor` protects both dirs by the shared hash suffix while
 * the source stays configured.
 *
 * @param pluginRoot - Absolute, realpathed plugin root.
 * @param manifestName - Plugin name from the manifest.
 * @returns The data key for the plugin instance.
 */
export function dataKeyForPath(pluginRoot: string, manifestName: string): string {
  return `${manifestName}-${pathDataHash(pluginRoot)}`;
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
