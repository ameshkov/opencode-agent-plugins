/**
 * Structured logging for the plugin entry (`docs/explanation/design.md` §5.10).
 *
 * OpenCode V2's plugin context exposes no logging API, so entries are written
 * to the console (the host captures plugin output — `opencode serve
 * --print-logs` shows it). The logger keeps the V1 contract: entries below the
 * configured level are dropped, submission failures are swallowed, and logging
 * never throws. The sink is injectable so tests can record entries without
 * touching the console.
 */

/** Severity levels emitted by the logger. */
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
 * Rendered as a trailing JSON object on the log line.
 */
type LogExtra = Record<string, unknown>;

/**
 * Destination for formatted log entries.
 *
 * The default sink writes to the console; tests inject a recording sink.
 */
export interface LogSink {
  /** Writes a debug-level entry. */
  debug(message: string, extra?: LogExtra): void;
  /** Writes an info-level entry. */
  info(message: string, extra?: LogExtra): void;
  /** Writes a warning-level entry. */
  warn(message: string, extra?: LogExtra): void;
  /** Writes an error-level entry. */
  error(message: string, extra?: LogExtra): void;
}

/**
 * Plugin logger. Each method submits a structured log entry to the configured
 * {@link LogSink} and resolves once the entry has been submitted.
 *
 * Entries below the configured {@link LogLevel} are dropped. Submission
 * failures are swallowed so that logging never breaks plugin startup or
 * registration execution, per the requirement that the plugin must not throw
 * during load.
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
 * Formats one entry as a single line with the level and structured metadata.
 *
 * The design requires the level on the line (`docs/explanation/design.md`
 * §5.10: "level, message, extra"): the console sink routes `debug` and `info`
 * to stdout, so the level is otherwise unrecoverable from captured output.
 *
 * @param level - Severity of the entry.
 * @param message - Human-readable message.
 * @param extra - Optional structured metadata.
 * @returns The formatted line.
 */
function formatEntry(level: LogLevel, message: string, extra?: LogExtra): string {
  const metadata = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  return `[${SERVICE}] ${level} ${message}${metadata}`;
}

/** Sink that writes to the console (captured by OpenCode). */
const consoleSink: LogSink = {
  debug: (message, extra) => console.debug(formatEntry('debug', message, extra)),
  info: (message, extra) => console.info(formatEntry('info', message, extra)),
  warn: (message, extra) => console.warn(formatEntry('warn', message, extra)),
  error: (message, extra) => console.error(formatEntry('error', message, extra)),
};

/**
 * Creates a {@link Logger} backed by the given sink.
 *
 * @param logLevel - Minimum severity to forward; quieter entries are dropped.
 * Defaults to everything.
 * @param sink - Destination for the entries. Defaults to the console sink.
 * @returns A logger whose methods submit entries through the sink.
 */
export function createLogger(logLevel: LogLevel = 'debug', sink: LogSink = consoleSink): Logger {
  const minRank = LOG_LEVEL_RANK[logLevel];
  const submit = (level: LogLevel, message: string, extra?: LogExtra): Promise<void> => {
    if (LOG_LEVEL_RANK[level] >= minRank) {
      try {
        sink[level](message, extra);
      } catch {
        // Logging must never break plugin startup or registration execution.
      }
    }
    return Promise.resolve();
  };
  return {
    debug: (message, extra) => submit('debug', message, extra),
    info: (message, extra) => submit('info', message, extra),
    warn: (message, extra) => submit('warn', message, extra),
    error: (message, extra) => submit('error', message, extra),
  };
}
