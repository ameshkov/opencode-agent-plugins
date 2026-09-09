/**
 * Registration pipeline for the plugin entry (`docs/design.md` §5.1–§5.8).
 *
 * Everything from source resolution to config mutation happens here. The
 * entry point (`index.ts`) is a thin bootstrap: these functions talk to the
 * opencode `Config` shape and the structured logger, so they live in this
 * module rather than in the opencode-free `src/lib/`. MCP and skills
 * registration are split out into `register-mcp.ts`/`register-skills.ts`.
 */

import type { PluginInput } from '@opencode-ai/plugin';
import { failure, reportFailure } from './lib/errors.js';
import { resolveSource } from './lib/resolve.js';
import { loadManifest, type ManifestData } from './lib/manifest.js';
import { discoverSkills, type SkillDiscovery } from './lib/skills.js';
import { discoverMcp, type McpDiscovery } from './lib/mcp.js';
import { dataDirForKey, dataKeyForPath, dataKeyForSlug, ensureDataDir } from './lib/data.js';
import { registerMcpServers } from './register-mcp.js';
import { registerSkills } from './register-skills.js';
import type { Logger } from './utils/index.js';
import type { OptionsParseResult } from './options.js';
import type { RegisterState, RuntimeConfig } from './register-types.js';

/**
 * Registers the configured agent plugins onto the opencode config.
 *
 * @param config - opencode's live resolved config, mutated in place.
 * @param parsed - The parsed plugin options, or undefined when parsing
 * failed (the failure is logged by the entry point).
 * @param logger - Plugin logger.
 * @param input - Plugin input (for the workspace directory).
 */
export async function registerAgentPlugins(
  config: RuntimeConfig,
  parsed: OptionsParseResult | undefined,
  logger: Logger,
  input: PluginInput,
): Promise<void> {
  if (parsed === undefined) {
    return;
  }
  for (const warning of parsed.warnings) {
    await logger.warn(warning);
  }
  config.skills ??= { paths: [] };

  const state: RegisterState = {
    registeredMcp: new Set(),
    registeredSkillsPaths: new Set(),
    seenRoots: new Set(),
  };
  let skillCount = 0;
  let localCount = 0;
  let remoteCount = 0;
  for (const source of parsed.options.plugins) {
    const outcome = await registerSource(config, source, parsed, state, logger, input.directory);
    skillCount += outcome.skills;
    localCount += outcome.local;
    remoteCount += outcome.remote;
  }
  await logger.info('agent plugins configured', {
    sources: parsed.options.plugins.length,
    skills: skillCount,
    mcpLocal: localCount,
    mcpRemote: remoteCount,
  });
}

/**
 * Registers one configured plugin source, isolating any thrown error.
 *
 * Defense in depth: every per-plugin failure is isolated (§5.1) — a thrown
 * error must never abort the remaining plugins, so it is reported as a
 * `source-missing` failure and the run continues with an empty outcome.
 *
 * @param config - opencode's live resolved config, mutated in place.
 * @param source - The configured plugin source string.
 * @param parsed - The parsed plugin options.
 * @param state - Registration state for this hook run.
 * @param logger - Plugin logger.
 * @param workspaceDir - Workspace directory (for relative-path sources).
 * @returns The plugin's registration outcome.
 */
async function registerSource(
  config: RuntimeConfig,
  source: string,
  parsed: OptionsParseResult,
  state: RegisterState,
  logger: Logger,
  workspaceDir: string,
): Promise<PluginOutcome> {
  try {
    return await registerConfiguredSource(
      config,
      source,
      parsed.options.prefix,
      state,
      logger,
      workspaceDir,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await reportFailure(
      failure('source-missing', `unexpected error for source "${source}": ${message}`, {
        source,
      }),
      logger,
      { source },
    );
    return { skills: 0, local: 0, remote: 0 };
  }
}

/** Resolves a single configured source and registers its components. */
async function registerConfiguredSource(
  config: RuntimeConfig,
  source: string,
  prefix: boolean,
  state: RegisterState,
  logger: Logger,
  workspaceDir: string,
): Promise<PluginOutcome> {
  const result = await resolveSource(source, workspaceDir);
  if (!result.ok) {
    await reportFailure(result.failure, logger, { source });
    return { skills: 0, local: 0, remote: 0 };
  }
  const { root } = result.source;
  if (state.seenRoots.has(root)) {
    const dup = failure(
      'source-duplicate',
      `source "${source}" resolves to an already-registered plugin`,
      { source },
    );
    await reportFailure(dup, logger, { source });
    return { skills: 0, local: 0, remote: 0 };
  }
  state.seenRoots.add(root);
  const slug = result.source.kind === 'git' ? result.source.source.slug : undefined;
  return registerPlugin(config, result.source.kind, root, prefix, state, logger, slug);
}

/** Counters of one plugin registration. */
interface PluginOutcome {
  skills: number;
  local: number;
  remote: number;
}

/**
 * Registers one resolved plugin: manifest → skills → MCP, per the failure
 * taxonomy (narrowest unit dropped first, failures logged, never thrown).
 */
async function registerPlugin(
  config: RuntimeConfig,
  kind: 'path' | 'git',
  root: string,
  prefix: boolean,
  state: RegisterState,
  logger: Logger,
  slug: string | undefined,
): Promise<PluginOutcome> {
  const loaded = await loadAndValidatePlugin(root, kind, logger, slug);
  if (loaded === null) {
    return { skills: 0, local: 0, remote: 0 };
  }
  const { manifest, skillResult, mcpResult } = loaded;
  let skillCount = 0;
  if (skillResult.root !== null) {
    skillCount = await registerSkills(
      config,
      skillResult.root,
      skillResult.skills.map((s) => s.name),
      manifest.name,
      state,
      logger,
    );
  }
  const { local, remote } = await registerMcpOf(
    config,
    kind,
    root,
    prefix,
    state,
    logger,
    slug,
    manifest,
    mcpResult,
  );
  await logger.info(`plugin "${manifest.name}" registered`, {
    plugin: manifest.name,
    root,
    skills: skillCount,
    mcpLocal: local,
    mcpRemote: remote,
  });
  return { skills: skillCount, local, remote };
}

/**
 * Registers the plugin's MCP servers and creates `PLUGIN_DATA` for local ones.
 *
 * @param config - opencode's live resolved config, mutated in place.
 * @param kind - Source kind (path or git).
 * @param root - The plugin's absolute root directory.
 * @param prefix - When true, prefix MCP server names.
 * @param state - Registration state for this hook run.
 * @param logger - Plugin logger.
 * @param slug - Store slug for git-sourced plugins, or undefined.
 * @param manifest - The validated plugin manifest.
 * @param mcpResult - The plugin's MCP discovery result.
 * @returns Local/remote counters of the registered servers.
 */
async function registerMcpOf(
  config: RuntimeConfig,
  kind: 'path' | 'git',
  root: string,
  prefix: boolean,
  state: RegisterState,
  logger: Logger,
  slug: string | undefined,
  manifest: ManifestData,
  mcpResult: McpDiscovery,
): Promise<{ local: number; remote: number }> {
  const localServers = mcpResult.servers.filter((spec) => spec.kind === 'local');
  if (localServers.length > 0) {
    await ensureDataDir(keyOf(kind, slug, root, manifest.name)).catch((error) =>
      reportFailure(
        failure('install-fail', `cannot create PLUGIN_DATA: ${String(error)}`),
        logger,
        { plugin: manifest.name },
      ),
    );
  }
  return registerMcpServers(config, manifest.name, mcpResult.servers, prefix, state, logger);
}

/** Validates the plugin package and reports its non-fatal findings. */
async function loadAndValidatePlugin(
  root: string,
  kind: 'path' | 'git',
  logger: Logger,
  slug: string | undefined,
): Promise<LoadedPlugin | null> {
  const manifestResult = await loadManifest(root);
  if (!manifestResult.ok) {
    await reportFailure(manifestResult.failure, logger, { plugin: root });
    return null;
  }
  const manifest = manifestResult.manifest;
  for (const warning of manifestResult.warnings) {
    await reportFailure(warning, logger, { plugin: manifest.name });
  }
  const dataDir = dataDirForKey(keyOf(kind, slug, root, manifest.name));
  const skillResult = await discoverSkills(root);
  for (const warning of skillResult.failures) {
    await reportFailure(warning, logger, { plugin: manifest.name });
  }
  const mcpResult = await discoverMcp(root, manifest.$schema, dataDir);
  if (mcpResult.status === 'disabled') {
    await logger.error(mcpResult.reason ?? 'MCP disabled', { plugin: manifest.name });
  }
  for (const warning of mcpResult.failures) {
    await reportFailure(warning, logger, { plugin: manifest.name });
  }
  await reportAbsentComponents(manifest, skillResult, mcpResult, logger);
  return { manifest, skillResult, mcpResult };
}

/**
 * Reports §6 valid-absence conditions at debug level: missing `skills/`,
 * missing `mcp.json`, and unimplemented extension namespaces. All three are
 * valid, non-fatal states (the plugin keeps loading), so they stay silent at
 * the default info threshold and are only visible with `logLevel: "debug"`.
 *
 * @param manifest - The validated plugin manifest.
 * @param skillResult - The plugin's skills discovery result.
 * @param mcpResult - The plugin's MCP discovery result.
 * @param logger - Plugin logger.
 */
async function reportAbsentComponents(
  manifest: ManifestData,
  skillResult: SkillDiscovery,
  mcpResult: McpDiscovery,
  logger: Logger,
): Promise<void> {
  if (skillResult.missing) {
    await reportFailure(
      failure('skills-missing', 'no skills/ directory (valid absence)', {
        plugin: manifest.name,
      }),
      logger,
      { plugin: manifest.name },
    );
  }
  if (mcpResult.status === 'absent') {
    await reportFailure(
      failure('mcp-missing', 'no mcp.json (valid absence)', { plugin: manifest.name }),
      logger,
      { plugin: manifest.name },
    );
  }
  for (const namespace of Object.keys(manifest.extensions ?? {})) {
    await reportFailure(
      failure(
        'extension-namespace',
        `extension namespace "${namespace}" is not implemented; ignored`,
        { plugin: manifest.name, namespace },
      ),
      logger,
      { plugin: manifest.name },
    );
  }
}

/** Computes the PLUGIN_DATA key for a plugin instance. */
function keyOf(kind: 'path' | 'git', slug: string | undefined, root: string, name: string): string {
  return kind === 'git' && slug !== undefined ? dataKeyForSlug(slug) : dataKeyForPath(root, name);
}

/** A validated plugin ready for registration. */
interface LoadedPlugin {
  manifest: ManifestData;
  skillResult: SkillDiscovery;
  mcpResult: McpDiscovery;
}
