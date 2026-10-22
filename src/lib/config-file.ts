/**
 * Config file resolution and safe writes (`docs/explanation/cli-lifecycle.md`,
 * `docs/explanation/changes-and-reload.md`).
 *
 * The CLI registers/removes plugin sources by editing the OpenCode config
 * file; the JSONC-preserving array edits themselves live in
 * `src/lib/config-edit.ts`. This module owns locating the file
 * (`opencode.jsonc` preference), atomic writes, and backups — never a
 * `<config>.bak` next to the user's config.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseTree, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { configDir, storeDir, type EnvLike } from './data.js';
import { writeFileAtomic } from './store.js';

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
 * The location directory a config's relative path sources resolve against.
 *
 * Mirrors startup (`ctx.location.directory`): a project scope resolves
 * against its own cwd; the global and custom scopes use the process cwd.
 * `doctor`, `check`, and `update` share this rule so they agree on path
 * sources.
 *
 * @param scope - Config scope selected on the command line.
 * @returns The directory relative paths resolve against.
 */
export function locationDir(scope: ConfigScope): string {
  return scope.kind === 'project' ? scope.cwd : process.cwd();
}

/** The config file resolved for a scope. */
export interface ResolvedConfigFile {
  /** Absolute path of the config file to read or edit. */
  path: string;
  /**
   * True when `opencode.jsonc` was preferred over an existing `opencode.json`
   * in the target scope (cli-lifecycle.md) — the CLI announces this.
   */
  jsoncWins: boolean;
}

/**
 * Resolves the config file for a scope.
 *
 * For the project and global scopes `opencode.jsonc` wins over
 * `opencode.json` when both exist (cli-lifecycle.md — and the CLI says so); when
 * neither exists the default `opencode.json` path is returned (creation
 * happens on write). A `--config` path is returned verbatim.
 *
 * @param scope - Which config to target.
 * @param env - Environment view for the global config directory.
 * @returns The resolved config path and whether the `.jsonc` preference
 * applied.
 */
export async function resolveConfigFile(
  scope: ConfigScope,
  env: EnvLike = process.env,
): Promise<ResolvedConfigFile> {
  if (scope.kind === 'custom') {
    return { path: scope.path, jsoncWins: false };
  }
  const dir = scope.kind === 'global' ? configDir(env) : scope.cwd;
  return resolveConfigInDir(dir);
}

/**
 * Applies the `.jsonc`-wins preference inside one config directory (cli-lifecycle.md).
 *
 * @param dir - Config directory to inspect (project root or global config
 * dir).
 * @returns The resolved path and whether the `.jsonc` file won over `.json`.
 */
function resolveConfigInDir(dir: string): ResolvedConfigFile {
  const jsonc = join(dir, 'opencode.jsonc');
  const json = join(dir, 'opencode.json');
  if (existsSync(jsonc) && existsSync(json)) {
    return { path: jsonc, jsoncWins: true };
  }
  if (existsSync(jsonc)) {
    return { path: jsonc, jsoncWins: false };
  }
  return { path: json, jsoncWins: false };
}

/**
 * The CLI announcement for a `.jsonc`-preferred config (cli-lifecycle.md), or null when
 * the `.jsonc` file did not win.
 *
 * @param resolved - The resolved config file.
 * @returns The note to print, or null when nothing to say.
 */
export function configPreferenceNote(resolved: ResolvedConfigFile): string | null {
  if (!resolved.jsoncWins) {
    return null;
  }
  return `config: ${resolved.path} (opencode.jsonc wins over opencode.json)`;
}

/**
 * Reads a config file, distinguishing "does not exist" from "cannot be read".
 *
 * A missing config is normal (the CLI creates it on write); an unreadable one
 * must never be treated as empty, or the caller would overwrite content it
 * could not see.
 *
 * @param path - Absolute config file path.
 * @returns The file content, or null when the file does not exist.
 * @throws {ConfigEditError} When the file exists but cannot be read.
 */
export async function readConfigText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigEditError(`config exists but could not be read: ${message}`);
  }
}

/**
 * Validates, backs up and atomically writes an edited config file.
 *
 * The edited text must parse as JSONC (a CLI must never leave OpenCode with a
 * corrupt config); the previous content is backed up to the store's
 * `backups/` dir with a timestamped name, then the file is replaced via
 * temp + rename. A missing parent directory is created, so installing into a
 * config that does not exist yet works (the CLI creates `opencode.json`).
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
 * @throws {ConfigEditError} When the edit does not parse as JSONC, the file
 * changed on disk since the caller read it, or an existing file cannot be
 * read.
 */
export async function saveConfig(
  path: string,
  newText: string,
  env = process.env,
  expected?: string | null,
): Promise<{ backupPath: string | null }> {
  // Opencode parses with `allowTrailingComma: true` and rejects a document
  // only when its parser reports errors; mirror that so a write is refused
  // exactly when the host would refuse the config.
  const errors: ParseError[] = [];
  parseTree(newText, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new ConfigEditError(
      'refusing to write config: result does not parse ' +
        `(${printParseErrorCode(first.error)} at offset ${first.offset})`,
    );
  }
  const previous = await readConfigText(path);
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

/**
 * Formats a config-edit error into a user-facing message.
 *
 * @param error - The thrown value.
 * @returns The error message, or the stringified value.
 */
export function configError(error: unknown): string {
  if (error instanceof ConfigEditError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
