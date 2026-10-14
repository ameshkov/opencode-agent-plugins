/**
 * MCP server registration for the plugin entry (`docs/explanation/design.md` §5.7).
 *
 * Registers validated `McpServerSpec`s through a V2 `ctx.mcp.transform`,
 * applying name sanitization and the user-config-wins collision rule. Lives
 * in `src/` (not `src/lib/`) because it talks to the V2 plugin context; the
 * `src/lib/mcp.ts` discovery half stays opencode-free.
 *
 * Collision detection runs inside the transform callback because V2 replays
 * transforms during a batched registry rebuild: the editor is the
 * authoritative view of config-defined and earlier plugin servers, and the
 * callback may run after `transform()` resolves. Counters are therefore
 * *attempted* registrations; collisions are reported separately from the
 * callback.
 */

import {
  isValidServerName,
  sanitizeServerName,
  type McpConfigLike,
  type McpServerSpec,
} from './lib/mcp.js';
import { failure, reportFailure } from './lib/errors.js';
import type { Logger } from './utils/index.js';
import type { RegisterState, RegistrationContext } from './register-types.js';

/** Registration outcome of a plugin's MCP servers. */
export interface McpOutcome {
  local: number;
  remote: number;
}

/** A server ready to register, with its effective (possibly prefixed) name. */
interface RegistrableServer {
  name: string;
  spec: McpServerSpec;
}

/**
 * Registers the plugin's MCP servers with collision handling + prefixing.
 *
 * @param context - The V2 plugin context (MCP domain).
 * @param pluginName - Plugin name (for reports and prefixed names).
 * @param specs - Validated MCP server specs from discovery.
 * @param prefix - When true, register as `<plugin>-<server>` instead.
 * @param state - Registration state (MCP names registered this run).
 * @param logger - Plugin logger.
 * @returns Local/remote counters of the attempted registrations.
 */
export async function registerMcpServers(
  context: RegistrationContext,
  pluginName: string,
  specs: McpServerSpec[],
  prefix: boolean,
  state: RegisterState,
  logger: Logger,
): Promise<McpOutcome> {
  const registrable = await collectRegistrable(pluginName, specs, prefix, logger);
  if (registrable.length === 0) {
    return { local: 0, remote: 0 };
  }
  await context.mcp.transform((editor) => {
    for (const { name, spec } of registrable) {
      if (editor.get(name) !== undefined) {
        // Fire-and-forget: the callback may replay after setup returns and
        // the logger never rejects.
        void reportCollision(name, spec, pluginName, state, logger);
        continue;
      }
      const config: McpConfigLike | undefined = spec.config;
      if (config === undefined) {
        // Discovery only yields local/remote specs, which always carry a config.
        continue;
      }
      editor.set(name, config);
      state.registeredMcp.add(name);
    }
  });
  return countOutcome(registrable);
}

/**
 * Filters the specs down to registrable servers, reporting invalid names.
 *
 * @param pluginName - Plugin name (for reports and prefixed names).
 * @param specs - Validated MCP server specs from discovery.
 * @param prefix - When true, register as `<plugin>-<server>` instead.
 * @param logger - Plugin logger.
 * @returns The servers that may be registered.
 */
async function collectRegistrable(
  pluginName: string,
  specs: McpServerSpec[],
  prefix: boolean,
  logger: Logger,
): Promise<RegistrableServer[]> {
  const registrable: RegistrableServer[] = [];
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
    registrable.push({ name, spec });
  }
  return registrable;
}

/**
 * Counts the local/remote servers that were attempted.
 *
 * @param registrable - Servers that passed name validation.
 * @returns The local/remote counters.
 */
function countOutcome(registrable: RegistrableServer[]): McpOutcome {
  let local = 0;
  let remote = 0;
  for (const { spec } of registrable) {
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
