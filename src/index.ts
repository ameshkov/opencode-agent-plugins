import type { Config, Plugin } from '@opencode-ai/plugin';
import { parseOptions, type OptionsParseResult } from './options.js';
import { createLogger, type Logger } from './utils/index.js';

/**
 * Registers the configured agent plugins onto the opencode config.
 *
 * For now this is a scaffold: it validates the options (any failures are
 * logged by the entry point before this is called), logs the sources that
 * will be registered, and normalizes `config.skills` to the runtime schema
 * so later iterations can register plugin skills and MCP servers per
 * `docs/design.md` §3.2 and §5.6–§5.8. Any error is logged and swallowed so
 * the hook never throws.
 *
 * @param config - opencode's live resolved config, mutated in place.
 * @param parsed - The parsed plugin options, or undefined when parsing
 * failed (the failure is logged by the entry point).
 * @param logger - Plugin logger.
 */
async function registerAgentPlugins(
  config: Config,
  parsed: OptionsParseResult | undefined,
  logger: Logger,
): Promise<void> {
  if (parsed === undefined) {
    return;
  }
  try {
    for (const warning of parsed.warnings) {
      await logger.warn(warning);
    }
    // The runtime schema (opencode.ai/config.json) is authoritative; the
    // installed SDK type may not expose `skills` yet, so normalize through a
    // local cast (docs/design.md §5.1 Defensive note).
    const runtimeConfig = config as Config & { skills?: { paths: string[] } };
    runtimeConfig.skills ??= { paths: [] };
    for (const source of parsed.options.plugins) {
      await logger.info('will register agent plugin source', { source });
    }
    await logger.info('agent plugins configured', {
      count: parsed.options.plugins.length,
    });
  } catch (error) {
    await logger.error('failed to register agent plugins', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * OpenCode Agent Plugins client entry point.
 *
 * The plugin is configured as `["opencode-agent-plugins", { ...options }]`
 * in the user's `opencode.json`. It registers skills and MCP servers from
 * Agent Plugins packages into the live config (see `docs/design.md`). The
 * `config` hook is the only hook used; it never throws — every failure is
 * reported through the structured logger.
 *
 * Import-safety note: there are no top-level side effects; all work happens
 * inside the hooks.
 */
const agentPlugins: Plugin = async (input, options) => {
  let parsed: OptionsParseResult | undefined;
  try {
    parsed = parseOptions(options ?? {});
  } catch (error) {
    // `logLevel` could not be determined from invalid options; the design
    // default applies.
    const logger = createLogger(input.client, 'info');
    await logger.error('failed to parse agent plugins options', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const logger = createLogger(input.client, parsed?.options.logLevel ?? 'info');
  await logger.info('plugin loading');

  return {
    config: async (config) => {
      await registerAgentPlugins(config, parsed, logger);
    },
  };
};

export default agentPlugins;
