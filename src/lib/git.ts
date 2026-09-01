/**
 * Git operations for the CLI (`docs/design.md` §5.12).
 *
 * `git` is required only by git-backed commands (`install` from a URL,
 * `check`, `update`) and is checked lazily via {@link gitAvailable}. All
 * network access happens here — the plugin entry never touches it.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Result of running the `git` binary. */
type GitRunResult = { ok: true; stdout: string } | { ok: false; stderr: string };

/** Matches a full 40-hex commit SHA (pinned refs need no network). */
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Normalizes a git URL for the `git` CLI: strips the `git+` prefix that only
 * the config source grammar uses.
 *
 * @param url - Source URL as written in the config.
 * @returns The URL as `git` accepts it.
 */
function toGitCliUrl(url: string): string {
  return url.replace(/^git\+/, '');
}

/** Checks whether a ref is a full commit SHA. */
function isFullSha(ref: string): boolean {
  return FULL_SHA_RE.test(ref);
}

/**
 * Returns whether the `git` binary is usable.
 *
 * @returns True when `git --version` succeeds.
 */
export async function gitAvailable(): Promise<boolean> {
  const result = await runGit(['--version']);
  return result.ok;
}

/**
 * Runs `git` and captures stdout/stderr.
 *
 * @param args - Arguments passed to git (no shell).
 * @returns The result; a missing binary surfaces as `ok: false`.
 */
function runGit(args: string[]): Promise<GitRunResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      resolveResult({ ok: false, stderr: `failed to run git: ${error.message}` });
    });
    child.on('close', (code) => {
      resolveResult(code === 0 ? { ok: true, stdout } : { ok: false, stderr: stderr.trim() });
    });
  });
}

/** Kind of the resolved ref, used to decide update semantics. */
type ResolvedRefKind = 'head' | 'branch' | 'tag' | 'sha';

/** Result of { @link resolveRemoteRef }. */
export type ResolvedRemoteRef =
  { ok: true; commit: string; kind: ResolvedRefKind } | { ok: false; error: string };

/**
 * Resolves a git ref (or the remote HEAD) to a commit without cloning,
 * reporting whether the matched ref is a tag, a branch, or the remote HEAD.
 *
 * Annotated tags are dereferenced (`^{}`); a full 40-hex SHA is returned
 * without touching the network. HEAD resolution uses `--symref` first (smart
 * transports) and falls back to the unique head for transports that don't
 * advertise HEAD (local/file remotes), so `file://` test remotes work.
 *
 * @param url - Normalized git URL.
 * @param ref - Optional ref (branch/tag/SHA); undefined = remote HEAD.
 * @returns The resolved commit and kind, or a failure message.
 */
export async function resolveRemoteRef(url: string, ref?: string): Promise<ResolvedRemoteRef> {
  if (ref !== undefined && isFullSha(ref)) {
    return { ok: true, commit: ref, kind: 'sha' };
  }
  const cliUrl = toGitCliUrl(url);
  if (ref === undefined) {
    return resolveHead(cliUrl);
  }
  const target = [ref, `${ref}^{}`];
  const result = await runGit(['ls-remote', cliUrl, ...target]);
  if (!result.ok) {
    return { ok: false, error: result.stderr };
  }
  const picked = pickRemoteRef(result.stdout, ref);
  if (picked === null) {
    return { ok: false, error: `ref "${ref}" not found in remote` };
  }
  return { ok: true, commit: picked.commit, kind: kindOf(picked.name, ref) };
}

/** Resolves the remote HEAD with transport-specific fallbacks. */
async function resolveHead(cliUrl: string): Promise<ResolvedRemoteRef> {
  // Smart transports advertise `ref: refs/heads/<branch>\tHEAD` (+ a SHA line).
  const symref = await runGit(['ls-remote', '--symref', cliUrl, 'HEAD']);
  if (symref.ok) {
    const headLine = symref.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.endsWith('\tHEAD') && !l.startsWith('ref:'));
    if (headLine !== undefined) {
      return { ok: true, commit: headLine.split('\t')[0]!, kind: 'head' };
    }
    const refLine = symref.stdout
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('ref:') && l.endsWith('\tHEAD'));
    if (refLine !== undefined) {
      const branch = refLine.split(' ')[1];
      const branchResult = await runGit(['ls-remote', cliUrl, branch]);
      const picked = pickRemoteRef(branchResult.ok ? branchResult.stdout : '', branch);
      if (picked !== null) {
        return { ok: true, commit: picked.commit, kind: 'head' };
      }
    }
  }
  // Local/file remotes advertise no HEAD: fall back to the unique head.
  const heads = await runGit(['ls-remote', cliUrl, 'refs/heads/*']);
  if (heads.ok) {
    const lines = heads.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
      .map((l) => l.split('\t')[0]);
    if (lines.length === 1) {
      return { ok: true, commit: lines[0]!, kind: 'head' };
    }
  }
  return { ok: false, error: 'ref "HEAD" not found in remote' };
}

/** The chosen `ls-remote` entry: dereferenced refs win. */
interface RemoteRefEntry {
  commit: string;
  name: string;
}

/** Picks the dereferenced entry among `ls-remote` lines. */
function pickRemoteRef(output: string, pattern: string): RemoteRefEntry | null {
  const entries = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line): RemoteRefEntry => {
      const tab = line.indexOf('\t');
      return {
        commit: tab === -1 ? line : line.slice(0, tab),
        name: tab === -1 ? '' : line.slice(tab + 1),
      };
    });
  const deref = entries.find((entry) => entry.name.endsWith(`${pattern}^{}`));
  if (deref !== undefined) {
    return deref;
  }
  const exact = entries.find((entry) => entry.name === `refs/tags/${pattern}`);
  if (exact !== undefined) {
    return exact;
  }
  return entries[0] ?? null;
}

/** Classifies the matched ref name. */
function kindOf(name: string, ref: string | undefined): ResolvedRefKind {
  if (ref === undefined || name === 'HEAD') {
    return 'head';
  }
  if (name.startsWith('refs/tags/')) {
    return 'tag';
  }
  if (name.startsWith('refs/heads/')) {
    return 'branch';
  }
  return 'branch';
}

/** Kept for pre-existing callers of the simple commit resolution. */
export async function resolveRemoteCommit(
  url: string,
  ref?: string,
): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  const resolved = await resolveRemoteRef(url, ref);
  return resolved.ok ? { ok: true, commit: resolved.commit } : resolved;
}

/**
 * Stages a plugin tree (exported copy at the pinned ref, `.git` removed).
 *
 * `--depth 1` is used where the transport allows it; a raw commit SHA pin
 * (or a failed shallow/clone) falls back to a full clone + checkout. The
 * tree is then exported: `.git` is removed at install time (§5.3.2).
 *
 * @param url - Normalized git URL.
 * @param ref - Optional ref to check out (undefined = default HEAD).
 * @returns The staged tree directory, or a failure message.
 */
export async function stageTree(
  url: string,
  ref?: string,
): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-agent-plugins-'));
  const result = await cloneInto(url, ref, dir);
  if (!result.ok) {
    await rm(dir, { recursive: true, force: true });
    return { ok: false, error: result.error };
  }
  await rm(join(dir, '.git'), { recursive: true, force: true });
  return { ok: true, dir };
}

/** Clones `url` at `ref` into `dir`, with the depth/fallback strategy. */
async function cloneInto(
  url: string,
  ref: string | undefined,
  dir: string,
): Promise<{ ok: boolean; error: string }> {
  const cliUrl = toGitCliUrl(url);
  if (ref === undefined || isFullSha(ref)) {
    const result = await runGit(['clone', '--quiet', cliUrl, dir]);
    if (!result.ok) {
      return { ok: false, error: result.stderr };
    }
    if (ref !== undefined) {
      const checkout = await runGit(['-C', dir, 'checkout', '--quiet', ref]);
      if (!checkout.ok) {
        return { ok: false, error: checkout.stderr };
      }
    } else {
      // A remote without a resolvable HEAD (e.g. a local bare repo whose
      // default branch is unset) clones an empty tree — check out the unique
      // branch so the exported tree is usable.
      const head = await runGit(['-C', dir, 'rev-parse', '--verify', 'HEAD']);
      if (!head.ok) {
        const branches = await runGit([
          '-C',
          dir,
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/remotes/origin',
        ]);
        const first = branches.ok ? branches.stdout.trim().split('\n')[0] : undefined;
        if (first === undefined || first === '') {
          return { ok: false, error: 'remote has no resolvable branch to check out' };
        }
        const branch = first.replace(/^origin\//, '');
        const checkout = await runGit(['-C', dir, 'checkout', '--quiet', '-B', branch, first]);
        if (!checkout.ok) {
          return { ok: false, error: checkout.stderr };
        }
      }
    }
    return { ok: true, error: '' };
  }
  const shallow = await runGit(['clone', '--quiet', '--depth', '1', '--branch', ref, cliUrl, dir]);
  if (shallow.ok) {
    return { ok: true, error: '' };
  }
  const full = await runGit(['clone', '--quiet', cliUrl, dir]);
  if (!full.ok) {
    return { ok: false, error: full.stderr };
  }
  const checkout = await runGit(['-C', dir, 'checkout', '--quiet', ref]);
  return checkout.ok ? { ok: true, error: '' } : { ok: false, error: checkout.stderr };
}
