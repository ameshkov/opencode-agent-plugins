/**
 * OpenCode Agent Plugins entry point (`docs/explanation/architecture.md`).
 *
 * The plugin is a V2 plugin definition (`{ id, setup }`) with a single
 * `setup`: it resolves each configured source (local paths in place, git
 * sources against the client store — never fetching at startup), validates
 * the plugin package, discovers its skills and MCP servers, creates
 * `PLUGIN_DATA` for stdio servers, and registers everything through the V2
 * context's `skill`
 * and `mcp` transforms (see `src/register.ts`). Every per-plugin failure is
 * caught, mapped through the failure taxonomy (`src/lib/errors.ts`) and
 * logged; `setup` never throws, and this module has no top-level side effects
 * (a throwing module would make OpenCode skip the plugin; V2 logs `failed to
 * load plugin`, but none of the plugin's own diagnostics run).
 *
 * The default export is a plain definition object rather than
 * `Plugin.define(...)`: the V2 host accepts any default definition with an
 * `id` and a `setup` function, `Plugin.define` is an identity function, and
 * avoiding the value import keeps the plugin entry and the shared core free
 * of runtime `@opencode/*` dependencies. The CLI layer depends on
 * `@opencode/client` only for the reload call (AGENTS.md, "Dependency
 * Management"). The type-only `Context` import below makes `pnpm typecheck`
 * fail if the V2 context ever stops satisfying the registration pipeline's
 * expectations.
 */

import type { Context } from '@opencode/plugin/promise/plugin';
import { parseOptions, type OptionsParseResult } from './options.js';
import { createLogger } from './utils/index.js';
import { registerAgentPlugins } from './register.js';

/** Stable plugin id, used by OpenCode for status and storage scoping. */
const PLUGIN_ID = 'opencode-agent-plugins';

const agentPlugins = {
  id: PLUGIN_ID,
  async setup(context: Context): Promise<void> {
    let parsed: OptionsParseResult | undefined;
    try {
      parsed = parseOptions(context.options ?? {});
    } catch (error) {
      const logger = createLogger('info');
      await logger.error('failed to parse agent plugins options', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const logger = createLogger(parsed?.options.logLevel ?? 'info');
    await logger.info('plugin loading');

    try {
      await registerAgentPlugins(context, parsed, logger);
    } catch (error) {
      // setup must never throw: OpenCode would log a plugin error but
      // registration is isolated per plugin anyway (architecture.md).
      await logger.error('agent plugins registration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
};

export default agentPlugins;
