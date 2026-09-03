/**
 * Registration pipeline for the plugin entry (`docs/design.md` §5.1–§5.8).
 *
 * Everything from source resolution to config mutation happens here. The
 * entry point (`index.ts`) is a thin bootstrap: these functions talk to the
 * opencode `Config` shape and the structured logger, so they live in this
 * module rather than in the opencode-free `src/lib/`.
 */

import type { Config, PluginInput } from '@opencode-ai/plugin';
import { failure, type Failure } from './lib/errors.js';
import { resolveSource } from './lib/resolve.js';
import { loadManifest, type ManifestData } from './lib/manifest.js';
import { collectSkillNames, discoverSkills, type SkillDiscovery } from './lib/skills.js';
import {
  discoverMcp,
  isValidServerName,
  sanitizeServerName,
  type McpDiscovery,
  type McpServerSpec,
} from './lib/mcp.js';
import { dataDirForKey, dataKeyForPath, dataKeyForSlug, ensureDataDir } from './lib/data.js';
import type { Logger } from './utils/index.js';
import type { OptionsParseResult } from './options.js';

/** Runtime shape of `config.skills` (the SDK type lags here). */
export type RuntimeConfig = Config & { skills?: { paths: string[] } };

/** A single registered MCP server (runtime schema, superset of SDK type). */
type RuntimeMcpEntry = Record<string, unknown> & { type: string };

interface RegisterState {
  /** MCP names registered earlier in this hook run (plugin–plugin collisions). */
  registeredMcp: Set<string>;
  /** Plugin roots already registered this run (dedupe by realpath). */
  seenRoots: Set<string>;
}

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

  const state: RegisterState = { registeredMcp: new Set(), seenRoots: new Set() };
  let skillCount = 0;
  let localCount = 0;
  let remoteCount = 0;
  for (const source of parsed.options.plugins) {
    let outcome: PluginOutcome;
    try {
      outcome = await registerConfiguredSource(
        config,
        source,
        parsed.options.prefix,
        state,
        logger,
        input.directory,
      );
    } catch (error) {
      // Defense in depth: every per-plugin failure is isolated (§5.1). A
      // thrown error must never abort the remaining plugins.
      const message = error instanceof Error ? error.message : String(error);
      await report(
        failure('source-missing', `unexpected error for source "${source}": ${message}`, {
          source,
        }),
        logger,
        { source },
      );
      outcome = { skills: 0, local: 0, remote: 0 };
    }
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
    await report(result.failure, logger, { source });
    return { skills: 0, local: 0, remote: 0 };
  }
  const { root } = result.source;
  if (state.seenRoots.has(root)) {
    const dup = failure(
      'source-duplicate',
      `source "${source}" resolves to an already-registered plugin`,
      { source },
    );
    await report(dup, logger, { source });
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

  if (skillResult.root !== null) {
    await registerSkills(
      config,
      skillResult.root,
      skillResult.skills.map((s) => s.name),
      manifest.name,
      logger,
    );
  }
  const localServers = mcpResult.servers.filter((spec) => spec.kind === 'local');
  if (localServers.length > 0) {
    await ensureDataDir(keyOf(kind, slug, root, manifest.name)).catch((error) =>
      report(failure('install-fail', `cannot create PLUGIN_DATA: ${String(error)}`), logger, {
        plugin: manifest.name,
      }),
    );
  }
  const { local, remote } = await registerMcpServers(
    config,
    manifest.name,
    mcpResult.servers,
    prefix,
    state,
    logger,
  );
  await logger.info(`plugin "${manifest.name}" registered`, {
    plugin: manifest.name,
    root,
    skills: skillResult.skills.length,
    mcpLocal: local,
    mcpRemote: remote,
  });
  return { skills: skillResult.skills.length, local, remote };
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
    await report(manifestResult.failure, logger, { plugin: root });
    return null;
  }
  const manifest = manifestResult.manifest;
  for (const warning of manifestResult.warnings) {
    await report(warning, logger, { plugin: manifest.name });
  }
  const dataDir = dataDirForKey(keyOf(kind, slug, root, manifest.name));
  const skillResult = await discoverSkills(root);
  for (const warning of skillResult.failures) {
    await report(warning, logger, { plugin: manifest.name });
  }
  const mcpResult = await discoverMcp(root, manifest.$schema, dataDir);
  if (mcpResult.status === 'disabled') {
    await logger.error(mcpResult.reason ?? 'MCP disabled', { plugin: manifest.name });
  }
  for (const warning of mcpResult.failures) {
    await report(warning, logger, { plugin: manifest.name });
  }
  return { manifest, skillResult, mcpResult };
}

/** Registers the plugin's MCP servers with collision handling + prefixing. */
async function registerMcpServers(
  config: RuntimeConfig,
  pluginName: string,
  specs: McpServerSpec[],
  prefix: boolean,
  state: RegisterState,
  logger: Logger,
): Promise<{ local: number; remote: number }> {
  let local = 0;
  let remote = 0;
  for (const spec of specs) {
    const name = prefixedName(pluginName, spec, prefix);
    if (name === null) {
      await report(
        failure(
          'server-invalid',
          `server "${spec.name}" cannot be registered: sanitized name invalid`,
          { plugin: pluginName },
        ),
        logger,
        { plugin: pluginName },
      );
      continue;
    }
    if (config.mcp?.[name] !== undefined) {
      await reportCollision(name, spec, pluginName, state, logger);
      continue;
    }
    config.mcp ??= {};
    (config.mcp as Record<string, RuntimeMcpEntry>)[name] =
      spec.config as unknown as RuntimeMcpEntry;
    state.registeredMcp.add(name);
    if (spec.kind === 'local') {
      local += 1;
    } else {
      remote += 1;
    }
  }
  return { local, remote };
}

/** Reports a name collision: user config wins (warn) or plugin-plugin (error). */
async function reportCollision(
  name: string,
  spec: McpServerSpec,
  pluginName: string,
  state: RegisterState,
  logger: Logger,
): Promise<void> {
  const owner = state.registeredMcp.has(name);
  const f = failure(
    'server-collision',
    owner
      ? `server name "${name}" is already used by another plugin in this run`
      : `server name "${name}" is already defined in your config; user config wins`,
    { plugin: pluginName, server: spec.name },
  );
  await report({ ...f, level: owner ? 'error' : 'warn' }, logger, { plugin: pluginName });
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

/** Registers the plugin's `skills/` dir, warning on name collisions. */
async function registerSkills(
  config: RuntimeConfig,
  skillsRoot: string,
  names: string[],
  pluginName: string,
  logger: Logger,
): Promise<void> {
  const existing = config.skills!.paths;
  for (const path of existing) {
    if (path === skillsRoot) {
      continue;
    }
    const found = await collectSkillNames(path);
    for (const name of found) {
      if (names.includes(name)) {
        const f = failure(
          'skills-invalid',
          `skill "${name}" from "${pluginName}" collides with the one at "${path}"`,
        );
        await report(f, logger, { plugin: pluginName, skill: name });
      }
    }
  }
  config.skills!.paths.push(skillsRoot);
}

/** Computes the registered MCP name (prefixed or plain), or null when invalid. */
function prefixedName(pluginName: string, spec: McpServerSpec, prefix: boolean): string | null {
  if (!prefix) {
    return isValidServerName(spec.name) ? spec.name : null;
  }
  const pluginPart = sanitizeServerName(pluginName);
  const serverPart = sanitizeServerName(spec.name);
  const name = `${pluginPart}-${serverPart}`;
  return isValidServerName(name) ? name : null;
}

/**
 * Reports a taxonomy failure through the logger at its taxonomy level.
 *
 * @param f - The failure to report.
 * @param logger - Plugin logger.
 * @param extra - Additional structured metadata merged into the report.
 */
async function report(f: Failure, logger: Logger, extra: Record<string, unknown>): Promise<void> {
  const metadata = { ...(f.extra ?? {}), ...extra, boundary: f.kind };
  switch (f.level) {
    case 'error':
      await logger.error(f.message, metadata);
      break;
    case 'warn':
      await logger.warn(f.message, metadata);
      break;
    case 'debug':
      await logger.debug(f.message, metadata);
      break;
    default:
      await logger.info(f.message, metadata);
  }
}
