/**
 * Staged swap of an update (`docs/explanation/cli-lifecycle.md`).
 *
 * `swapUpdate` stages the new tree, validates it, and swaps it into place
 * with an `.old-<slug>` rollback. A pre-existing `.old-<slug>` is a crash
 * leftover (doctor would prune it), so the swap removes it first. A failed
 * swap restores the live tree only when that tree was actually moved.
 */

import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveStagedRoot, stageTree } from './clone.js';
import { dataKeyForSlug } from './data.js';
import { moveTree, removeTree } from './move.js';
import { installedRootFor, writeMeta, type StoreMeta } from './store.js';
import { validatePluginTree, type ValidatedPlugin } from './validate.js';
import { short, statusFor, unreachableStatus, type UpdateStatus } from './update-status.js';

/**
 * Detail shown when a staged update fails validation and the previous install
 * is kept; the subdir branch appends the resolver error in parentheses.
 */
const VALIDATION_FAILED_DETAIL = 'new version fails validation; kept previous install';

/** Outcome of a swap attempt. */
type SwapResult = { ok: true } | { ok: false; moved: boolean; error: unknown };

/**
 * Stages, validates and atomically swaps one update.
 *
 * @param slug - Store slug of the entry.
 * @param meta - Current metadata of the entry.
 * @param newCommit - Commit to install.
 * @param env - Environment view for store-root resolution.
 * @returns The status of the update.
 */
export async function swapUpdate(
  slug: string,
  meta: StoreMeta,
  newCommit: string,
  env: Record<string, string | undefined>,
): Promise<UpdateStatus> {
  const staged = await stageValidatedUpdate(slug, meta, newCommit, env);
  if (!staged.ok) {
    return staged.status;
  }
  const installed = installedRootFor(slug, env);
  const old = join(installed, '..', `.old-${slug}`);
  const swapped = await swapIntoPlace(staged.root, slug, env);
  if (!swapped.ok) {
    if (swapped.moved) {
      await rollbackSwap(installed, old);
    }
    await removeTree(staged.stagingDir).catch(() => undefined);
    return statusFor(slug, meta, 'corrupted', messageOf(swapped.error));
  }
  try {
    await writeUpdateMeta(slug, meta, newCommit, staged.validated, env);
  } catch (error) {
    await rollbackSwap(installed, old);
    await removeTree(staged.stagingDir).catch(() => undefined);
    return statusFor(slug, meta, 'corrupted', messageOf(error));
  }
  // The new tree and its metadata are both live: `.old-<slug>` is throwaway
  // now, so a failed cleanup must not report the completed update as failed.
  // `doctor`/`prune` reap any stray `.old-*` leftovers (cli-lifecycle.md).
  await rm(old, { recursive: true, force: true }).catch(() => undefined);
  await removeTree(staged.stagingDir).catch(() => undefined);
  // The detail carries the "updated <name> to <version> (commit …)"
  // message payload; the CLI prints the reload outcome (cli-lifecycle.md).
  const version =
    staged.validated.manifest.version === undefined ? '' : ` ${staged.validated.manifest.version}`;
  return statusFor(
    slug,
    meta,
    'update-available',
    `${staged.validated.manifest.name}${version} (commit ${short(newCommit)})`,
  );
}

/** Writes the metadata of a swapped update. */
async function writeUpdateMeta(
  slug: string,
  meta: StoreMeta,
  newCommit: string,
  validated: ValidatedPlugin,
  env: Record<string, string | undefined>,
): Promise<void> {
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
}

/**
 * Stages the update tree and validates it: resolves the recorded ref, derives
 * the recorded subdir root (sources.md), and runs the full pipeline. Every
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
    await removeTree(staged.dir).catch(() => undefined);
    return {
      ok: false,
      status: statusFor(slug, meta, 'corrupted', `${VALIDATION_FAILED_DETAIL} (${derived.error})`),
    };
  }
  const validated = await validatePluginTree(derived.root, env, dataKeyForSlug(slug));
  if (validated.fatal) {
    await removeTree(staged.dir).catch(() => undefined);
    return {
      ok: false,
      status: statusFor(slug, meta, 'corrupted', VALIDATION_FAILED_DETAIL),
    };
  }
  return { ok: true, root: derived.root, stagingDir: staged.dir, validated };
}

/**
 * Swaps a staged tree into place and keeps `.old-<slug>` for rollback.
 *
 * A pre-existing `.old-<slug>` is a crash leftover: it is removed before the
 * first rename, so it can never fail the swap or be mistaken for the live
 * tree. The caller deletes `.old-<slug>` only after the metadata write
 * succeeds. A failed second rename restores the previous tree; the result
 * reports whether a restore left the previous tree in `.old-<slug>`.
 * Staged trees move through `move.ts`, which falls back to a copy on
 * `EXDEV`.
 *
 * @param staged - Staged plugin root to move into place.
 * @param slug - Store slug of the entry.
 * @param env - Environment view for store-root resolution.
 * @returns The swap result.
 */
async function swapIntoPlace(
  staged: string,
  slug: string,
  env: Record<string, string | undefined>,
): Promise<SwapResult> {
  const installed = installedRootFor(slug, env);
  const old = join(installed, '..', `.old-${slug}`);
  try {
    await mkdir(join(installed, '..'), { recursive: true });
    // A crash may leave `.old-<slug>` behind. It is not the live tree, and
    // doctor would prune it; remove it so the first rename cannot fail with
    // ENOTEMPTY.
    await rm(old, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, moved: false, error };
  }
  const exists = await stat(installed).catch(() => null);
  if (exists === null) {
    try {
      await moveTree(staged, installed);
      return { ok: true };
    } catch (error) {
      return { ok: false, moved: false, error };
    }
  }
  try {
    await rename(installed, old);
  } catch (error) {
    return { ok: false, moved: false, error };
  }
  try {
    await moveTree(staged, installed);
    return { ok: true };
  } catch (error) {
    const restored = await rename(old, installed).then(
      () => true,
      () => false,
    );
    return { ok: false, moved: !restored, error };
  }
}

/**
 * Restores the previous tree after a failed metadata write.
 *
 * Best-effort: a failed rollback is left for `doctor` to report rather than
 * replacing the original failure with a cleanup error.
 */
async function rollbackSwap(installed: string, old: string): Promise<void> {
  const exists = await stat(old).catch(() => null);
  if (exists === null) {
    return;
  }
  await rm(installed, { recursive: true, force: true }).catch(() => undefined);
  await rename(old, installed).catch(() => undefined);
}

/** Formats a thrown value for a status detail. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
