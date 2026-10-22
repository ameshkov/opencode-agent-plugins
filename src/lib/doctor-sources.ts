/**
 * Doctor source classification (`doctor-audit.ts`,
 * `docs/explanation/sources.md`).
 *
 * Resolves every configured source the way startup does (local path first,
 * then store slug, then manifest name) and records what it protects.
 * `doctor-audit.ts` owns the config union and the completeness gate.
 */

import { dataKeyForPath, pathDataHash } from './data.js';
import { parseSource, resolveSource, type ParsedSource } from './resolve.js';
import { loadManifest } from './manifest.js';
import type { DoctorItem } from './doctor-audit.js';

/** Classification of one config source for the doctor audit. */
export interface SourceAudit {
  /** Store slug of a git source or installed name (added to `configSlugs`). */
  slug?: string;
  /** PLUGIN_DATA key of a resolvable path source (added to `pathKeys`). */
  dataKey?: string;
  /** Realpath hash of a resolvable path source (added to `pathHashes`). */
  dataHash?: string;
  /** Finding to report (missing path, unreadable manifest, malformed source). */
  item?: DoctorItem;
  /** True when the source resolves to a slug or a path data key. */
  resolved: boolean;
}

/**
 * Classifies one config source into a git slug, a path-source data key, or
 * a finding.
 *
 * @param source - The source string from the config.
 * @param workspaceDir - Directory relative paths resolve against (the
 * location directory, as at startup).
 * @param installedSlugs - Slugs of every store entry.
 * @param env - Environment view for store-root resolution.
 * @returns The classification, including whether the source resolved.
 */
export async function classifySource(
  source: string,
  workspaceDir: string,
  installedSlugs: Set<string>,
  env: Record<string, string | undefined>,
): Promise<SourceAudit> {
  let parsed: ParsedSource;
  try {
    parsed = parseSource(source);
  } catch (error) {
    return { item: malformedSourceItem(source, error), resolved: false };
  }
  if (parsed.kind === 'git') {
    return gitSourceAudit(source, parsed.source.slug, installedSlugs);
  }
  return pathOrNameAudit(source, parsed.raw, workspaceDir, env);
}

/** Builds the finding for a malformed git source. */
function malformedSourceItem(source: string, error: unknown): DoctorItem {
  return {
    kind: 'no-store-entry',
    id: source,
    detail: `malformed git source: ${error instanceof Error ? error.message : String(error)}`,
    referenced: true,
  };
}

/**
 * Builds the audit of a parsed git source.
 *
 * The slug is known even when the source is not installed, so the source is
 * resolved: its `PLUGIN_DATA` key is the slug and must stay protected. The
 * missing store entry is still reported.
 */
function gitSourceAudit(source: string, slug: string, installedSlugs: Set<string>): SourceAudit {
  if (installedSlugs.has(slug)) {
    return { slug, resolved: true };
  }
  return {
    slug,
    resolved: true,
    item: {
      kind: 'no-store-entry',
      id: source,
      detail: 'config entry has no store entry; run install',
      referenced: true,
    },
  };
}

/** Resolves a non-git source as a path first, then as an installed name. */
async function pathOrNameAudit(
  source: string,
  raw: string,
  workspaceDir: string,
  env: Record<string, string | undefined>,
): Promise<SourceAudit> {
  const resolved = await resolveSource(source, workspaceDir, env);
  if (resolved.ok) {
    if (resolved.source.kind === 'path') {
      return pathSourceAudit(source, resolved.source.root);
    }
    return { slug: resolved.source.source.slug, resolved: true };
  }
  const slug = resolved.failure.extra?.['slug'];
  if (resolved.failure.kind === 'source-corrupt' && typeof slug === 'string') {
    // The entry exists but its metadata is unreadable: `auditStore` reports
    // it as corrupted and referenced, so it is never pruned.
    return { slug, resolved: true };
  }
  return {
    item: {
      kind: 'no-store-entry',
      id: source,
      detail: resolved.failure.message,
      referenced: true,
    },
    resolved: false,
  };
}

/** Builds the audit of a path source, protecting its data dir by hash. */
async function pathSourceAudit(source: string, root: string): Promise<SourceAudit> {
  const hash = pathDataHash(root);
  const manifest = await loadManifest(root);
  if (!manifest.ok) {
    return {
      dataHash: hash,
      resolved: false,
      item: {
        kind: 'no-store-entry',
        id: source,
        detail: 'path source found but manifest unreadable',
        referenced: true,
      },
    };
  }
  return { dataKey: dataKeyForPath(root, manifest.manifest.name), dataHash: hash, resolved: true };
}
