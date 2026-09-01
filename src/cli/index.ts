#!/usr/bin/env node
/**
 * CLI entry (`docs/design.md` §5.11): the `opencode-agent-plugins` binary.
 *
 * Thin wrapper over `src/lib/`, run on Node ≥ 22 outside OpenCode. The `git`
 * binary is required only by git-backed commands (`install` from a URL,
 * `check`, `update`) — it is checked lazily when such a command runs.
 */

import { createRequire } from 'node:module';
import { parseArgs, boolFlag } from './args.js';
import { cmdInstall } from './install.js';
import { cmdRemove } from './remove.js';
import { cmdCheck, cmdUpdate } from './update.js';
import { cmdDoctor, cmdList, cmdPrune } from './inspect.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json') as { version: string };

/**
 * Prints the CLI usage to stdout.
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
 * Dispatches a parsed command line to the command implementation.
 *
 * @param argv - CLI arguments (process argv without node/script).
 * @returns The process exit code.
 */
export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (boolFlag(args.flags, '--version') || boolFlag(args.flags, '-v')) {
    console.log(packageJson.version);
    return 0;
  }
  if (boolFlag(args.flags, '--help') || boolFlag(args.flags, '-h') || args.command === '') {
    printHelp();
    return 0;
  }
  switch (args.command) {
    case 'install':
      return cmdInstall(args);
    case 'remove':
      return cmdRemove(args);
    case 'check':
      return cmdCheck(args);
    case 'update':
      return cmdUpdate(args);
    case 'list':
      return cmdList();
    case 'doctor':
      return cmdDoctor(args);
    case 'prune':
      return cmdPrune(args);
    default:
      console.error(`unknown command: "${args.command}"`);
      console.error('Run "opencode-agent-plugins --help" for usage.');
      return 1;
  }
}

const exitCode = await run(process.argv.slice(2));
process.exit(exitCode);
