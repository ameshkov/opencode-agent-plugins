/**
 * Doctor audits of store entries, `PLUGIN_DATA`, and swap leftovers
 * (`doctor.ts`, `docs/explanation/cli-lifecycle.md`).
 *
 * These audits receive the reference sets from `doctor-audit.ts`; they never
 * resolve config sources themselves. The single `referencesComplete` gate
 * suppresses "unreferenced" findings while any config reference is unknown.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { StoreEntry } from './store.js';
import type { DoctorItem } from './doctor-audit.js';

/**
 * Audits store entries: corrupted or not referenced by any audited config.
 *
 * When the config references are incomplete, an entry is never reported as
 * unreferenced: the unresolved config source may still use it.
 *
 * @param installed - Every store entry.
 * @param configSlugs - Slugs referenced by an audited config.
 * @param referencesComplete - False when a config reference is unknown.
 * @returns The store findings.
 */
export function auditStore(
  installed: StoreEntry[],
  configSlugs: Set<string>,
  referencesComplete: boolean,
): DoctorItem[] {
  const items: DoctorItem[] = [];
  for (const entry of installed) {
    const referenced = configSlugs.has(entry.slug);
    if (entry.meta === null) {
      items.push({
        kind: 'corrupted',
        id: entry.slug,
        detail: 'store entry has no readable metadata',
        referenced: referenced || !referencesComplete,
        path: entry.root,
      });
    } else if (!referenced && referencesComplete) {
      items.push({
        kind: 'unreferenced-store',
        id: entry.slug,
        detail: 'store entry is not referenced by any audited config entry',
        referenced,
        path: entry.root,
      });
    }
  }
  return items;
}

/**
 * Audits PLUGIN_DATA dirs: keys no plugin references.
 *
 * A key that ends in the realpath hash of a configured path source is
 * protected even when the manifest is unreadable or its name changed: the
 * name part may differ, but the instance is still configured. When any config
 * reference is unknown, no orphan is reported: an unresolved source may own
 * any data directory.
 *
 * @param dataDir - Absolute `PLUGIN_DATA` root.
 * @param referencedData - Data keys that are known to be in use.
 * @param protectedHashes - Realpath hashes of configured path sources.
 * @param referencesComplete - False when a config reference is unknown.
 * @returns The orphan findings (empty when references are incomplete).
 */
export async function auditData(
  dataDir: string,
  referencedData: Set<string>,
  protectedHashes: Set<string>,
  referencesComplete: boolean,
): Promise<DoctorItem[]> {
  if (!referencesComplete) {
    return [];
  }
  const dataKeys = await readdir(dataDir).catch(() => [] as string[]);
  const items: DoctorItem[] = [];
  for (const key of dataKeys) {
    if (!referencedData.has(key) && !hasPathHash(key, protectedHashes)) {
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

/** True when a data key ends in the realpath hash of a configured path source. */
function hasPathHash(key: string, protectedHashes: Set<string>): boolean {
  for (const hash of protectedHashes) {
    if (key.endsWith(`-${hash}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Audits leftovers of crashed swaps (`.old-*` dirs).
 *
 * @param installedDir - Absolute `installed/` store root.
 * @returns The stale-leftover findings.
 */
export async function auditLeftovers(installedDir: string): Promise<DoctorItem[]> {
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
