/**
 * OpenCode Agent Plugins entry point (`docs/explanation/design.md` §5.1).
 *
 * The only hook is `config`: it resolves each configured source (local paths
 * in place, git sources against the client store — never fetching at
 * startup), validates the plugin package, discovers its skills and MCP
 * servers, creates `PLUGIN_DATA` for stdio servers, and registers everything
 * into the live config (see `src/register.ts`). Every per-plugin failure is
 * caught, mapped through the failure taxonomy (`src/lib/errors.ts`) and
 * logged; the hook never throws, and this module has no top-level side
 * effects (a throwing module would make OpenCode skip the plugin silently).
 */

import type { Plugin } from '@opencode-ai/plugin';
import { parseOptions, type OptionsParseResult } from './options.js';
import { createLogger } from './utils/index.js';
import { registerAgentPlugins } from './register.js';
import type { RuntimeConfig } from './register-types.js';

const agentPlugins: Plugin = async (input, options) => {
  let parsed: OptionsParseResult | undefined;
  try {
    parsed = parseOptions(options ?? {});
  } catch (error) {
    const logger = createLogger(input.client, 'info');
    await logger.error('failed to parse agent plugins options', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const logger = createLogger(input.client, parsed?.options.logLevel ?? 'info');
  await logger.info('plugin loading');

  return {
    config: async (config) => {
      try {
        await registerAgentPlugins(config as RuntimeConfig, parsed, logger, input);
      } catch (error) {
        // The hook must never throw: opencode would log a plugin error but
        // registration is isolated per plugin anyway (§5.1).
        await logger.error('agent plugins registration failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
};

export default agentPlugins;
