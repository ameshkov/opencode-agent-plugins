/**
 * Shared plugin-tree validation pipeline (`docs/explanation/design.md` §5.12.1).
 *
 * The CLI validates exactly what the plugin will load: manifest → skills →
 * MCP, against the same `src/lib/` modules. `install` can therefore never
 * register something the plugin would reject. The returned "preview" is what
 * the CLI prints before asking for confirmation.
 */

import type { Failure } from './errors.js';
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
 * @param pluginRoot - Absolute plugin root.
 * @param dataDir - Absolute `PLUGIN_DATA` path used for cwd checks.
 * @returns The validation result (never throws; parse failures are reported
 * via {@link ValidatedPlugin.fatal}).
 */
export async function validatePluginTree(
  pluginRoot: string,
  dataDir: string,
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

  const skillResult = await discoverSkills(pluginRoot);
  warnings.push(...skillResult.failures);
  const skills = skillResult.skills.map((skill) => skill.name);

  const mcpResult = await discoverMcp(pluginRoot, manifestResult.manifest.$schema, dataDir);
  warnings.push(...mcpResult.failures);
  const servers = previewOf(mcpResult.servers);
  const fatal = mcpResult.status === 'disabled' || warnings.some((w) => w.level === 'error');

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
