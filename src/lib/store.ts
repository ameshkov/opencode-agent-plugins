/**
 * Client store layout and metadata (`docs/explanation/design.md` §5.3.2).
 *
 * The store keeps git-sourced plugin copies under `installed/<slug>/` (an
 * exported tree with no `.git`), client metadata under `meta/<slug>.json`
 * (outside the plugin root, so the tree stays pristine and out of the
 * containment surface), config-edit backups under `backups/`, and
 * `PLUGIN_DATA` under `data/` (managed by `data.ts`).
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { storeDir, type EnvLike } from './data.js';
import { loadManifest } from './manifest.js';

/** Client metadata for an installed git-sourced plugin. */
export interface StoreMeta {
  /** The original source string as given by the user (including `#ref`). */
  source: string;
  /** Normalized git URL (no `git+` prefix, no `#ref`). */
  url: string;
  /** Recorded ref (branch/tag/sha); undefined means the remote HEAD. */
  ref?: string;
  /** Canonical monorepo subdir selected by the source (`a/b`); absent for root sources. */
  subdir?: string;
  /** Commit installed at (fetched remote HEAD for moving refs). */
  resolvedCommit: string;
  /** `plugin.json` version at install time, when present. */
  manifestVersion?: string;
  /** ISO-8601 timestamp of the install. */
  installedAt: string;
}

/** Installed store entry. */
export interface StoreEntry {
  /** Store slug (derived from the git URL). */
  slug: string;
  /** Absolute path of the installed plugin root. */
  root: string;
  /** Client metadata; null when missing/corrupted. */
  meta: StoreMeta | null;
}

/** Returns the absolute installed root of a slug. */
export function installedRootFor(slug: string, env: EnvLike = process.env): string {
  return join(storeDir('installed', env), slug);
}

/**
 * Returns the metadata file path of a slug.
 *
 * @param slug - Store slug.
 * @param env - Environment view for store-root resolution.
 * @returns The absolute path of the entry's metadata file.
 */
export function metaPathFor(slug: string, env: EnvLike = process.env): string {
  return join(storeDir('meta', env), `${slug}.json`);
}

/**
 * Reads the metadata of an installed plugin.
 *
 * @param slug - Store slug.
 * @param env - Environment view for store-root resolution.
 * @returns The metadata, or null when the file is missing or corrupted.
 */
export async function readMeta(
  slug: string,
  env: EnvLike = process.env,
): Promise<StoreMeta | null> {
  try {
    const text = await readFile(metaPathFor(slug, env), 'utf8');
    return JSON.parse(text) as StoreMeta;
  } catch {
    return null;
  }
}

/**
 * Writes the metadata of an installed plugin (atomic: temp + rename).
 *
 * @param slug - Store slug.
 * @param meta - Metadata to persist.
 * @param env - Environment view for store-root resolution.
 */
export async function writeMeta(
  slug: string,
  meta: StoreMeta,
  env: EnvLike = process.env,
): Promise<void> {
  const target = metaPathFor(slug, env);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFileAtomic(target, `${JSON.stringify(meta, null, 2)}\n`);
}

/**
 * Deletes the metadata file of an installed plugin.
 *
 * @param slug - Store slug.
 * @param env - Environment view for store-root resolution.
 */
export async function removeMeta(slug: string, env: EnvLike = process.env): Promise<void> {
  await rm(metaPathFor(slug, env), { force: true });
}

/**
 * Lists every installed store entry.
 *
 * Slugs without a readable metadata file are included with `meta: null`
 * (the `doctor` command reports them as corrupted). `.old-*` directories are
 * swap leftovers from crashed updates (§5.12.3), not store entries — they
 * are reported by `doctor`'s stale-leftover audit instead.
 *
 * @param env - Environment view for store-root resolution.
 * @returns Installed entries, ordered by slug.
 */
export async function listInstalled(env: EnvLike = process.env): Promise<StoreEntry[]> {
  const dir = storeDir('installed', env);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const out: StoreEntry[] = [];
  for (const slug of entries) {
    if (slug.startsWith('.old-')) {
      continue;
    }
    const root = join(dir, slug);
    const meta = await readMeta(slug, env);
    out.push({ slug, root, meta });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Resolves a plugin reference (store slug or manifest name) to store entries.
 *
 * Exact slug matches win; otherwise every entry whose manifest name matches
 * is returned — when more than one matches, the caller must refuse to guess
 * which instance the user means.
 *
 * @param slugOrName - Store slug or manifest name.
 * @param env - Environment view for store-root resolution.
 * @returns Matching entries (possibly several, possibly none).
 */
export async function findStoreEntry(
  slugOrName: string,
  env: EnvLike = process.env,
): Promise<StoreEntry[]> {
  const installed = await listInstalled(env);
  const bySlug = installed.filter((entry) => entry.slug === slugOrName);
  if (bySlug.length > 0) {
    return bySlug;
  }
  const byName: StoreEntry[] = [];
  for (const entry of installed) {
    const name = await manifestNameOf(entry.root);
    if (name === slugOrName) {
      byName.push(entry);
    }
  }
  return byName;
}

/**
 * Reads the validated manifest name of an installed plugin root.
 *
 * @param root - Absolute plugin root.
 * @returns The manifest name, or null when the manifest is unreadable or
 * invalid (the caller reports the entry as corrupted).
 */
export async function manifestNameOf(root: string): Promise<string | null> {
  const result = await loadManifest(root);
  return result.ok ? result.manifest.name : null;
}

/**
 * Writes a file atomically: write to a temp sibling, then rename over the
 * target. Keeps the target valid even if the process dies mid-write.
 *
 * @param target - Absolute path of the file to write.
 * @param content - File contents.
 */
export async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, target);
}
