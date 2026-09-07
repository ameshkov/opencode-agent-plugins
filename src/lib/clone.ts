/**
 * Tree staging from git sources (`docs/design.md` §5.12.1, §5.3.2).
 *
 * The clone strategy is shallow-first at the resolved commit: `--depth 1`
 * where the transport allows fetching the resolved SHA, falling back to a
 * shallow clone at the named ref, and finally a full clone + checkout of the
 * commit. Staged trees are exported (`.git` removed at install time).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFullSha, runGit, toGitCliUrl } from './git.js';

/**
 * Stages a plugin tree at `commit` (exported copy, `.git` removed, §5.3.2).
 *
 * The clone is tried shallow-first (§5.12.1): `--depth 1` at the resolved
 * commit where the transport allows a raw-SHA fetch, then at the named ref,
 * then a full clone + checkout. The tree always lands on `commit` (the
 * `ls-remote` result), so the recorded `resolvedCommit` and the installed
 * tree cannot disagree.
 *
 * @param url - Normalized git URL (no `git+` prefix).
 * @param ref - Recorded ref (branch/tag/SHA); undefined = remote HEAD. Used
 * only by the named-ref shallow fallback.
 * @param commit - Commit resolved by `ls-remote` that the tree must land on.
 * @returns The staged tree directory, or a failure message.
 */
export async function stageTree(
  url: string,
  ref: string | undefined,
  commit: string,
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-agent-plugins-'));
  const result = await cloneInto(url, ref, commit, dir);
  if (!result.ok) {
    await rm(dir, { recursive: true, force: true });
    return { ok: false, error: result.error };
  }
  await rm(join(dir, '.git'), { recursive: true, force: true });
  return { ok: true, dir };
}

/** Result of the clone strategy chain. */
type CloneResult = { ok: boolean; error: string };

/**
 * Clones `url` into `dir`, landing on `commit` with the shallow-first chain:
 *
 * 1. Shallow at the resolved commit: `init` + `fetch --depth 1 <commit>` +
 *    `checkout`. Smart transports that allow raw-SHA wants (GitHub, local
 *    `file://` remotes) hit this.
 * 2. Shallow at the named ref (`clone --depth 1 --branch <ref>`, or
 *    `clone --depth 1` for HEAD), then `checkout <commit>` — transports that
 *    allow ref names but not raw SHA wants. If the ref moved after
 *    resolution, the commit is absent from the shallow history and the
 *    attempt falls through.
 * 3. Full clone + `checkout <commit>` — covers raw SHA pins the transport
 *    cannot fetch and remotes with an unset default branch.
 *
 * @internal Exported for tests only so the shallow/full fallback chain can be
 * asserted (stageTree strips `.git` before returning); not part of the public
 * module API.
 */
export async function cloneInto(
  url: string,
  ref: string | undefined,
  commit: string,
  dir: string,
): Promise<CloneResult> {
  const cliUrl = toGitCliUrl(url);

  const shallow = await shallowAtCommit(cliUrl, commit, dir);
  if (shallow.ok) {
    return { ok: true, error: '' };
  }
  await resetDir(dir);

  if (ref !== undefined && !isFullSha(ref)) {
    const named = await shallowAtRef(cliUrl, ref, dir);
    if (named.ok && (await checkoutCommit(dir, commit))) {
      return { ok: true, error: '' };
    }
    await resetDir(dir);
  } else if (ref === undefined) {
    const head = await shallowAtHead(cliUrl, dir);
    if (head.ok && (await checkoutCommit(dir, commit))) {
      return { ok: true, error: '' };
    }
    await resetDir(dir);
  }

  return fullCloneAt(cliUrl, ref, commit, dir);
}

/** Shallow-clones at a resolved commit: init + fetch SHA + checkout. */
async function shallowAtCommit(cliUrl: string, commit: string, dir: string): Promise<CloneResult> {
  const init = await runGit(['init', '--quiet', dir]);
  if (!init.ok) {
    return { ok: false, error: init.stderr };
  }
  const remote = await runGit(['-C', dir, 'remote', 'add', 'origin', cliUrl]);
  if (!remote.ok) {
    return { ok: false, error: remote.stderr };
  }
  const fetch = await runGit(['-C', dir, 'fetch', '--quiet', '--depth', '1', 'origin', commit]);
  if (!fetch.ok) {
    return { ok: false, error: fetch.stderr };
  }
  const checkout = await runGit(['-C', dir, 'checkout', '--quiet', commit]);
  return checkout.ok ? { ok: true, error: '' } : { ok: false, error: checkout.stderr };
}

/** Shallow-clones at a named branch/tag ref. */
async function shallowAtRef(cliUrl: string, ref: string, dir: string): Promise<CloneResult> {
  const result = await runGit(['clone', '--quiet', '--depth', '1', '--branch', ref, cliUrl, dir]);
  return result.ok ? { ok: true, error: '' } : { ok: false, error: result.stderr };
}

/** Shallow-clones at the remote HEAD. */
async function shallowAtHead(cliUrl: string, dir: string): Promise<CloneResult> {
  const result = await runGit(['clone', '--quiet', '--depth', '1', cliUrl, dir]);
  return result.ok ? { ok: true, error: '' } : { ok: false, error: result.stderr };
}

/**
 * Checks out a commit in an existing clone.
 *
 * @returns True when the checkout succeeded.
 */
async function checkoutCommit(dir: string, commit: string): Promise<boolean> {
  const checkout = await runGit(['-C', dir, 'checkout', '--quiet', commit]);
  return checkout.ok;
}

/** Removes a partial clone directory so the next attempt starts clean. */
async function resetDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Full-clones and checks out the resolved commit (final fallback). */
async function fullCloneAt(
  cliUrl: string,
  ref: string | undefined,
  commit: string,
  dir: string,
): Promise<CloneResult> {
  const full = await runGit(['clone', '--quiet', cliUrl, dir]);
  if (!full.ok) {
    return { ok: false, error: full.stderr };
  }
  const checkout = await runGit(['-C', dir, 'checkout', '--quiet', commit]);
  if (checkout.ok) {
    return { ok: true, error: '' };
  }
  // The resolved commit may be unreachable in the clone (ref moved or deleted
  // between `ls-remote` and the clone): fall back to the recorded ref name.
  if (ref !== undefined && !isFullSha(ref)) {
    const checkoutRef = await runGit(['-C', dir, 'checkout', '--quiet', ref]);
    if (checkoutRef.ok) {
      return { ok: true, error: '' };
    }
  }
  return { ok: false, error: checkout.stderr };
}
