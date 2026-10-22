/**
 * Doctor config audit (`doctor.ts`, `docs/explanation/cli-lifecycle.md`).
 *
 * Audits the selected config, the global config, and (when the selected scope
 * is global or a custom file) the cwd project config as a known file. Every
 * source is resolved like startup. `referencesComplete` is the single prune
 * gate: it is false when any audited config cannot be read or parsed into a
 * source list, or any source cannot be resolved. `doctor-sources.ts` owns the
 * source classification; `doctor-store.ts` audits store entries,
 * `PLUGIN_DATA`, and swap leftovers.
 */

import { readFile } from 'node:fs/promises';
import { configSourceListOf } from './config-edit.js';
import { locationDir, resolveConfigFile, type ConfigScope } from './config-file.js';
import { classifySource } from './doctor-sources.js';

/** A single finding of the doctor report. */
export interface DoctorItem {
  /** What is wrong. */
  kind:
    | 'no-store-entry'
    | 'unreferenced-store'
    | 'orphan-data'
    | 'stale-old'
    | 'corrupted'
    | 'config-missing';
  /** Identifies the entry (slug, source, data key, or config path). */
  id: string;
  /** Human-readable explanation. */
  detail: string;
  /** True when the item must not be pruned (a config may reference it). */
  referenced: boolean;
  /** Absolute path to remove when pruning (when applicable). */
  path?: string;
}

/** Result of auditing all configs for one doctor run. */
export interface ConfigAudit {
  /** Store slugs referenced by any audited config. */
  configSlugs: Set<string>;
  /** Path-source data keys referenced by any audited config. */
  pathKeys: Set<string>;
  /** Path-source instance hashes referenced by any audited config. */
  pathHashes: Set<string>;
  /** Findings from the configs. */
  items: DoctorItem[];
  /**
   * True when every audited config was readable and every source resolved to
   * a slug or a path data key. False makes `prune` refuse.
   */
  referencesComplete: boolean;
}

/** One config file to audit. */
interface AuditTarget {
  /** Absolute config file path. */
  path: string;
  /** True when the file must exist (the selected scope). */
  required: boolean;
  /** True when the file is the global config. */
  global: boolean;
  /** Directory relative paths resolve against (the location directory). */
  workspaceDir: string;
}

/**
 * Audits the selected config, the global config, and the cwd project config
 * when the selected scope does not already cover it, and unions their
 * references. Other project configs are deliberately not discovered: the CLI
 * has no reliable list of them.
 *
 * @param configScope - Config scope selected on the command line.
 * @param installedSlugs - Slugs of every store entry.
 * @param env - Environment view for store-root resolution.
 * @returns The union of references, the findings, and the completeness gate.
 */
export async function auditConfigs(
  configScope: ConfigScope,
  installedSlugs: Set<string>,
  env: Record<string, string | undefined>,
): Promise<ConfigAudit> {
  const audit: ConfigAudit = {
    configSlugs: new Set(),
    pathKeys: new Set(),
    pathHashes: new Set(),
    items: [],
    referencesComplete: true,
  };
  const globalPath = (await resolveConfigFile({ kind: 'global' }, env)).path;
  const cwdProjectPath = (await resolveConfigFile({ kind: 'project', cwd: process.cwd() }, env))
    .path;
  const workspaceDir = locationDir(configScope);
  if (configScope.kind === 'global') {
    await auditGlobalScope(globalPath, cwdProjectPath, workspaceDir, installedSlugs, env, audit);
    return audit;
  }
  await auditSelectedScope(
    configScope,
    globalPath,
    cwdProjectPath,
    workspaceDir,
    installedSlugs,
    env,
    audit,
  );
  return audit;
}

/** Audits the global config and the cwd project config for `--global`. */
async function auditGlobalScope(
  globalPath: string,
  cwdProjectPath: string,
  workspaceDir: string,
  installedSlugs: Set<string>,
  env: Record<string, string | undefined>,
  audit: ConfigAudit,
): Promise<void> {
  await auditTarget(
    { path: globalPath, required: true, global: true, workspaceDir },
    installedSlugs,
    env,
    audit,
  );
  if (cwdProjectPath !== globalPath) {
    await auditTarget(
      { path: cwdProjectPath, required: false, global: false, workspaceDir },
      installedSlugs,
      env,
      audit,
    );
  }
}

/** Audits the selected config plus the optional global and cwd project configs. */
async function auditSelectedScope(
  configScope: ConfigScope,
  globalPath: string,
  cwdProjectPath: string,
  workspaceDir: string,
  installedSlugs: Set<string>,
  env: Record<string, string | undefined>,
  audit: ConfigAudit,
): Promise<void> {
  const selected = await resolveConfigFile(configScope, env);
  await auditTarget(
    {
      path: selected.path,
      required: true,
      global: selected.path === globalPath,
      workspaceDir,
    },
    installedSlugs,
    env,
    audit,
  );
  if (selected.path !== globalPath) {
    await auditTarget(
      { path: globalPath, required: false, global: true, workspaceDir },
      installedSlugs,
      env,
      audit,
    );
  }
  if (
    configScope.kind === 'custom' &&
    selected.path !== cwdProjectPath &&
    cwdProjectPath !== globalPath
  ) {
    await auditTarget(
      { path: cwdProjectPath, required: false, global: false, workspaceDir },
      installedSlugs,
      env,
      audit,
    );
  }
}

/** Reads and audits one config target. */
async function auditTarget(
  target: AuditTarget,
  installedSlugs: Set<string>,
  env: Record<string, string | undefined>,
  audit: ConfigAudit,
): Promise<void> {
  const text = await readFile(target.path, 'utf8').catch((error: NodeJS.ErrnoException) => error);
  if (typeof text !== 'string') {
    if (target.required || text.code !== 'ENOENT') {
      audit.referencesComplete = false;
      audit.items.push(configMissingItem(target.path, text));
    }
    return;
  }
  const sourceList = configSourceListOf(text);
  if (sourceList.problem !== null) {
    audit.referencesComplete = false;
    audit.items.push(configProblemItem(target.path, sourceList.problem));
    return;
  }
  for (const source of sourceList.sources) {
    const sourceAudit = await classifySource(source, target.workspaceDir, installedSlugs, env);
    if (sourceAudit.slug !== undefined) {
      audit.configSlugs.add(sourceAudit.slug);
    }
    if (sourceAudit.dataKey !== undefined) {
      audit.pathKeys.add(sourceAudit.dataKey);
    }
    if (sourceAudit.dataHash !== undefined) {
      audit.pathHashes.add(sourceAudit.dataHash);
    }
    if (!sourceAudit.resolved) {
      audit.referencesComplete = false;
    }
    if (sourceAudit.item !== undefined) {
      audit.items.push(sourceAudit.item);
    }
  }
}

/** Builds the finding for a missing or unreadable config. */
function configMissingItem(path: string, error: NodeJS.ErrnoException): DoctorItem {
  const detail =
    error.code === 'ENOENT' ? 'config file not found' : `config file unreadable: ${error.message}`;
  return { kind: 'config-missing', id: path, detail, referenced: true };
}

/** Builds the finding for a config that cannot be parsed into a source list. */
function configProblemItem(path: string, problem: string): DoctorItem {
  return { kind: 'config-missing', id: path, detail: problem, referenced: true };
}
