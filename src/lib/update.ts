/**
 * Update check and apply (`docs/design.md` §5.12.3).
 *
 * `check` is read-only and network-only: it resolves the recorded ref
 * remotely and compares with the recorded commit. `update` re-fetches into a
 * staging dir, runs the full validation pipeline on the staged copy (all
 * failure modes are caught before anything live is touched), then swaps it
 * into place atomically with an `.old-<slug>` rollback. `PLUGIN_DATA` is
 * never touched.
 */

import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRemoteRef, stageTree } from './git.js';
import { configSourcesOf, resolveConfigFile, type ConfigScope } from './config-file.js';
import { dataDirForKey } from './data.js';
import {
  installedRootFor,
  listInstalled,
  readMeta,
  writeMeta,
  type StoreEntry,
  type StoreMeta,
} from './store.js';
import { parseSource, type ParsedSource } from './resolve.js';
import { validatePluginTree } from './validate.js';

/** Outcome of one plugin in a `check` / `update` run. */
type UpdateStatusKind =
  | 'up-to-date'
  | 'update-available'
  | 'pinned'
  | 'moved-tag'
  | 'corrupted'
  | 'unreachable'
  | 'local-path';

/** Status of one plugin from a `check` / `update` run. */
export interface UpdateStatus {
  /** Store slug (or `path:<source>` for path sources). */
  slug: string;
  /** Original registered source string. */
  source: string;
  /** Recorded ref, if any. */
  ref?: string;
  /** Recorded commit. */
  installedCommit: string | null;
  /** Outcome. */
  status: UpdateStatusKind;
  /** Extra explanation (unreachable error, moved-tag hint, ...). */
  detail?: string;
}

/**
 * Runs the read-only update check over installed plugins.
 *
 * @param names - Filter by slug; empty = all.
 * @param configScope - Config scope, also scanned for path-sourced plugins
 * (reported as "local path — update by editing the source").
 * @param env - Environment view for store-root resolution.
 * @returns One status record per relevant source.
 */
export async function runCheck(
  names: string[],
  configScope: ConfigScope,
  env: Record<string, string | undefined> = process.env,
): Promise<UpdateStatus[]> {
  const statuses: UpdateStatus[] = [];
  for (const entry of await listInstalled(env)) {
    if (names.length > 0 && !selectedEntry(entry, names)) {
      continue;
    }
    statuses.push(await checkEntry(entry));
  }
  statuses.push(...(await pathSourceStatuses(configScope, names)));
  return statuses;
}

/** Produces the status of a single store entry. */
async function checkEntry(entry: StoreEntry): Promise<UpdateStatus> {
  if (entry.meta === null) {
    return { slug: entry.slug, source: entry.slug, installedCommit: null, status: 'corrupted' };
  }
  const meta = entry.meta;
  const resolvedRef = await resolveRemoteRef(meta.url, meta.ref);
  if (!resolvedRef.ok) {
    return {
      slug: entry.slug,
      source: meta.source,
      ref: meta.ref,
      installedCommit: meta.resolvedCommit,
      status: 'unreachable',
      detail: resolvedRef.error,
    };
  }
  const moved = resolvedRef.commit !== meta.resolvedCommit;
  const base = {
    slug: entry.slug,
    source: meta.source,
    ref: meta.ref,
    installedCommit: meta.resolvedCommit,
  };
  if (resolvedRef.kind === 'sha') {
    return {
      ...base,
      status: 'pinned' as const,
      detail: `pinned to ${short(meta.resolvedCommit)}`,
    };
  }
  if (resolvedRef.kind === 'tag') {
    return moved
      ? { ...base, status: 'moved-tag' as const, detail: 'tag moved; update requires --force' }
      : {
          ...base,
          status: 'up-to-date' as const,
          detail: `pinned at ${short(meta.resolvedCommit)}`,
        };
  }
  return moved ? { ...base, status: 'update-available' } : { ...base, status: 'up-to-date' };
}

/** Reports path-sourced plugins (update by editing the source). */
async function pathSourceStatuses(
  configScope: ConfigScope,
  names: string[],
): Promise<UpdateStatus[]> {
  const path = await resolveConfigFile(configScope);
  const text = await readFile(path, 'utf8').catch(() => null);
  if (text === null) {
    return [];
  }
  const out: UpdateStatus[] = [];
  for (const source of configSourcesOf(text)) {
    let parsed: ParsedSource;
    try {
      parsed = parseSource(source);
    } catch {
      // Malformed sources are surfaced by `doctor`; they are not path sources.
      continue;
    }
    if (parsed.kind !== 'path') {
      continue;
    }
    if (names.length > 0 && !names.includes(source)) {
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

/**
 * Applies available updates.
 *
 * Only drifting head/branch refs are updated (tag moves require `--force`,
 * SHA pins are no-ops). Each update is staged, validated, and swapped
 * atomically; `PLUGIN_DATA` survives. Failures leave the previous install
 * untouched.
 *
 * @param names - Filter by slug; empty = all.
 * @param configScope - Config scope (path sources are skipped).
 * @param options.force - Follow a moved tag.
 * @param options.env - Environment view for store-root resolution.
 * @returns One status record per relevant store entry.
 */
export async function applyUpdates(
  names: string[],
  configScope: ConfigScope,
  options: { force?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<UpdateStatus[]> {
  void configScope;
  const env = options.env ?? process.env;
  const statuses: UpdateStatus[] = [];
  for (const entry of await listInstalled(env)) {
    if (names.length > 0 && !selectedEntry(entry, names)) {
      continue;
    }
    const meta = await readMeta(entry.slug, env);
    if (meta === null) {
      statuses.push({
        slug: entry.slug,
        source: entry.slug,
        installedCommit: null,
        status: 'corrupted',
      });
      continue;
    }
    const resolvedRef = await resolveRemoteRef(meta.url, meta.ref);
    if (!resolvedRef.ok) {
      statuses.push(statusFor(entry.slug, meta, 'unreachable', resolvedRef.error));
      continue;
    }
    const moved = resolvedRef.commit !== meta.resolvedCommit;
    if (!moved || resolvedRef.kind === 'sha') {
      statuses.push(statusFor(entry.slug, meta, 'up-to-date'));
      continue;
    }
    if (resolvedRef.kind === 'tag' && !options.force) {
      statuses.push(statusFor(entry.slug, meta, 'moved-tag', 'tag moved; update requires --force'));
      continue;
    }
    statuses.push(await swapUpdate(entry.slug, meta, resolvedRef.commit, env));
  }
  return statuses;
}

/** Stages, validates and atomically swaps one update. */
async function swapUpdate(
  slug: string,
  meta: StoreMeta,
  newCommit: string,
  env: Record<string, string | undefined>,
): Promise<UpdateStatus> {
  const staged = await stageTree(meta.url, meta.ref);
  if (!staged.ok) {
    return statusFor(slug, meta, 'unreachable', staged.error);
  }
  const validated = await validatePluginTree(staged.dir, dataDirForKey(slug, env));
  if (validated.fatal) {
    await rm(staged.dir, { recursive: true, force: true });
    return statusFor(
      slug,
      meta,
      'corrupted',
      'new version fails validation; kept previous install',
    );
  }
  try {
    await swapIntoPlace(staged.dir, slug, env);
  } catch (error) {
    return statusFor(
      slug,
      meta,
      'corrupted',
      error instanceof Error ? error.message : String(error),
    );
  }
  await writeMeta(
    slug,
    {
      ...meta,
      resolvedCommit: newCommit,
      manifestVersion: validated.manifest.version,
      installedAt: new Date().toISOString(),
    },
    env,
  );
  // The detail carries the design's "updated <name> to <version> (commit …)"
  // message payload; the CLI appends the restart note (§5.12.3).
  const version = validated.manifest.version === undefined ? '' : ` ${validated.manifest.version}`;
  return statusFor(
    slug,
    meta,
    'update-available',
    `${validated.manifest.name}${version} (commit ${short(newCommit)})`,
  );
}

/** Builds a status record from metadata. */
function statusFor(
  slug: string,
  meta: StoreMeta,
  status: UpdateStatusKind,
  detail?: string,
): UpdateStatus {
  return {
    slug,
    source: meta.source,
    ...(meta.ref === undefined ? {} : { ref: meta.ref }),
    installedCommit: meta.resolvedCommit,
    status,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Swaps a staged tree into place with `.old-<slug>` rollback. */
async function swapIntoPlace(
  staged: string,
  slug: string,
  env: Record<string, string | undefined>,
): Promise<void> {
  const installed = installedRootFor(slug, env);
  const old = join(installed, '..', `.old-${slug}`);
  await mkdir(join(installed, '..'), { recursive: true });
  const exists = await stat(installed).catch(() => null);
  if (exists !== null) {
    await rename(installed, old);
  }
  try {
    await rename(staged, installed);
  } catch (error) {
    if (exists !== null) {
      await rename(old, installed);
    }
    throw error;
  }
  await rm(old, { recursive: true, force: true });
}

/** Checks whether a name filter selects this entry. */
function selectedEntry(entry: StoreEntry, names: string[]): boolean {
  return names.some((name) => name === entry.slug);
}

/** Shortens a commit SHA for display. */
function short(commit: string): string {
  return commit.slice(0, 12);
}
