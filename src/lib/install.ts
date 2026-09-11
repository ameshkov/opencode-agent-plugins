/**
 * Plugin install lifecycle (`docs/design.md` §5.12.1).
 *
 * Install fetches the source (git URL only — path sources are used in place),
 * validates the staged copy with the full pipeline, previews what will be
 * registered, then swaps it into the store and registers the source in the
 * OpenCode config. Removal lives in `remove.ts` (§5.12.2).
 */

import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gitAvailable, resolveRemoteCommit } from './git.js';
import { resolveStagedRoot, stageTree } from './clone.js';
import {
  applyRegisterSource,
  configError,
  configPreferenceNote,
  resolveConfigFile,
  saveConfig,
  type ConfigScope,
} from './config-file.js';
import { dataDirForKey, storeDir } from './data.js';
import { installedRootFor, readMeta, removeMeta, writeMeta, type StoreMeta } from './store.js';
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
  /** Absolute plugin root: staged subdir (git) or source root (path). */
  root: string;
  /**
   * Throwaway staging clone root (git kind only). Differs from `root` when a
   * monorepo subdir was selected; equals it for repository-root sources.
   */
  stagingDir?: string;
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
  const staged = await stageGitSource(raw, source);
  if (!staged.ok) {
    return { ok: false, failure: staged.failure };
  }
  const validated = await validatePluginTree(staged.root, dataDirForKey(source.slug, env));
  return {
    ok: true,
    plan: {
      raw,
      kind: 'git',
      source,
      root: staged.root,
      stagingDir: staged.stagingDir,
      slug: source.slug,
      resolvedCommit: staged.resolvedCommit,
      validated,
    },
  };
}

/** Resolves, stages and derives the plugin root of a git source (§5.3.4). */
async function stageGitSource(
  raw: string,
  source: GitSource,
): Promise<
  | { ok: true; root: string; stagingDir: string; resolvedCommit: string }
  | { ok: false; failure: Failure }
> {
  const commit = await resolveRemoteCommit(source.url, source.ref);
  if (!commit.ok) {
    return { ok: false, failure: failure('install-fail', commit.error) };
  }
  const staged = await stageTree(source.url, source.ref, commit.commit);
  if (!staged.ok) {
    return { ok: false, failure: failure('install-fail', staged.error) };
  }
  const derived = await resolveStagedRoot(staged.dir, source.subdir);
  if (!derived.ok) {
    await rm(staged.dir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, failure: failure('install-fail', derived.error, { source: raw }) };
  }
  return {
    ok: true,
    root: derived.root,
    stagingDir: staged.dir,
    resolvedCommit: commit.commit,
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
    await rm(plan.stagingDir ?? plan.root, { recursive: true, force: true }).catch(() => undefined);
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
  const moveFailure = await moveStagedTree(plan, slug, options.env);
  if (moveFailure !== null) {
    return { ok: false, failure: moveFailure };
  }
  const metaFailure = await writeInstallMeta(plan, slug, resolvedCommit, options.env);
  if (metaFailure !== null) {
    return { ok: false, failure: metaFailure };
  }
  let configNote: string | undefined;
  if (!options.noRegister) {
    const registered = await registerConfig(plan.raw, options);
    if (!registered.ok) {
      await rollbackGitInstall(slug, options.env);
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

/**
 * Moves the staged tree to `installed/<slug>`, refusing an existing entry.
 *
 * @param plan - The prepared plan.
 * @param slug - Store slug.
 * @param env - Environment view for store-root resolution (undefined uses
 * `process.env`).
 * @returns A failure when the entry already exists, else null.
 */
async function moveStagedTree(
  plan: InstallPlan,
  slug: string,
  env?: Record<string, string | undefined>,
): Promise<Failure | null> {
  const installed = installedRootFor(slug, env);
  await mkdir(join(installed, '..'), { recursive: true });
  const already = await stat(installed).catch(() => null);
  if (already !== null) {
    await rm(plan.stagingDir ?? plan.root, { recursive: true, force: true }).catch(() => undefined);
    return failure('install-fail', `store entry already exists: ${slug}`);
  }
  await rename(plan.root, installed);
  if (plan.stagingDir !== undefined && plan.stagingDir !== plan.root) {
    // Throwaway staging clone: a failed cleanup must not abort a valid
    // install (the OS temp dir reaps leftovers).
    await rm(plan.stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return null;
}

/**
 * Writes the store metadata of a moved git install.
 *
 * When the write fails the install is not committed, so the moved tree and
 * any partial metadata are rolled back before the failure is returned.
 *
 * @param plan - The prepared plan.
 * @param slug - Store slug.
 * @param resolvedCommit - Commit recorded in the metadata.
 * @param env - Environment view for store-root resolution (undefined uses
 * `process.env`).
 * @returns A failure when the metadata could not be written, else null.
 */
async function writeInstallMeta(
  plan: InstallPlan,
  slug: string,
  resolvedCommit: string,
  env?: Record<string, string | undefined>,
): Promise<Failure | null> {
  const meta: StoreMeta = {
    source: plan.raw,
    url: plan.source!.url,
    ...(plan.source!.ref === undefined ? {} : { ref: plan.source!.ref }),
    ...(plan.source!.subdir === undefined ? {} : { subdir: plan.source!.subdir }),
    resolvedCommit,
    manifestVersion: plan.validated.manifest.version,
    installedAt: new Date().toISOString(),
  };
  try {
    await writeMeta(slug, meta, env);
    return null;
  } catch (error) {
    // The tree moved, but without metadata the install is not committed:
    // roll the store entry back so a failure leaves nothing half-applied.
    await rollbackGitInstall(slug, env);
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      'install-fail',
      `failed to write store metadata: ${message}; nothing was installed`,
    );
  }
}

/**
 * Rolls back a git install's store entry when a later step failed (§5.12.1).
 *
 * Best-effort: the original failure is what the user needs to see, so a
 * failed rollback is left for `doctor` to report rather than replacing that
 * failure with a cleanup error.
 *
 * @param slug - Store slug of the entry to remove.
 * @param env - Environment view for store-root resolution (undefined uses
 * `process.env`).
 */
async function rollbackGitInstall(
  slug: string,
  env?: Record<string, string | undefined>,
): Promise<void> {
  await rm(installedRootFor(slug, env), { recursive: true, force: true }).catch(() => undefined);
  await removeMeta(slug, env).catch(() => undefined);
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
