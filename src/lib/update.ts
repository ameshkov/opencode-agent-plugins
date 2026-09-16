/**
 * Update check and apply (`docs/explanation/design.md` §5.12.3).
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
import { resolveRemoteRef } from './git.js';
import { resolveStagedRoot, stageTree } from './clone.js';
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
import { validatePluginTree, type ValidatedPlugin } from './validate.js';
import {
  movedTagStatus,
  short,
  statusFor,
  unreachableStatus,
  type UpdateStatus,
} from './update-status.js';

export type { UpdateStatus } from './update-status.js';

/**
 * Detail shown when a staged update fails validation and the previous install
 * is kept; the subdir branch appends the resolver error in parentheses.
 */
const VALIDATION_FAILED_DETAIL = 'new version fails validation; kept previous install';

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
  const statuses = (await checkStoreStatuses(env)).filter(
    (status) => names.length === 0 || names.includes(status.slug),
  );
  statuses.push(...(await pathSourceStatuses(configScope, names)));
  return statuses;
}

/**
 * Computes the update status of every installed store entry (read-only,
 * network-only for non-SHA refs).
 *
 * This is the shared engine behind `check` and `list` (§5.11/§5.12.3):
 * `check` additionally reports path-sourced plugins, `list` renders the
 * same statuses as its status column. Without `git`/network the recorded
 * ref cannot be resolved and the entry is reported as `unreachable` — the
 * command still completes.
 *
 * @param env - Environment view for store-root resolution.
 * @returns One status record per store entry.
 */
export async function checkStoreStatuses(
  env: Record<string, string | undefined> = process.env,
): Promise<UpdateStatus[]> {
  const statuses: UpdateStatus[] = [];
  for (const entry of await listInstalled(env)) {
    statuses.push(await checkEntry(entry));
  }
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
    return unreachableStatus(entry.slug, meta, resolvedRef.error);
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
      ? movedTagStatus(entry.slug, meta)
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
  const resolvedPath = await resolveConfigFile(configScope);
  const text = await readFile(resolvedPath.path, 'utf8').catch(() => null);
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
      statuses.push(unreachableStatus(entry.slug, meta, resolvedRef.error));
      continue;
    }
    const moved = resolvedRef.commit !== meta.resolvedCommit;
    if (!moved || resolvedRef.kind === 'sha') {
      statuses.push(statusFor(entry.slug, meta, 'up-to-date'));
      continue;
    }
    if (resolvedRef.kind === 'tag' && !options.force) {
      statuses.push(movedTagStatus(entry.slug, meta));
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
  const staged = await stageValidatedUpdate(slug, meta, newCommit, env);
  if (!staged.ok) {
    return staged.status;
  }
  try {
    await swapIntoPlace(staged.root, slug, env);
  } catch (error) {
    await rm(staged.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    return statusFor(
      slug,
      meta,
      'corrupted',
      error instanceof Error ? error.message : String(error),
    );
  }
  await rm(staged.stagingDir, { recursive: true, force: true }).catch(() => undefined);
  await writeMeta(
    slug,
    {
      ...meta,
      resolvedCommit: newCommit,
      manifestVersion: staged.validated.manifest.version,
      installedAt: new Date().toISOString(),
    },
    env,
  );
  // The detail carries the design's "updated <name> to <version> (commit …)"
  // message payload; the CLI appends the restart note (§5.12.3).
  const version =
    staged.validated.manifest.version === undefined ? '' : ` ${staged.validated.manifest.version}`;
  return statusFor(
    slug,
    meta,
    'update-available',
    `${staged.validated.manifest.name}${version} (commit ${short(newCommit)})`,
  );
}

/**
 * Stages the update tree and validates it: resolves the recorded ref, derives
 * the recorded subdir root (§5.3.4), and runs the full pipeline. Every
 * failure returns a status with the previous install untouched.
 */
async function stageValidatedUpdate(
  slug: string,
  meta: StoreMeta,
  newCommit: string,
  env: Record<string, string | undefined>,
): Promise<
  | { ok: true; root: string; stagingDir: string; validated: ValidatedPlugin }
  | { ok: false; status: UpdateStatus }
> {
  const staged = await stageTree(meta.url, meta.ref, newCommit);
  if (!staged.ok) {
    return { ok: false, status: unreachableStatus(slug, meta, staged.error) };
  }
  const derived = await resolveStagedRoot(staged.dir, meta.subdir);
  if (!derived.ok) {
    await rm(staged.dir, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      status: statusFor(slug, meta, 'corrupted', `${VALIDATION_FAILED_DETAIL} (${derived.error})`),
    };
  }
  const validated = await validatePluginTree(derived.root, dataDirForKey(slug, env));
  if (validated.fatal) {
    await rm(staged.dir, { recursive: true, force: true }).catch(() => undefined);
    return {
      ok: false,
      status: statusFor(slug, meta, 'corrupted', VALIDATION_FAILED_DETAIL),
    };
  }
  return { ok: true, root: derived.root, stagingDir: staged.dir, validated };
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
  // The new tree is live: `.old-<slug>` is throwaway now, so a failed cleanup
  // must not report the completed swap as failed. `doctor`/`prune` reap any
  // stray `.old-*` leftovers (§5.11, §5.12.3).
  await rm(old, { recursive: true, force: true }).catch(() => undefined);
}

/** Checks whether a name filter selects this entry. */
function selectedEntry(entry: StoreEntry, names: string[]): boolean {
  return names.some((name) => name === entry.slug);
}
