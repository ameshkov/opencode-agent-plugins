/**
 * Status records for `check` / `update` runs (`docs/explanation/design.md` §5.11/§5.12.3).
 *
 * Shared by the read-only check engine and the update swap path so both
 * surfaces report the same record shape and failure classifications.
 */

import { failure, type Failure } from './errors.js';
import type { StoreMeta } from './store.js';

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
  status:
    | 'up-to-date'
    | 'update-available'
    | 'pinned'
    | 'moved-tag'
    | 'corrupted'
    | 'unreachable'
    | 'local-path';
  /** Extra explanation (unreachable error, moved-tag hint, ...). */
  detail?: string;
  /**
   * Taxonomy classification of failure statuses (§6 rows 807-808):
   * `check-unreachable` for `unreachable`, `update-ref` for `moved-tag`.
   * Absent for statuses that are not failures.
   */
  failure?: Failure;
}

/**
 * Builds a status record from metadata.
 *
 * @param slug - Store slug.
 * @param meta - Recorded metadata.
 * @param status - Outcome kind.
 * @param detail - Optional human-readable explanation.
 * @param f - Optional taxonomy classification.
 * @returns The status record.
 */
export function statusFor(
  slug: string,
  meta: StoreMeta,
  status: UpdateStatus['status'],
  detail?: string,
  f?: Failure,
): UpdateStatus {
  return {
    slug,
    source: meta.source,
    ...(meta.ref === undefined ? {} : { ref: meta.ref }),
    installedCommit: meta.resolvedCommit,
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(f === undefined ? {} : { failure: f }),
  };
}

/** Taxonomy failure for the §6 `check-unreachable` row (remote unreachable). */
function unreachableFailure(slug: string, source: string, detail: string): Failure {
  return failure('check-unreachable', `remote unreachable: ${detail}`, { slug, source });
}

/** Taxonomy failure for the §6 `update-ref` row (moved tag, needs --force). */
function movedTagFailure(slug: string, source: string): Failure {
  return failure('update-ref', 'tag moved; update requires --force', { slug, source });
}

/**
 * Builds an `unreachable` status carrying its `check-unreachable`
 * classification.
 *
 * @param slug - Store slug.
 * @param meta - Recorded metadata.
 * @param detail - Remote error detail.
 * @returns The status record.
 */
export function unreachableStatus(slug: string, meta: StoreMeta, detail: string): UpdateStatus {
  return statusFor(
    slug,
    meta,
    'unreachable',
    detail,
    unreachableFailure(slug, meta.source, detail),
  );
}

/**
 * Builds a `moved-tag` status carrying its `update-ref` classification.
 *
 * @param slug - Store slug.
 * @param meta - Recorded metadata.
 * @returns The status record.
 */
export function movedTagStatus(slug: string, meta: StoreMeta): UpdateStatus {
  return statusFor(
    slug,
    meta,
    'moved-tag',
    'tag moved; update requires --force',
    movedTagFailure(slug, meta.source),
  );
}

/**
 * Shortens a commit SHA for display.
 *
 * @param commit - Full commit SHA.
 * @returns The first 12 characters.
 */
export function short(commit: string): string {
  return commit.slice(0, 12);
}
