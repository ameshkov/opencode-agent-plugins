/**
 * Check/update target selection and path-source statuses
 * (`docs/explanation/cli-lifecycle.md`).
 *
 * Names resolve through the client store (slug first, then manifest name),
 * matching `remove`. A configured path source can also be named in `check`;
 * it has no store entry and is updated by editing the source. Every other
 * unmatched name is an error, never an empty result.
 */

import { readFile } from 'node:fs/promises';
import { configSourcesOf } from './config-edit.js';
import { locationDir, resolveConfigFile, type ConfigScope } from './config-file.js';
import { findStoreEntry } from './store.js';
import { parseSource, resolveSource } from './resolve.js';
import type { UpdateStatus } from './update-status.js';

/** Raised when a check/update name matches no store entry or path source. */
export class UpdateTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpdateTargetError';
  }
}

/** Name filters resolved for `check`/`update`. */
export interface UpdateTargets {
  /** Store slugs selected by name (empty with no names). */
  slugs: string[];
  /** Configured path sources selected by name (they have no store entry). */
  pathSources: string[];
}

/**
 * Resolves name filters to store slugs and configured path sources.
 *
 * An exact slug wins, then a manifest name. A name that matches several
 * entries is refused, never guessed. A configured path source stays a path
 * filter. Anything else is an error: the caller must not report a silent
 * no-op for a name the user expected to update.
 *
 * @param names - Names from the command line; empty = all entries.
 * @param configScope - Config scope used to recognize path sources.
 * @param env - Environment view for store-root resolution.
 * @returns The resolved store slugs and path-source names.
 * @throws {UpdateTargetError} When a name matches no entry or several entries.
 */
export async function resolveUpdateTargets(
  names: string[],
  configScope: ConfigScope,
  env: Record<string, string | undefined>,
): Promise<UpdateTargets> {
  const targets: UpdateTargets = { slugs: [], pathSources: [] };
  for (const name of names) {
    const entries = await findStoreEntry(name, env);
    if (entries.length === 1) {
      targets.slugs.push(entries[0]!.slug);
      continue;
    }
    if (entries.length > 1) {
      const slugs = entries.map((entry) => entry.slug).join(', ');
      throw new UpdateTargetError(
        `"${name}" matches multiple store entries (${slugs}); use the slug`,
      );
    }
    if (await isConfiguredPathSource(name, configScope, env)) {
      targets.pathSources.push(name);
      continue;
    }
    throw new UpdateTargetError(
      `"${name}" is not installed in the client store ` +
        '(path-sourced plugins are updated by editing the config)',
    );
  }
  return targets;
}

/**
 * Reports path-sourced plugins (update by editing the source).
 *
 * A source is reported only when it resolves as a local path from the config
 * file's directory. An installed name or a git URL resolves to the store and
 * is not a path source; a missing path is reported by `doctor`, not here.
 *
 * @param configScope - Config scope that holds the sources.
 * @param names - Path-source names to report, or null for every path source.
 * @param env - Environment view for store-root resolution.
 * @returns One `local-path` status per selected path source.
 */
export async function pathSourceStatuses(
  configScope: ConfigScope,
  names: string[] | null,
  env: Record<string, string | undefined>,
): Promise<UpdateStatus[]> {
  const resolvedPath = await resolveConfigFile(configScope, env);
  const text = await readFile(resolvedPath.path, 'utf8').catch(() => null);
  if (text === null) {
    return [];
  }
  const workspaceDir = locationDir(configScope);
  const out: UpdateStatus[] = [];
  for (const source of configSourcesOf(text)) {
    if (names !== null && !names.includes(source)) {
      continue;
    }
    const resolved = await resolveSource(source, workspaceDir, env);
    if (!resolved.ok || resolved.source.kind !== 'path') {
      continue;
    }
    out.push({
      slug: `path:${source}`,
      source,
      installedCommit: null,
      status: 'local-path',
      detail: 'local path — update by editing the source',
    });
  }
  return out;
}

/** True when a name is a path source in the selected config. */
async function isConfiguredPathSource(
  name: string,
  configScope: ConfigScope,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const resolvedPath = await resolveConfigFile(configScope, env);
  const text = await readFile(resolvedPath.path, 'utf8').catch(() => null);
  if (text === null) {
    return false;
  }
  return configSourcesOf(text).some((source) => {
    if (source !== name) {
      return false;
    }
    try {
      return parseSource(source).kind === 'path';
    } catch {
      return false;
    }
  });
}
