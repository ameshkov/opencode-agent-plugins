/**
 * Update check and apply (`docs/explanation/cli-lifecycle.md`).
 *
 * `check` is read-only and network-only: it resolves the recorded ref
 * remotely and compares with the recorded commit. `update` re-fetches into a
 * staging dir, runs the full validation pipeline on the staged copy (all
 * failure modes are caught before anything live is touched), then swaps it
 * into place atomically with an `.old-<slug>` rollback. `PLUGIN_DATA` is
 * never touched. The staged swap lives in `update-swap.ts`; target selection
 * and path-source statuses live in `update-sources.ts`.
 */

import { resolveRemoteRef } from './git.js';
import type { ConfigScope } from './config-file.js';
import { listInstalled, readMeta, type StoreEntry } from './store.js';
import { resolveUpdateTargets, pathSourceStatuses } from './update-sources.js';
import { swapUpdate } from './update-swap.js';
import {
  movedTagStatus,
  short,
  statusFor,
  unreachableStatus,
  type UpdateStatus,
} from './update-status.js';

export type { UpdateStatus } from './update-status.js';
export { UpdateTargetError } from './update-sources.js';

/**
 * Runs the read-only update check over installed plugins.
 *
 * Names resolve through the store: an exact slug first, then a manifest
 * name. A name that matches no entry (and no configured path source) is an
 * error, not an empty result.
 *
 * @param names - Filter by slug or manifest name; empty = all.
 * @param configScope - Config scope, also scanned for path-sourced plugins
 * (reported as "local path — update by editing the source").
 * @param env - Environment view for store-root resolution.
 * @returns One status record per relevant source.
 * @throws {UpdateTargetError} When a name matches no entry or several entries.
 */
export async function runCheck(
  names: string[],
  configScope: ConfigScope,
  env: Record<string, string | undefined> = process.env,
): Promise<UpdateStatus[]> {
  const targets = await resolveUpdateTargets(names, configScope, env);
  const statuses = (await checkStoreStatuses(env)).filter(
    (status) => names.length === 0 || targets.slugs.includes(status.slug),
  );
  statuses.push(
    ...(await pathSourceStatuses(
      configScope,
      names.length === 0 ? null : targets.pathSources,
      env,
    )),
  );
  return statuses;
}

/**
 * Computes the update status of every installed store entry (read-only,
 * network-only for non-SHA refs).
 *
 * This is the shared engine behind `check` and `list` (cli-lifecycle.md):
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

/**
 * Applies available updates.
 *
 * Only drifting head/branch refs are updated (tag moves require `--force`,
 * SHA pins are no-ops). Each update is staged, validated, and swapped
 * atomically; `PLUGIN_DATA` survives. Failures leave the previous install
 * untouched.
 *
 * @param names - Filter by slug or manifest name; empty = all.
 * @param configScope - Config scope (path sources are skipped).
 * @param options.force - Follow a moved tag.
 * @param options.env - Environment view for store-root resolution.
 * @returns One status record per relevant store entry.
 * @throws {UpdateTargetError} When a name matches no entry or several entries.
 */
export async function applyUpdates(
  names: string[],
  configScope: ConfigScope,
  options: { force?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<UpdateStatus[]> {
  const env = options.env ?? process.env;
  const targets = await resolveUpdateTargets(names, configScope, env);
  const statuses: UpdateStatus[] = [];
  for (const entry of await listInstalled(env)) {
    if (names.length > 0 && !targets.slugs.includes(entry.slug)) {
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
