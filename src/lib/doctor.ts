/**
 * Store/config health report (`docs/explanation/cli-lifecycle.md`, `doctor` /
 * `prune`).
 *
 * `doctor` is read-only and reports: config files that cannot be read or
 * parsed, config entries with no store entry or unresolved reference, store
 * entries referenced by no audited config, orphaned `PLUGIN_DATA` directories,
 * stale `.old-*` swap leftovers, and corrupted store entries. `prune` removes
 * exactly the unreferenced/stale items — never anything an audited config still
 * references. The audit helpers live in `doctor-audit.ts`, `doctor-sources.ts`,
 * and `doctor-store.ts`.
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { storeDir } from './data.js';
import { listInstalled, removeMeta } from './store.js';
import type { ConfigScope } from './config-file.js';
import { auditConfigs, type DoctorItem } from './doctor-audit.js';
import { auditData, auditLeftovers, auditStore } from './doctor-store.js';

/** Report of a doctor run. */
export interface DoctorReport {
  /** The findings (empty = healthy). */
  items: DoctorItem[];
  /**
   * True when every audited config was readable and every source resolved.
   * False means the references are unknown and `prune` refuses.
   */
  referencesComplete: boolean;
}

/** One finding whose removal failed during prune. */
export interface PruneFailure {
  /** Id of the finding that could not be removed completely. */
  id: string;
  /** Human-readable failure detail (never a stack trace). */
  message: string;
}

/** Result of a prune run. */
export interface PruneResult {
  /** Ids of the findings removed completely. */
  pruned: string[];
  /** Findings that could not be removed completely. */
  failures: PruneFailure[];
}

/**
 * Runs the read-only health report.
 *
 * The selected config, the global config, and (when the selected scope is
 * global or a custom file) the cwd project config are audited together: a
 * store entry or data directory that any of them references is kept. Other
 * project configs are not discovered (cli-lifecycle.md).
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
  const installedSlugs = new Set(installed.map((entry) => entry.slug));
  const audit = await auditConfigs(configScope, installedSlugs, env);
  const items = [
    ...audit.items,
    ...auditStore(installed, audit.configSlugs, audit.referencesComplete),
    ...(await auditData(
      storeDir('data', env),
      new Set([...installedSlugs, ...audit.pathKeys, ...audit.configSlugs]),
      audit.pathHashes,
      audit.referencesComplete,
    )),
    ...(await auditLeftovers(storeDir('installed', env))),
  ];
  return { items, referencesComplete: audit.referencesComplete };
}

/**
 * Removes what `doctor` lists as unreferenced/stale: orphaned `PLUGIN_DATA`,
 * `unreferenced-store` entries (with their metadata), and `stale-old`
 * leftovers. Never removes anything an audited config references.
 *
 * When any config reference is unknown, nothing is pruned. The CLI refuses
 * the command before this point; this guard keeps a direct caller safe too.
 * Each deletion is attempted independently so one failure cannot stop the
 * rest; failed items are returned instead of thrown.
 *
 * @param report - The report from {@link runDoctor}.
 * @param env - Environment view for store-root resolution.
 * @returns The pruned ids and the per-item failures.
 */
export async function pruneDoctor(
  report: DoctorReport,
  env: Record<string, string | undefined> = process.env,
): Promise<PruneResult> {
  const result: PruneResult = { pruned: [], failures: [] };
  if (!report.referencesComplete) {
    return result;
  }
  for (const item of report.items) {
    if (item.referenced) {
      continue;
    }
    if (item.kind === 'no-store-entry' || item.kind === 'config-missing') {
      continue;
    }
    const failures = await removeItem(item, env);
    if (failures.length === 0) {
      result.pruned.push(item.id);
    } else {
      result.failures.push({ id: item.id, message: failures.join('; ') });
    }
  }
  return result;
}

/** Removes one finding, attempting every deletion independently. */
async function removeItem(
  item: DoctorItem,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const failures: string[] = [];
  const path = item.path;
  if (path !== undefined) {
    await attempt(`delete ${path}`, () => rm(path, { recursive: true, force: true }), failures);
  }
  if (item.kind === 'unreferenced-store' || item.kind === 'corrupted') {
    await attempt(`delete metadata of ${item.id}`, () => removeMeta(item.id, env), failures);
    const dataPath = join(storeDir('data', env), item.id);
    await attempt(
      `delete ${dataPath}`,
      () => rm(dataPath, { recursive: true, force: true }),
      failures,
    );
  }
  return failures;
}

/** Runs one deletion and records its failure message instead of throwing. */
async function attempt(
  what: string,
  action: () => Promise<void>,
  failures: string[],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(`${what}: ${messageOf(error)}`);
  }
}

/** Formats a thrown value for a failure message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
