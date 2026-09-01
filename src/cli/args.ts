/**
 * Minimal CLI argument parsing for `opencode-agent-plugins`.
 *
 * Deliberately tiny: the CLI is a thin wrapper over `src/lib/` and a full
 * argument framework would be a dependency with no payoff. Supports flags
 * with values (`--config <path>`), boolean flags, `--flag=value`, and
 * positionals, with `--` terminating flag parsing.
 */

/** Parsed command line. */
export interface ParsedArgs {
  /** Command name (first positional). */
  command: string;
  /** Remaining positionals. */
  positionals: string[];
  /** Flags in order of appearance (later values win). */
  flags: Map<string, string | boolean>;
}

/** Flags that take a value. */
const VALUE_FLAGS: ReadonlySet<string> = new Set(['--config', '--ref']);

/**
 * Parses an argv array (without node/script).
 *
 * @param argv - Arguments to parse.
 * @returns The parsed command line. `--help`/`--version` come through as
 * flags (the dispatcher handles them).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let terminated = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (terminated || arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      terminated = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (VALUE_FLAGS.has(name)) {
      if (eq !== -1) {
        flags.set(name, arg.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next === undefined) {
          flags.set(name, '');
        } else {
          flags.set(name, next);
          i += 1;
        }
      }
      continue;
    }
    flags.set(name, eq === -1 ? true : arg.slice(eq + 1));
  }
  return {
    command: positionals.shift() ?? '',
    positionals,
    flags,
  };
}

/** Returns a boolean flag (true when set, or `false` for `--flag=no`). */
export function boolFlag(flags: Map<string, string | boolean>, name: string): boolean {
  const value = flags.get(name);
  return value === true || (typeof value === 'string' && value !== 'no' && value !== 'false');
}

/**
 * Derives the config-file scope from the parsed flags.
 *
 * `--config <path>` wins over `--global`.
 *
 * @param args - Parsed command line.
 * @returns The config scope for lib calls.
 */
export function scopeOf(args: ParsedArgs): import('../lib/config-file.js').ConfigScope {
  const custom = args.flags.get('--config');
  if (typeof custom === 'string' && custom !== '') {
    return { kind: 'custom', path: custom };
  }
  if (boolFlag(args.flags, '--global')) {
    return { kind: 'global' };
  }
  return { kind: 'project', cwd: process.cwd() };
}
