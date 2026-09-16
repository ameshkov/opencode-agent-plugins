/**
 * Failure taxonomy shared by the plugin and the CLI.
 *
 * Mirrors `docs/explanation/design.md` §6: each row of the taxonomy table maps a spec
 * failure condition to a failure boundary and a report level. Objects of type
 * {@link Failure} are the currency between `src/lib/` and the callers — the
 * plugin logs them through the structured logger, the CLI prints them — so
 * the classification asserted by tests is identical in both surfaces.
 */

import type { Logger } from '../utils/index.js';

/** Severity of a failure report, matching the logger levels. */
type FailureLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Failure kinds, one per taxonomy row (`docs/explanation/design.md` §6).
 *
 * The string values are stable identifiers used in tests and logs.
 */
export type FailureKind =
  | 'plugin-missing' // plugin.json missing/unparsable/realpath escapes root
  | 'manifest-schema' // unsupported $schema identifier (version)
  | 'manifest-fatal' // fatal manifest violation (required fields, name, author)
  | 'manifest-unknown-fields' // unknown top-level fields: reported + ignored
  | 'extensions-non-object' // non-object extensions: reported + ignored
  | 'extension-namespace' // unimplemented extension namespace: silently ignored
  | 'path-escape' // package path escapes the plugin root
  | 'skills-missing' // skills/ absent: valid absence
  | 'skills-invalid' // invalid skill: skip that skill
  | 'skills-collision' // skill name collides with an existing skills.paths entry
  | 'skills-nested' // SKILL.md deeper than skills/<name>/: warn
  | 'mcp-missing' // mcp.json absent: valid absence
  | 'mcp-invalid' // mcp.json invalid: disable MCP only
  | 'server-invalid' // invalid individual server entry: skip it
  | 'server-transport' // unsupported transport (sse): skip it
  | 'server-collision' // name collision with existing config.mcp entry
  | 'source-missing' // configured source not installed at startup
  | 'source-corrupt' // installed store entry corrupted / missing manifest
  | 'source-duplicate' // same source configured twice
  | 'install-fail' // install: fetch/clone/validation failure
  | 'check-unreachable' // check: remote unreachable / auth failure
  | 'update-ref' // update: moved tag / non-fast-forward ref
  | 'config-edit'; // CLI config edit conflicts or fails re-parse

/** Structured failure record produced by the taxonomy. */
export interface Failure {
  /** Stable taxonomy identifier. */
  kind: FailureKind;
  /** Human-readable message (exact text asserted in tests). */
  message: string;
  /** Level at which the failure should be reported. */
  level: FailureLevel;
  /** Structured metadata for the report (plugin name, component, spec ref). */
  extra?: Record<string, unknown>;
}

/**
 * Maps every failure kind to its report level, per `docs/explanation/design.md` §6.
 *
 * @internal Exported for tests only; not part of the public module API. The
 * test suite iterates its keys to prove the level mapping is exhaustive for
 * every declared kind, so the record can never drift from the union.
 */
export const FAILURE_LEVEL: Record<FailureKind, FailureLevel> = {
  'plugin-missing': 'error',
  'manifest-schema': 'error',
  'manifest-fatal': 'error',
  'manifest-unknown-fields': 'warn',
  'extensions-non-object': 'warn',
  'extension-namespace': 'debug',
  'path-escape': 'warn',
  'skills-missing': 'debug',
  'skills-invalid': 'warn',
  'skills-collision': 'warn',
  'skills-nested': 'warn',
  'mcp-missing': 'debug',
  'mcp-invalid': 'error',
  'server-invalid': 'warn',
  'server-transport': 'warn',
  'server-collision': 'warn',
  'source-missing': 'warn',
  'source-corrupt': 'error',
  'source-duplicate': 'warn',
  'install-fail': 'error',
  'check-unreachable': 'warn',
  'update-ref': 'warn',
  'config-edit': 'error',
};

/**
 * Builds a {@link Failure} for a taxonomy kind.
 *
 * The report level is derived from the kind (see {@link FAILURE_LEVEL}), so
 * callers only have to name the boundary and describe what happened. Extra
 * metadata is passed through verbatim.
 *
 * @param kind - Taxonomy identifier of the failure.
 * @param message - Human-readable description of what happened.
 * @param extra - Optional structured metadata for the report.
 * @returns A failure record with the level fixed by the taxonomy.
 */
export function failure(
  kind: FailureKind,
  message: string,
  extra?: Record<string, unknown>,
): Failure {
  return { kind, message, level: FAILURE_LEVEL[kind], extra };
}

/** @internal Exported for tests only; not part of the public module API. */
export function levelOf(kind: FailureKind): FailureLevel {
  return FAILURE_LEVEL[kind];
}

/**
 * Reports a taxonomy failure through a structured logger at its level.
 *
 * The failure kind is merged into the structured metadata as `boundary`, so
 * log consumers can classify a report without parsing the message. Levels
 * below the logger's threshold are dropped by the logger itself.
 *
 * @param f - The failure to report.
 * @param logger - Plugin logger.
 * @param extra - Additional structured metadata merged into the report.
 */
export async function reportFailure(
  f: Failure,
  logger: Logger,
  extra: Record<string, unknown> = {},
): Promise<void> {
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
