/**
 * Store/config health report (`docs/design.md` §5.11 `doctor` / `prune`).
 *
 * `doctor` is read-only and reports: config entries with no store entry,
 * store entries referenced by no config entry, orphaned `PLUGIN_DATA`
 * directories, stale `.old-*` swap leftovers, and corrupted store entries.
 * `prune` removes exactly the unreferenced/stale items — never anything a
 * config entry still references.
 */

import { readFile, readdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConfigFile, configSourcesOf, type ConfigScope } from './config-file.js';
import { dataKeyForPath, storeDir } from './data.js';
import { listInstalled, removeMeta, type StoreEntry } from './store.js';
import { parseSource, type ParsedSource } from './resolve.js';
import { loadManifest } from './manifest.js';

/** A single finding of the doctor report. */
interface DoctorItem {
  /** What is wrong. */
  kind: 'no-store-entry' | 'unreferenced-store' | 'orphan-data' | 'stale-old' | 'corrupted';
  /** Identifies the entry (slug, source, or data key). */
  id: string;
  /** Human-readable explanation. */
  detail: string;
  /** True when a config entry still references it (nothing is pruned then). */
  referenced: boolean;
  /** Absolute path to remove when pruning (when applicable). */
  path?: string;
}

/** Report of a doctor run. */
export interface DoctorReport {
  items: DoctorItem[];
}

/** Classification of one config source for the doctor audit. */
interface SourceAudit {
  /** Store slug of a git source (added to `configSlugs`). */
  slug?: string;
  /** PLUGIN_DATA key of a resolvable path source (added to `pathKeys`). */
  dataKey?: string;
  /** Finding to report (missing path, malformed source). */
  item?: DoctorItem;
}

/**
 * Classifies one config source into a git slug, a path-source data key, or
 * a finding (malformed source, unresolvable path).
 */
async function classifySource(
  source: string,
  installedSlugs: Set<string>,
  env: Record<string, string | undefined>,
): Promise<SourceAudit> {
  let parsed: ParsedSource;
  try {
    parsed = parseSource(source);
  } catch (error) {
    return {
      item: {
        kind: 'no-store-entry',
        id: source,
        detail: `malformed git source: ${error instanceof Error ? error.message : String(error)}`,
        referenced: true,
      },
    };
  }
  if (parsed.kind === 'git') {
    return {
      slug: parsed.source.slug,
      item: installedSlugs.has(parsed.source.slug)
        ? undefined
        : {
            kind: 'no-store-entry',
            id: source,
            detail: 'config entry has no store entry; run install',
            referenced: true,
          },
    };
  }
  const { hashDataKey } = await dataKeyOfPathSource(source, env);
  if (hashDataKey !== null) {
    return { dataKey: hashDataKey };
  }
  return {
    item: {
      kind: 'no-store-entry',
      id: source,
      detail: 'path source not found on disk',
      referenced: true,
    },
  };
}

/** Audits the config: sources without a store entry, path-source keys. */
async function auditConfig(
  configScope: ConfigScope,
  installedSlugs: Set<string>,
  env: Record<string, string | undefined>,
): Promise<{ configSlugs: Set<string>; pathKeys: Set<string>; items: DoctorItem[] }> {
  const items: DoctorItem[] = [];
  const configSlugs = new Set<string>();
  const pathKeys = new Set<string>();
  const configPath = await resolveConfigFile(configScope);
  const text = await readFile(configPath, 'utf8').catch(() => null);
  if (text === null) {
    return { configSlugs, pathKeys, items };
  }
  for (const source of configSourcesOf(text)) {
    const audit = await classifySource(source, installedSlugs, env);
    if (audit.slug !== undefined) {
      configSlugs.add(audit.slug);
    }
    if (audit.dataKey !== undefined) {
      pathKeys.add(audit.dataKey);
    }
    if (audit.item !== undefined) {
      items.push(audit.item);
    }
  }
  return { configSlugs, pathKeys, items };
}

/** Audits store entries: corrupted or not referenced by any config entry. */
function auditStore(installed: StoreEntry[], configSlugs: Set<string>): DoctorItem[] {
  const items: DoctorItem[] = [];
  for (const entry of installed) {
    const referenced = configSlugs.has(entry.slug);
    if (entry.meta === null) {
      items.push({
        kind: 'corrupted',
        id: entry.slug,
        detail: 'store entry has no readable metadata',
        referenced,
        path: entry.root,
      });
    } else if (!referenced) {
      items.push({
        kind: 'unreferenced-store',
        id: entry.slug,
        detail: 'store entry is not referenced by any config entry',
        referenced,
        path: entry.root,
      });
    }
  }
  return items;
}

/** Audits PLUGIN_DATA dirs: keys no plugin references. */
async function auditData(dataDir: string, referencedData: Set<string>): Promise<DoctorItem[]> {
  const dataKeys = await readdir(dataDir).catch(() => [] as string[]);
  const items: DoctorItem[] = [];
  for (const key of dataKeys) {
    if (!referencedData.has(key)) {
      items.push({
        kind: 'orphan-data',
        id: key,
        detail: 'PLUGIN_DATA dir not referenced by any plugin',
        referenced: false,
        path: join(dataDir, key),
      });
    }
  }
  return items;
}

/** Audits leftovers of crashed swaps (`.old-*` dirs). */
async function auditLeftovers(installedDir: string): Promise<DoctorItem[]> {
  const entries = await readdir(installedDir).catch(() => [] as string[]);
  const items: DoctorItem[] = [];
  for (const slug of entries) {
    if (slug.startsWith('.old-')) {
      items.push({
        kind: 'stale-old',
        id: slug,
        detail: 'leftover swap directory from a crashed update',
        referenced: false,
        path: join(installedDir, slug),
      });
    }
  }
  return items;
}

/**
 * Runs the read-only health report.
 *
 * @param configScope - Config scope to audit against.
 * @param env - Environment view for store-root resolution.
 * @returns The findings (empty = healthy).
 */
export async function runDoctor(
  configScope: ConfigScope,
  env: Record<string, string | undefined> = process.env,
): Promise<DoctorReport> {
  const installed = await listInstalled(env);
  const installedSlugs = new Set(installed.map((e) => e.slug));
  const { configSlugs, pathKeys, items } = await auditConfig(configScope, installedSlugs, env);
  items.push(...auditStore(installed, configSlugs));
  items.push(
    ...(await auditData(storeDir('data', env), new Set([...installedSlugs, ...pathKeys]))),
  );
  items.push(...(await auditLeftovers(storeDir('installed', env))));
  return { items };
}

/**
 * Removes what `doctor` lists as unreferenced/stale: orphaned `PLUGIN_DATA`,
 * `unreferenced-store` entries (with their metadata), and `stale-old`
 * leftovers. Never removes anything a config entry references.
 *
 * @param report - The report from {@link runDoctor}.
 * @returns The pruned item ids.
 */
export async function pruneDoctor(
  report: DoctorReport,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  const pruned: string[] = [];
  for (const item of report.items) {
    if (item.referenced) {
      continue;
    }
    if (item.kind === 'no-store-entry') {
      continue;
    }
    if (item.path !== undefined) {
      await rm(item.path, { recursive: true, force: true });
    }
    if (item.kind === 'unreferenced-store' || item.kind === 'corrupted') {
      await removeMeta(item.id, env);
      await rm(join(storeDir('data', env), item.id), { recursive: true, force: true });
    }
    pruned.push(item.id);
  }
  return pruned;
}

/** Computes the PLUGIN_DATA key of a path-sourced plugin (null when missing). */
async function dataKeyOfPathSource(
  source: string,
  env: Record<string, string | undefined>,
): Promise<{ hashDataKey: string | null }> {
  // Path sources are configured relative to the workspace; doctor only
  // reports the ones that resolve (absolute or ~-based paths here).
  const normalized = source.startsWith('~') ? join(env['HOME'] ?? '', source.slice(1)) : source;
  const root = await realpath(normalized).catch(() => null);
  if (root === null) {
    return { hashDataKey: null };
  }
  const manifest = await loadManifest(root);
  if (!manifest.ok) {
    return { hashDataKey: null };
  }
  return { hashDataKey: dataKeyForPath(root, manifest.manifest.name) };
}
