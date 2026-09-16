import { z } from 'zod';
import type { LogLevel } from './utils/index.js';

/**
 * Plugin options known to this plugin, in their validated, normalized form.
 *
 * Mirrors the `opencode-agent-plugins` entry in the user's `opencode.json`
 * `plugin` array — see `docs/explanation/design.md` §3.1.
 */
interface ValidatedOptions {
  /** Plugin source(s): local path, git URL, or an installed plugin name. */
  plugins: string[];
  /** True to namespace MCP server names as `<plugin-name>-<server>`. */
  prefix: boolean;
  /** Minimum severity forwarded to `client.app.log`. */
  logLevel: LogLevel;
}

/**
 * Zod schema for the plugin options object.
 *
 * Strict on known keys (unknown keys are reported as warnings by
 * {@link parseOptions}, never accepted); defaults applied per
 * `docs/explanation/design.md` §3.1.
 */
const optionsSchema = z
  .object({
    plugins: z.union([z.string(), z.array(z.string())]),
    prefix: z.boolean().default(false),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .strict();

/**
 * Parsed options plus the warnings collected while parsing.
 */
export interface OptionsParseResult {
  /** The validated options. */
  options: ValidatedOptions;
  /** Non-fatal warnings, e.g. unknown keys that were ignored. */
  warnings: string[];
}

/**
 * Parses the raw plugin options object with Zod.
 *
 * Unknown top-level keys are reported as warnings and stripped before
 * validation (the plugin is strict on known keys). A missing `plugins`
 * field or an invalid value of a known key throws.
 *
 * @param input - Raw options object from the opencode plugin tuple.
 * @returns The validated options and any warnings.
 * @throws {Error} If the options do not conform to the schema.
 */
export function parseOptions(input: unknown): OptionsParseResult {
  const raw = isRecord(input) ? input : {};
  const warnings: string[] = [];
  const known = new Set(Object.keys(optionsSchema.shape));
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (known.has(key)) {
      clean[key] = value;
    } else {
      warnings.push(`unknown option "${key}" ignored`);
    }
  }
  const result = optionsSchema.safeParse(clean);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid plugin options: ${issues}`);
  }
  const parsed = result.data;
  return {
    options: {
      plugins: typeof parsed.plugins === 'string' ? [parsed.plugins] : parsed.plugins,
      prefix: parsed.prefix,
      logLevel: parsed.logLevel,
    },
    warnings,
  };
}

/**
 * Checks whether the value is a plain object.
 *
 * @param value - Value to check.
 * @returns True when the value is a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
