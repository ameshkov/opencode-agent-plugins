/**
 * MCP server registration for the plugin entry (`docs/design.md` §5.7).
 *
 * Translates validated `McpServerSpec`s into opencode `config.mcp` entries,
 * applying name sanitization and the user-config-wins collision rule. Lives
 * in `src/` (not `src/lib/`) because it talks to the opencode `Config`
 * shape; the `src/lib/mcp.ts` discovery half stays opencode-free.
 */

import { isValidServerName, sanitizeServerName, type McpServerSpec } from './lib/mcp.js';
import { failure, reportFailure } from './lib/errors.js';
import type { Logger } from './utils/index.js';
import type { RegisterState, RuntimeConfig } from './register-types.js';

/** A single registered MCP server (runtime schema, superset of SDK type). */
type RuntimeMcpEntry = Record<string, unknown> & { type: string };

/** Registration outcome of a plugin's MCP servers. */
export interface McpOutcome {
  local: number;
  remote: number;
}

/**
 * Registers the plugin's MCP servers with collision handling + prefixing.
 *
 * @param config - opencode's live resolved config, mutated in place.
 * @param pluginName - Plugin name (for reports and prefixed names).
 * @param specs - Validated MCP server specs from discovery.
 * @param prefix - When true, register as `<plugin>-<server>` instead.
 * @param state - Registration state (MCP names registered this run).
 * @param logger - Plugin logger.
 * @returns Local/remote counters of the registered servers.
 */
export async function registerMcpServers(
  config: RuntimeConfig,
  pluginName: string,
  specs: McpServerSpec[],
  prefix: boolean,
  state: RegisterState,
  logger: Logger,
): Promise<McpOutcome> {
  let local = 0;
  let remote = 0;
  for (const spec of specs) {
    const name = prefixedName(pluginName, spec, prefix);
    if (name === null) {
      await reportFailure(
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
  await reportFailure({ ...f, level: owner ? 'error' : 'warn' }, logger, { plugin: pluginName });
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
