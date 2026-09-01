#!/usr/bin/env node
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };

/** Commands of the CLI, per `docs/design.md` §5.11. */
const COMMANDS = ['install', 'remove', 'check', 'update', 'list', 'doctor', 'prune'] as const;

type Command = (typeof COMMANDS)[number];

/**
 * Prints the CLI usage to stdout and exits with code 0.
 */
function printHelp(): void {
  console.log(`opencode-agent-plugins ${packageJson.version}

Usage: opencode-agent-plugins <command> [args] [options]

Manages Agent Plugins for OpenCode: installs plugin packages (local path or
git URL), registers them in the OpenCode config, and manages their lifecycle.

Commands:
  install <source> [--ref <ref>] [--global | --config <path>] [--yes] [--dry-run] [--no-register]
      Fetches the source, validates it, previews components, asks for
      confirmation, and registers it in the OpenCode config.
  remove <name> [--keep-data] [--yes]
      Unregisters from the OpenCode config and deletes the store entry and
      its PLUGIN_DATA.
  check [<name>...]
      Read-only update check (network): resolves the remote ref and compares
      with the recorded commit. No names = all plugins.
  update [<name>...] [--yes] [--force]
      Applies available updates (staging -> validate -> atomic swap).
  list
      Shows installed plugins: source kind, URL/ref, resolved commit,
      manifest version, status.
  doctor
      Read-only health report of store/config drift.
  prune [--yes]
      Removes what doctor lists as orphaned or stale.

Options:
  -h, --help      Show this help.
  -v, --version   Show the version.

The git binary is required only by git-backed commands (install from a URL,
check, update); list, remove, doctor, prune, and path-sourced install work
without it.`);
}

/**
 * Parses `--help`/`--version` flags and dispatches to a command.
 *
 * @param args - CLI arguments (process argv without node/script).
 * @returns The process exit code.
 */
export async function run(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    return 0;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(packageJson.version);
    return 0;
  }

  const [command] = args;
  if (!isCommand(command)) {
    console.error(`unknown command: "${command}"`);
    console.error('Run "opencode-agent-plugins --help" for usage.');
    return 1;
  }

  console.error(
    `"opencode-agent-plugins ${command}" is not implemented yet (scaffold). ` +
      `Tracked plan: docs/design.md §5.11.`,
  );
  return 1;
}

/**
 * Checks whether the string names a known command.
 *
 * @param value - Candidate command name.
 * @returns True when the value is one of the CLI commands.
 */
function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

const exitCode = await run(process.argv.slice(2));
process.exit(exitCode);
