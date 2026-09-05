/**
 * Plugin install / remove lifecycle (`docs/design.md` §5.12.1–§5.12.2).
 *
 * Install fetches the source (git URL only — path sources are used in place),
 * validates the staged copy with the full pipeline, previews what will be
 * registered, then swaps it into the store and registers the source in the
 * OpenCode config. Remove unregisters and deletes the store entry plus its
 * `PLUGIN_DATA` (unless `--keep-data`).
 */

import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gitAvailable, resolveRemoteCommit, stageTree } from './git.js';
import {
  applyRegisterSource,
  applyRemoveSource,
  configPreferenceNote,
  ConfigEditError,
  resolveConfigFile,
  saveConfig,
  type ConfigScope,
} from './config-file.js';
import { dataDirForKey, storeDir } from './data.js';
import {
  findStoreEntry,
  installedRootFor,
  readMeta,
  removeMeta,
  writeMeta,
  type StoreEntry,
  type StoreMeta,
} from './store.js';
import { parseSource, type GitSource } from './resolve.js';
import { validatePluginTree, type ValidatedPlugin } from './validate.js';
import { failure, type Failure } from './errors.js';

/** Options shared by install/remove. */
export interface LifecycleOptions {
  /** Config file scope for the registration edit. */
  configScope: ConfigScope;
  /** Environment view for store-root resolution. */
  env?: Record<string, string | undefined>;
}

/** A prepared install: validated, staged, still nothing written. */
export interface InstallPlan {
  /** Source string as given. */
  raw: string;
  /** Source kind. */
  kind: 'git' | 'path';
  /** Git source info (git kind only). */
  source?: GitSource;
  /** Absolute plugin root: staged dir (git) or source root (path). */
  root: string;
  /** Store slug (git kind only). */
  slug?: string;
  /** Commit that will be recorded (git kind only). */
  resolvedCommit?: string;
  /** Validation result and registration preview. */
  validated: ValidatedPlugin;
}

/** Result of preparation/application. */
export type OpResult =
  | { ok: true; plan?: InstallPlan; message?: string; backupPath?: string; configNote?: string }
  | { ok: false; failure: Failure; detail?: string };

/**
 * Prepares an install: resolves the source, stages the git tree, validates
 * it, and builds the preview. Nothing is written.
 *
 * @param raw - Source string (git URL or local path).
 * @param workspaceDir - Workspace directory for relative paths.
 * @param env - Environment view for store-root resolution.
 * @param refOverride - Optional `--ref` override, replacing any `#ref` in the
 * source string for the clone/recorded metadata (the registered config entry
 * keeps the original string).
 * @returns The plan, or a taxonomy failure.
 */
export async function prepareInstall(
  raw: string,
  workspaceDir: string,
  env: Record<string, string | undefined> = process.env,
  refOverride?: string,
): Promise<OpResult> {
  let parsed;
  try {
    parsed = parseSource(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, failure: failure('install-fail', message, { source: raw }) };
  }
  if (parsed.kind === 'path') {
    return preparePathInstall(raw, parsed.raw, workspaceDir, env);
  }
  const source = { ...parsed.source, ...(refOverride === undefined ? {} : { ref: refOverride }) };
  return prepareGitInstall(raw, source, env);
}

/** Prepares an install of a local path plugin (validated, used in place). */
async function preparePathInstall(
  raw: string,
  pathSource: string,
  workspaceDir: string,
  env: Record<string, string | undefined>,
): Promise<OpResult> {
  // `resolve` (not `join`) so an absolute source resets the workspace prefix.
  const root = resolve(workspaceDir, pathSource);
  const exists = await stat(root).catch(() => null);
  if (exists === null || !exists.isDirectory()) {
    return {
      ok: false,
      failure: failure('install-fail', `path source not found: ${pathSource}`, { source: raw }),
    };
  }
  const validated = await validatePluginTree(root, storeDir('data', env));
  return { ok: true, plan: { raw, kind: 'path', root, validated } };
}

/** Prepares an install of a git source: fetch, stage, validate, preview. */
async function prepareGitInstall(
  raw: string,
  source: GitSource,
  env: Record<string, string | undefined>,
): Promise<OpResult> {
  if (!(await gitAvailable())) {
    return {
      ok: false,
      failure: failure('install-fail', 'git binary is required to install from a URL'),
    };
  }
  const existing = await readMeta(source.slug, env);
  if (existing !== null) {
    return {
      ok: false,
      failure: failure(
        'install-fail',
        `already installed at commit ${existing.resolvedCommit.slice(0, 12)}; use update`,
        { slug: source.slug },
      ),
    };
  }
  const commit = await resolveRemoteCommit(source.url, source.ref);
  if (!commit.ok) {
    return { ok: false, failure: failure('install-fail', commit.error) };
  }
  const staged = await stageTree(source.url, source.ref);
  if (!staged.ok) {
    return { ok: false, failure: failure('install-fail', staged.error) };
  }
  const dataDir = dataDirForKey(source.slug, env);
  const validated = await validatePluginTree(staged.dir, dataDir);
  return {
    ok: true,
    plan: {
      raw,
      kind: 'git',
      source,
      root: staged.dir,
      slug: source.slug,
      resolvedCommit: commit.commit,
      validated,
    },
  };
}

/**
 * Applies a prepared install: moves the staged tree into the store, writes
 * metadata, and registers the source in the OpenCode config.
 *
 * @param plan - The plan from {@link prepareInstall}.
 * @param options - Lifecycle options (config scope, env).
 * @param options.noRegister - Skip the config edit (print-only mode).
 * @returns The result; on success the message to show the user.
 */
export async function applyInstall(
  plan: InstallPlan,
  options: LifecycleOptions & { noRegister?: boolean },
): Promise<OpResult> {
  if (plan.validated.fatal) {
    return abortFatalInstall(plan);
  }
  if (plan.kind === 'git' && plan.slug !== undefined && plan.resolvedCommit !== undefined) {
    return applyGitInstall(plan, plan.slug, plan.resolvedCommit, options);
  }
  let configNote: string | undefined;
  if (!options.noRegister) {
    const registered = await registerConfig(plan.raw, options);
    if (!registered.ok) {
      return registered;
    }
    configNote = registered.configNote;
  }
  const message = options.noRegister
    ? `validated ${plan.raw} (local path, not registered; add the config snippet below, then restart OpenCode to use it).`
    : `registered ${plan.raw} (local path). Restart OpenCode to use it.`;
  return {
    ok: true,
    message,
    ...(configNote === undefined ? {} : { configNote }),
  };
}

/**
 * Aborts a fatally-invalid install with nothing changed on disk (§5.12.1),
 * mirroring the update path (`swapUpdate`), which refuses the new tree for
 * the same reason. Git plans hold a throwaway staging dir that is removed;
 * path sources are used in place, so their root must never be touched.
 *
 * @param plan - The prepared plan.
 * @returns The install failure result.
 */
async function abortFatalInstall(plan: InstallPlan): Promise<OpResult> {
  if (plan.kind === 'git') {
    await rm(plan.root, { recursive: true, force: true });
  }
  return {
    ok: false,
    failure: failure('install-fail', 'plugin failed validation; nothing was installed'),
  };
}

/**
 * Applies a git-kind plan: moves the staged tree into the store, writes
 * metadata, and registers the source in the OpenCode config.
 *
 * @param plan - The prepared plan.
 * @param slug - Store slug (from `prepareInstall`).
 * @param resolvedCommit - Commit recorded in the metadata.
 * @param options - Lifecycle options (config scope, env).
 * @returns The result; on success the message to show the user.
 */
async function applyGitInstall(
  plan: InstallPlan,
  slug: string,
  resolvedCommit: string,
  options: LifecycleOptions & { noRegister?: boolean },
): Promise<OpResult> {
  const installed = installedRootFor(slug, options.env);
  await mkdir(join(installed, '..'), { recursive: true });
  const already = await stat(installed).catch(() => null);
  if (already !== null) {
    await rm(plan.root, { recursive: true, force: true });
    return {
      ok: false,
      failure: failure('install-fail', `store entry already exists: ${slug}`),
    };
  }
  await rename(plan.root, installed);
  const meta: StoreMeta = {
    source: plan.raw,
    url: plan.source!.url,
    ...(plan.source!.ref === undefined ? {} : { ref: plan.source!.ref }),
    resolvedCommit,
    manifestVersion: plan.validated.manifest.version,
    installedAt: new Date().toISOString(),
  };
  await writeMeta(slug, meta, options.env);
  let configNote: string | undefined;
  if (!options.noRegister) {
    const registered = await registerConfig(plan.raw, options);
    if (!registered.ok) {
      return registered;
    }
    configNote = registered.configNote;
  }
  const manifestVersion = plan.validated.manifest.version
    ? ` ${plan.validated.manifest.version}`
    : '';
  const message = options.noRegister
    ? `installed ${plan.validated.manifest.name}${manifestVersion} (not registered; add the config snippet below, then restart OpenCode to use it).`
    : `installed ${plan.validated.manifest.name}${manifestVersion}. Restart OpenCode to use it.`;
  return {
    ok: true,
    message,
    ...(configNote === undefined ? {} : { configNote }),
  };
}

/** Registers a source in the resolved OpenCode config. */
async function registerConfig(source: string, options: LifecycleOptions): Promise<OpResult> {
  try {
    const resolved = await resolveConfigFile(options.configScope);
    const previous = await readFile(resolved.path, 'utf8').catch(() => null);
    const edited = applyRegisterSource(previous ?? '', source);
    const { backupPath } = await saveConfig(resolved.path, edited, options.env, previous);
    const note = configPreferenceNote(resolved);
    return {
      ok: true,
      backupPath: backupPath ?? undefined,
      ...(note === null ? {} : { configNote: note }),
    };
  } catch (error) {
    const message = configError(error);
    return { ok: false, failure: failure('config-edit', message) };
  }
}

/**
 * Removes a plugin: resolves the name to a store entry (ambiguous names are
 * refused), unregisters its source from the config, then deletes the store
 * entry, metadata, and `PLUGIN_DATA`.
 *
 * @param name - Store slug or manifest name.
 * @param options - Lifecycle options.
 * @param options.keepData - Keep `PLUGIN_DATA` on disk.
 * @returns The outcome.
 */
export async function removePlugin(
  name: string,
  options: LifecycleOptions & { keepData?: boolean },
): Promise<OpResult> {
  const entries = await findStoreEntry(name, options.env);
  if (entries.length === 0) {
    return {
      ok: false,
      failure: failure(
        'install-fail',
        `"${name}" is not installed in the client store (path-sourced plugins are removed by editing the config)`,
      ),
    };
  }
  if (entries.length > 1) {
    const slugs = entries.map((e) => e.slug).join(', ');
    return {
      ok: false,
      failure: failure(
        'install-fail',
        `"${name}" matches multiple store entries (${slugs}); use the slug`,
      ),
    };
  }
  return removeStoreEntry(entries[0]!, options);
}

/** Unregisters and deletes one store entry (config edit + removal). */
async function removeStoreEntry(
  entry: StoreEntry,
  options: LifecycleOptions & { keepData?: boolean },
): Promise<OpResult> {
  const meta = entry.meta;
  if (meta === null) {
    return {
      ok: false,
      failure: failure('source-corrupt', `store entry "${entry.slug}" is corrupted`),
    };
  }
  let backupPath: string | undefined;
  let configNote: string | undefined;
  try {
    const resolved = await resolveConfigFile(options.configScope);
    const previous = await readFile(resolved.path, 'utf8').catch(() => null);
    const edited = applyRemoveSource(previous ?? '', meta.source);
    const saved = await saveConfig(resolved.path, edited, options.env, previous);
    backupPath = saved.backupPath ?? undefined;
    configNote = configPreferenceNote(resolved) ?? undefined;
  } catch (error) {
    return { ok: false, failure: failure('config-edit', configError(error)) };
  }
  await rm(installedRootFor(entry.slug, options.env), { recursive: true, force: true });
  await removeMeta(entry.slug, options.env);
  if (!options.keepData) {
    await rm(dataDirForKey(entry.slug, options.env), { recursive: true, force: true });
  }
  return {
    ok: true,
    message: `removed ${meta.source}. Restart OpenCode to drop its tools and skills.`,
    backupPath,
    ...(configNote === undefined ? {} : { configNote }),
  };
}

/** Formats a config-edit error into a user-facing message. */
function configError(error: unknown): string {
  if (error instanceof ConfigEditError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
