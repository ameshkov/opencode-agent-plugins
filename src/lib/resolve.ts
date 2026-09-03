/**
 * Plugin source parsing and startup resolution (`docs/design.md` §5.3).
 *
 * Source grammar:
 *
 * ```text
 * <source>  := <local-path> | <git-url>["#"<ref>]
 * <git-url> := https://... | git+https://... | ssh://... | git+ssh://...
 *            | git@host:path (scp-like) | file://...
 * <ref>     := <branch> | <tag> | <commit-sha>
 * ```
 *
 * At startup only already-present sources are used: local paths in place,
 * git URLs/installed names against the client store. **Nothing is fetched**
 * — installing/updating is the CLI's job.
 */

import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Failure } from './errors.js';
import { failure } from './errors.js';
import { findStoreEntry, installedRootFor, readMeta, type StoreMeta } from './store.js';

/** A parsed git source URL (no `git+` prefix, no `#ref`). */
export interface GitSource {
  /** Normalized git URL. */
  url: string;
  /** Pinned ref (branch/tag/sha), when present. */
  ref?: string;
  /** Store slug derived from host/org/repo. */
  slug: string;
}

/** Result of source classification. */
export type ParsedSource =
  { kind: 'git'; raw: string; source: GitSource } | { kind: 'path'; raw: string };

/** A source resolved to a filesystem plugin root at startup. */
type ResolvedSource =
  | { kind: 'path'; raw: string; root: string }
  | { kind: 'git'; raw: string; source: GitSource; root: string; meta: StoreMeta };

/** Result of startup resolution. */
export type ResolveResult = { ok: true; source: ResolvedSource } | { ok: false; failure: Failure };

/**
 * Classifies a source string.
 *
 * Git URLs (https/ssh/scp-like, plus `file://` for local test remotes) with
 * an optional `#ref` become a git source; everything else is a local path.
 * Malformed refs are rejected with a thrown error before any network call.
 *
 * @param raw - The source string from the options.
 * @returns The classified source.
 * @throws {Error} When a git source carries a malformed `#ref`.
 */
export function parseSource(raw: string): ParsedSource {
  const trimmed = raw.trim();
  const scpLike = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(.*)$/.exec(trimmed);
  if (scpLike !== null) {
    return gitOf(trimmed, trimmed);
  }
  // `git+` prefixes wrap another scheme (`git+https://…`); normalize away.
  const normalized = trimmed.startsWith('git+') ? trimmed.replace(/^git\+/, '') : trimmed;
  const withScheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(normalized);
  if (withScheme !== null) {
    const scheme = withScheme[1]!.toLowerCase();
    if (isGitScheme(scheme)) {
      return gitOf(trimmed, normalized);
    }
  }
  return { kind: 'path', raw: trimmed };
}

/** Checks whether a URL scheme is a git transport. */
function isGitScheme(scheme: string): boolean {
  return (
    scheme === 'https' ||
    scheme === 'http' ||
    scheme === 'ssh' ||
    scheme === 'file' ||
    scheme === 'ssh+git'
  );
}

/** Builds a git source from a raw string and its URL. */
function gitOf(raw: string, urlBase: string): ParsedSource {
  const refIndex = urlBase.lastIndexOf('#');
  const url = refIndex === -1 ? urlBase : urlBase.slice(0, refIndex);
  const ref = refIndex === -1 ? undefined : urlBase.slice(refIndex + 1);
  if (ref !== undefined && !isValidRef(ref)) {
    throw new Error(`invalid git ref in source "${raw}"`);
  }
  return {
    kind: 'git',
    raw,
    source: { url, ...(ref === undefined ? {} : { ref }), slug: slugOf(url) },
  };
}

/** Validates a `#ref` before any network call. */
function isValidRef(ref: string): boolean {
  return ref !== '' && !/\s/.test(ref) && !/(\.\.|~|\^|\?|\*)/.test(ref);
}

/** @internal Exported for tests only; not part of the public module API. */
export function slugOf(url: string): string {
  const noScheme = url.replace(/^[a-z+]+:\/\//i, '').replace(/^[A-Za-z0-9._-]+@/, '');
  const colon = noScheme.indexOf(':');
  const pathPart = colon !== -1 ? noScheme.slice(colon + 1) : noScheme;
  const segments = pathPart
    .split(/[/\\]/)
    .map((s) =>
      s
        .replace(/\.git$/i, '')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-'),
    )
    .filter((s) => s !== '');
  const tail = segments.slice(-2);
  if (tail.length === 0) {
    return noScheme.toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'plugin';
  }
  return tail.join('-');
}

/**
 * Resolves a source to an existing plugin root (startup path, no network).
 *
 * - local path: `~/...` expanded, relative ones resolved against the
 *   workspace directory; `~user/...` is rejected (never mis-resolved); the
 *   path must exist and is realpath'd. A reference to an installed plugin
 *   name (non-URL, non-path) is resolved through the store.
 * - git URL: looked up in the client store by slug; missing → warn+skip
 *   failure, corrupted meta → error.
 * - malformed ref (`#ref` with whitespace, empty ref): reported as a
 *   failure, never thrown — the config hook must not throw (§5.1).
 *
 * @param raw - Source string.
 * @param workspaceDir - Workspace directory for relative paths.
 * @param env - Environment view for store-root resolution.
 * @returns The resolution result; never throws.
 */
export async function resolveSource(
  raw: string,
  workspaceDir: string,
  env = process.env,
): Promise<ResolveResult> {
  let parsed: ParsedSource;
  try {
    parsed = parseSource(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      failure: failure('source-missing', message, { source: raw, section: '§5.3.1' }),
    };
  }
  if (parsed.kind === 'git') {
    return resolveGitSource(raw, parsed.source, env);
  }
  return resolvePathOrName(raw, workspaceDir, env);
}

/** Resolves a git source against the client store (never fetches). */
async function resolveGitSource(
  raw: string,
  source: GitSource,
  env: Record<string, string | undefined>,
): Promise<ResolveResult> {
  const root = installedRootFor(source.slug, env);
  const exists = await stat(root).catch(() => null);
  if (exists === null || !exists.isDirectory()) {
    return {
      ok: false,
      failure: failure('source-missing', `source "${raw}" is not installed in the client store`, {
        source: raw,
        section: '§5.3.3',
      }),
    };
  }
  const meta = await readMeta(source.slug, env);
  if (meta === null) {
    return {
      ok: false,
      failure: failure(
        'source-corrupt',
        `store entry "${source.slug}" is corrupted (missing metadata)`,
        { slug: source.slug, section: '§5.3.2' },
      ),
    };
  }
  return { ok: true, source: { kind: 'git', raw, source, root: await realpath(root), meta } };
}

/** Resolves a local path or an installed-name reference. */
async function resolvePathOrName(
  raw: string,
  workspaceDir: string,
  env: Record<string, string | undefined>,
): Promise<ResolveResult> {
  const expanded = expandHome(raw);
  if (expanded === null) {
    return {
      ok: false,
      failure: failure('source-missing', `source "${raw}": ~user/... paths are not supported`, {
        source: raw,
      }),
    };
  }
  const candidate = resolve(workspaceDir, expanded);
  const exists = await stat(candidate).catch(() => null);
  if (exists !== null && exists.isDirectory()) {
    return { ok: true, source: { kind: 'path', raw, root: await realpath(candidate) } };
  }
  return resolveStoreName(raw, env);
}

/** Resolves a name against store slugs/manifest names (no guessing). */
async function resolveStoreName(
  raw: string,
  env: Record<string, string | undefined>,
): Promise<ResolveResult> {
  const entries = await findStoreEntry(raw, env);
  if (entries.length === 0) {
    return {
      ok: false,
      failure: failure(
        'source-missing',
        `source "${raw}" is not installed (no path, no store entry)`,
        { source: raw, section: '§5.3.3' },
      ),
    };
  }
  if (entries.length > 1) {
    const slugs = entries.map((e) => e.slug).join(', ');
    return {
      ok: false,
      failure: failure(
        'source-missing',
        `source "${raw}" matches multiple installed plugins (${slugs}); use the slug`,
        { source: raw },
      ),
    };
  }
  const entry = entries[0]!;
  if (entry.meta === null) {
    return {
      ok: false,
      failure: failure(
        'source-corrupt',
        `store entry "${entry.slug}" is corrupted (missing metadata)`,
        { slug: entry.slug },
      ),
    };
  }
  const source: GitSource = {
    url: entry.meta.url,
    ...(entry.meta.ref === undefined ? {} : { ref: entry.meta.ref }),
    slug: entry.slug,
  };
  return {
    ok: true,
    source: { kind: 'git', raw, source, root: await realpath(entry.root), meta: entry.meta },
  };
}

/** Expands a leading `~/` to the home directory.
 *
 * @param value - The path to expand.
 * @returns The expanded path, or null for unexpandable `~user/...` forms.
 */
function expandHome(value: string): string | null {
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) {
    return join(homedir(), value.slice(1).replace(/^[\\/]/, ''));
  }
  if (value.startsWith('~')) {
    return null;
  }
  return value;
}
