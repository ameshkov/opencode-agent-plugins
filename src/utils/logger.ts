import type { PluginInput } from '@opencode-ai/plugin';

/** Severity levels accepted by opencode's structured logging API. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Ordered severity ranks, used to filter by the configured `logLevel`. */
const LOG_LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Structured metadata attached to a log entry.
 *
 * Forwarded to opencode as the `extra` field of the log request.
 */
type LogExtra = Record<string, unknown>;

/**
 * Plugin logger. Each method writes a structured log entry to opencode's
 * server logs through the SDK client (`client.app.log`) and resolves once the
 * entry has been submitted.
 *
 * Entries below the configured {@link LogLevel} are dropped. Submission
 * failures are swallowed so that logging never breaks plugin startup or hook
 * execution, per the requirement that the plugin must not throw during load.
 */
export interface Logger {
  /** Writes a debug-level entry. */
  debug(message: string, extra?: LogExtra): Promise<void>;
  /** Writes an info-level entry. */
  info(message: string, extra?: LogExtra): Promise<void>;
  /** Writes a warning-level entry. */
  warn(message: string, extra?: LogExtra): Promise<void>;
  /** Writes an error-level entry. */
  error(message: string, extra?: LogExtra): Promise<void>;
}

/** Service name used to attribute every log entry to this plugin. */
const SERVICE = 'opencode-agent-plugins';

/**
 * Submits a single log entry via the opencode SDK client.
 *
 * Any rejection from `client.app.log` is swallowed so logging can never cause
 * the plugin to throw.
 *
 * @param client - opencode SDK client obtained from the plugin input.
 * @param level - Severity of the entry.
 * @param message - Human-readable message.
 * @param extra - Optional structured metadata.
 */
async function write(
  client: PluginInput['client'],
  level: LogLevel,
  message: string,
  extra?: LogExtra,
): Promise<void> {
  try {
    await client.app.log({
      body: {
        service: SERVICE,
        level,
        message,
        ...(extra === undefined ? {} : { extra }),
      },
    });
  } catch {
    // Logging must never break plugin startup or hook execution.
  }
}

/**
 * Creates a {@link Logger} backed by opencode's structured logging API.
 *
 * @param client - opencode SDK client from the plugin input.
 * @param logLevel - Minimum severity to forward; quieter entries are
 * dropped. Defaults to everything.
 * @returns A logger whose methods submit entries through `client.app.log`.
 */
export function createLogger(client: PluginInput['client'], logLevel: LogLevel = 'debug'): Logger {
  const minRank = LOG_LEVEL_RANK[logLevel];
  const submit = (level: LogLevel, message: string, extra?: LogExtra): Promise<void> =>
    LOG_LEVEL_RANK[level] < minRank ? Promise.resolve() : write(client, level, message, extra);
  return {
    debug: (message, extra) => submit('debug', message, extra),
    info: (message, extra) => submit('info', message, extra),
    warn: (message, extra) => submit('warn', message, extra),
    error: (message, extra) => submit('error', message, extra),
  };
}
