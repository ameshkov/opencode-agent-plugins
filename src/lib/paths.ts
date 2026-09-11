/**
 * Path containment and placeholder expansion (`docs/design.md` §5.5).
 *
 * The Agent Plugins spec requires a filesystem-resolved package boundary:
 * every package path the client touches must resolve inside the plugin root,
 * and only `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` may be expanded, only in
 * `args`/`env` values and `cwd` — never in `command`, `url`, header names or
 * env keys. This module is the single implementation of those rules, shared
 * by manifest, skills, MCP and CLI code paths.
 */

import * as path from 'node:path';

/**
 * Result of resolving a path-ish value against an anchor.
 *
 * The failure variant carries a stable discriminator: `escape` for true
 * containment violations (post-resolution path leaves the anchor) and
 * `invalid` for values that are not in an allowed form at all. Callers use
 * the discriminator to classify the violation in the failure taxonomy
 * (`path-escape` vs. the generic server `server-invalid`), while `reason`
 * stays the human-readable message.
 */
export type PathResult =
  { ok: true; path: string } | { ok: false; kind: 'escape' | 'invalid'; reason: string };

/** The two placeholders recognized by the spec. */
/** @internal Exported for tests only; not part of the public module API. */
export const PLACEHOLDER_ROOT = '${PLUGIN_ROOT}';
/** @internal Exported for tests only; not part of the public module API. */
export const PLACEHOLDER_DATA = '${PLUGIN_DATA}';

/**
 * Expands the two recognized placeholders textually, in a single pass.
 *
 * `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` are replaced with the provided absolute
 * paths; any other `${...}`-shaped text is left untouched (the spec says
 * unrecognized placeholder-like text stays literal). The replacement is not
 * recursive and never re-expands the inserted path.
 *
 * @param value - The string to expand.
 * @param root - Absolute realpathed plugin root (`PLUGIN_ROOT` value).
 * @param dataDir - Absolute plugin data dir (`PLUGIN_DATA` value).
 * @returns The expanded string.
 */
export function expandPlaceholders(value: string, root: string, dataDir: string): string {
  return value.split(PLACEHOLDER_ROOT).join(root).split(PLACEHOLDER_DATA).join(dataDir);
}

/**
 * Checks whether `target` is `anchor` itself or a descendant of it.
 *
 * The comparison is textual (`path.relative`, case-folded on Windows), so
 * callers that need symlink safety realpath both sides first.
 *
 * @param anchor - Absolute anchor directory.
 * @param target - Path to test.
 * @returns True when the target is inside the anchor.
 */
export function isInside(anchor: string, target: string): boolean {
  const rel = path.relative(
    process.platform === 'win32' ? anchor.toLowerCase() : anchor,
    process.platform === 'win32' ? target.toLowerCase() : target,
  );
  if (rel === '') {
    return true;
  }
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** @internal Exported for tests only; not part of the public module API. */
export function expandGeneric(value: string, root: string, dataDir: string): string {
  return expandPlaceholders(value, root, dataDir);
}

/**
 * Resolves a `command` token against the plugin root.
 *
 * A command must be a single token. It is either a bare executable name
 * (path search is the host's job, returned unchanged) or a plugin-relative
 * `./...` path that must stay inside the root. Absolute paths and paths
 * escaping the root are rejected, and no placeholder expansion happens.
 *
 * @param command - The command token from `mcp.json`.
 * @param root - Absolute plugin root.
 * @returns The resolved command, or a failure with a kind (`escape` when the
 * path leaves the root) and a reason.
 */
export function resolveCommand(command: string, root: string): PathResult {
  if (/\s/.test(command)) {
    return { ok: false, kind: 'invalid', reason: 'command must be a single executable token' };
  }
  if (path.isAbsolute(command)) {
    return {
      ok: false,
      kind: 'invalid',
      reason: 'command may be a bare executable or ./… only',
    };
  }
  if (command.startsWith('./') || command.startsWith('.\\')) {
    const resolved = path.resolve(root, command);
    if (!isInside(root, resolved)) {
      return { ok: false, kind: 'escape', reason: `command ${command} escapes the plugin root` };
    }
    return { ok: true, path: resolved };
  }
  if (command.startsWith('../') || command.startsWith('..\\')) {
    return { ok: false, kind: 'escape', reason: `command ${command} escapes the plugin root` };
  }
  return { ok: true, path: command };
}

/**
 * Resolves a `cwd` value against the plugin root / data dir.
 *
 * Allowed forms (after expansion): `./...`, `${PLUGIN_ROOT}...`,
 * `${PLUGIN_DATA}...`. The value is expanded first, then resolved against the
 * anchor indicated by the expanded prefix, and the result must stay inside
 * that anchor. `undefined` means the plugin root (the spec default).
 *
 * @param cwd - The `cwd` value from `mcp.json`, or undefined for default.
 * @param root - Absolute plugin root.
 * @param dataDir - Absolute plugin data dir.
 * @returns The resolved absolute cwd, or a failure with a kind (`escape` when
 * the path leaves its anchor) and a reason.
 */
export function resolveCwd(cwd: string | undefined, root: string, dataDir: string): PathResult {
  if (cwd === undefined || cwd === '') {
    return { ok: true, path: root };
  }
  // Unknown placeholder-shaped text stays literal server-side; it then fails
  // the allowed-forms check below rather than being mis-anchored.
  const expanded = expandPlaceholders(cwd, root, dataDir);
  const anchor =
    expanded === root || expanded.startsWith(root + path.sep)
      ? root
      : expanded === dataDir || expanded.startsWith(dataDir + path.sep)
        ? dataDir
        : expanded.startsWith('./') || expanded.startsWith('.\\')
          ? root
          : null;
  if (anchor === null) {
    return {
      ok: false,
      kind: 'invalid',
      reason:
        'cwd must be a plugin-relative path (./…), ${PLUGIN_ROOT}-based, ' +
        'or ${PLUGIN_DATA}-based',
    };
  }
  const resolved = path.resolve(anchor, expanded);
  if (!isInside(anchor, resolved)) {
    return { ok: false, kind: 'escape', reason: `cwd ${cwd} escapes its directory` };
  }
  return { ok: true, path: resolved };
}
