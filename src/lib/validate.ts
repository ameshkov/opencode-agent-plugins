/**
 * Shared plugin-tree validation pipeline (`docs/explanation/cli-lifecycle.md`).
 *
 * The CLI validates exactly what the plugin will load: manifest → skills →
 * MCP, against the same `src/lib/` modules. `install` can therefore never
 * register something the plugin would reject. The returned "preview" is what
 * the CLI prints before asking for confirmation.
 */

import { realpath } from 'node:fs/promises';
import type { Failure } from './errors.js';
import { dataDirForKey, dataKeyForPath, type EnvLike } from './data.js';
import { loadManifest, type ManifestData } from './manifest.js';
import { discoverSkills } from './skills.js';
import { discoverMcp, type McpServerSpec } from './mcp.js';

/** A server entry as shown in the install preview. */
interface PreviewServer {
  name: string;
  kind: 'local' | 'remote';
  /** For local servers: executable + args; remote: the URL. */
  target: string;
  /** Configured header names (values redacted from the preview). */
  headers: string[];
}

/** Validation result of a plugin tree, including the registration preview. */
export interface ValidatedPlugin {
  manifest: ManifestData;
  /** Names of skills that would be registered. */
  skills: string[];
  /** MCP servers that would be registered. */
  servers: PreviewServer[];
  /** Non-fatal failures (skipped skills/servers, warnings). */
  warnings: Failure[];
  /** True when any warning is at error level (MCP disabled, etc.). */
  fatal: boolean;
}

/**
 * Validates a plugin tree and builds the registration preview.
 *
 * The `PLUGIN_DATA` directory is derived the same way registration derives it
 * (`data.ts`), so install/update validation and a later load agree on the
 * `cwd` containment boundary. Git callers pass the store slug as `key`; path
 * callers pass nothing and get the `<name>-<hash8>` key of the realpathed root.
 *
 * @param pluginRoot - Absolute plugin root.
 * @param env - Environment view for store-root resolution.
 * @param key - Explicit `PLUGIN_DATA` key (git store slug); derived when absent.
 * @returns The validation result (never throws; parse failures and an
 * unreadable `skills/` directory are reported via
 * {@link ValidatedPlugin.fatal}).
 */
export async function validatePluginTree(
  pluginRoot: string,
  env: EnvLike = process.env,
  key?: string,
): Promise<ValidatedPlugin> {
  const manifestResult = await loadManifest(pluginRoot);
  if (!manifestResult.ok) {
    return {
      manifest: { $schema: '', name: 'unknown', version: undefined },
      skills: [],
      servers: [],
      warnings: [manifestResult.failure],
      fatal: true,
    };
  }
  const warnings = [...manifestResult.warnings];
  const resolvedRoot = await realpath(pluginRoot).catch(() => pluginRoot);
  const dataKey = key ?? dataKeyForPath(resolvedRoot, manifestResult.manifest.name);
  const dataDir = dataDirForKey(dataKey, env);

  const skillResult = await discoverSkills(pluginRoot);
  warnings.push(...skillResult.failures);
  const skills = skillResult.skills.map((skill) => skill.name);

  const mcpResult = await discoverMcp(pluginRoot, manifestResult.manifest.$schema, dataDir);
  warnings.push(...mcpResult.failures);
  const servers = previewOf(mcpResult.servers);
  const fatal =
    mcpResult.status === 'disabled' ||
    skillResult.fatal ||
    warnings.some((w) => w.level === 'error');

  return { manifest: manifestResult.manifest, skills, servers, warnings, fatal };
}

/** Renders the MCP specs for the install preview. */
function previewOf(specs: McpServerSpec[]): PreviewServer[] {
  return specs
    .filter((spec) => spec.config !== undefined)
    .map((spec) => {
      const config = spec.config!;
      if (config.type === 'local') {
        return {
          name: spec.name,
          kind: 'local',
          target: config.command.join(' '),
          headers: [],
        };
      }
      return {
        name: spec.name,
        kind: 'remote',
        target: config.url,
        headers: Object.keys(config.headers ?? {}),
      };
    });
}
