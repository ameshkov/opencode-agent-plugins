/**
 * `install` command: fetch → validate → preview → confirm → register.
 */

import { applyInstall, prepareInstall } from '../lib/install.js';
import { removeTree } from '../lib/move.js';
import type { InstallPlan, OpResult } from '../lib/install.js';
import { probeConfig } from '../lib/config-edit.js';
import { boolFlag, scopeOf, type ParsedArgs } from './args.js';
import { printConfigNote } from './output.js';
import { reloadAfter } from './reload.js';
import { confirm } from './prompts.js';

/** Warning printed when the config has no `opencode-agent-plugins` entry. */
const ENTRY_WARNING =
  'warn:    your opencode config has no "opencode-agent-plugins" plugin entry; ' +
  'OpenCode will not load it for the registered source';

/** Note printed when the loader entry is still the legacy V1 tuple form. */
const LEGACY_NOTE =
  'note:    your config uses the legacy V1 "plugin" tuple; it will be migrated to the V2 "plugins" entry';

/**
 * Runs `install <source> [--ref <ref>] [--global|--config <path>] [--yes]
 * [--dry-run] [--no-register] [--no-reload]`.
 *
 * @param args - Parsed command line.
 * @returns The process exit code.
 */
export async function cmdInstall(args: ParsedArgs): Promise<number> {
  const source = args.positionals[0];
  if (source === undefined) {
    console.error('usage: opencode-agent-plugins install <source> [options]');
    return 1;
  }
  let plan: InstallPlan | undefined;
  try {
    const ref = args.flags.get('--ref');
    const prepared = await prepareInstall(
      source,
      process.cwd(),
      process.env,
      typeof ref === 'string' && ref !== '' ? ref : undefined,
    );
    if (!prepared.ok || prepared.plan === undefined) {
      return printFailure(prepared);
    }
    plan = prepared.plan;
    return await runInstallPlan(args, plan);
  } catch (error) {
    // A filesystem or staging error must not escape as a stack trace: drop
    // the throwaway staging tree and report the message like any other
    // install failure (cli-lifecycle.md).
    if (plan !== undefined) {
      await abortStagedPlan(plan);
    }
    console.error(`error:   ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/**
 * Previews and applies a prepared install.
 *
 * @param args - Parsed command line.
 * @param plan - The prepared plan.
 * @returns The process exit code.
 */
async function runInstallPlan(args: ParsedArgs, plan: InstallPlan): Promise<number> {
  printPlan(plan);

  if (plan.validated.fatal) {
    // cli-lifecycle.md: failure at any validation step aborts with nothing changed on
    // disk — before confirmation, and dropping the throwaway staging dir.
    await abortStagedPlan(plan);
    return 1;
  }

  if (boolFlag(args.flags, '--dry-run')) {
    return abortDryRun(plan);
  }

  if (!boolFlag(args.flags, '--no-register') && !(await ensureLoaderEntry(args))) {
    await abortStagedPlan(plan);
    return 1;
  }

  if (!boolFlag(args.flags, '--yes') && !(await confirmInstall())) {
    await abortStagedPlan(plan);
    return 1;
  }
  const result = await applyInstall(plan, {
    configScope: scopeOf(args),
    noRegister: boolFlag(args.flags, '--no-register'),
  });
  if (!result.ok) {
    return printFailure(result);
  }
  printInstallResult(result, plan, args);
  await reloadAfter(
    args,
    'Restart OpenCode to use it.',
    undefined,
    'Add the config snippet above, then restart OpenCode to use it.',
  );
  return 0;
}

/**
 * Prints the success output: message, config note, optional snippet.
 *
 * @param result - The successful operation result.
 * @param plan - The applied plan (for the `--no-register` snippet).
 * @param args - Parsed command line.
 */
function printInstallResult(
  result: { message?: string; configNote?: string },
  plan: InstallPlan,
  args: ParsedArgs,
): void {
  console.log(result.message ?? 'installed.');
  printConfigNote(result);
  if (boolFlag(args.flags, '--no-register')) {
    console.log(
      `\nAdd this to your opencode config's "plugins" array:\n` +
        `  { "package": "opencode-agent-plugins", "options": { "plugins": ["${plan.raw}"] } }`,
    );
  }
}

/**
 * Ensures the opencode config that `install` will edit contains the
 * `{ package: "opencode-agent-plugins", … }` loader entry (or the legacy V1
 * tuple, which the write migrates).
 *
 * When the entry is missing, any source registered on its own is inert —
 * OpenCode never loads the loader plugin, so the config edit would be
 * useless and `doctor` would report the source as unreferenced. The CLI
 * therefore warns and, in interactive mode, asks the user to add the entry
 * before registering (cli-lifecycle.md). `--yes` auto-adds (print-only warning);
 * declining aborts the install with nothing written.
 *
 * @param args - Parsed command line (for the config scope and `--yes`).
 * @returns `true` when registering may proceed (entry present or the user
 * accepted adding it).
 */
async function ensureLoaderEntry(args: ParsedArgs): Promise<boolean> {
  const probe = await probeConfig(scopeOf(args));
  if (probe.hasEntry) {
    if (probe.legacyTuple) {
      console.error(LEGACY_NOTE);
    }
    return true;
  }
  console.error(ENTRY_WARNING);
  console.error(`config:   ${probe.path}`);
  if (boolFlag(args.flags, '--yes')) {
    return true;
  }
  const ok = await confirm(
    'Add the "opencode-agent-plugins" entry to your opencode config so the source is loaded?',
    true,
  );
  if (!ok) {
    console.error('aborted: the plugin was not registered.');
  }
  return ok;
}

/**
 * Removes the throwaway staging dir of an aborted plan (git kind only; path
 * sources are used in place and must never be deleted).
 *
 * @param plan - The prepared plan.
 */
async function abortStagedPlan(plan: InstallPlan): Promise<void> {
  if (plan.kind === 'git') {
    // Best-effort: the abort must not turn into a raw filesystem error.
    await removeTree(plan.stagingDir ?? plan.root).catch(() => undefined);
  }
}

/**
 * Aborts a `--dry-run` after the preview: drops the staging dir and reports
 * that nothing was written.
 *
 * @param plan - The prepared plan.
 * @returns The process exit code (0).
 */
async function abortDryRun(plan: InstallPlan): Promise<number> {
  await abortStagedPlan(plan);
  console.log('dry-run: nothing was written.');
  return 0;
}

/**
 * Asks for install confirmation.
 *
 * @returns True when the user accepted; false after printing the abort line.
 */
async function confirmInstall(): Promise<boolean> {
  const ok = await confirm('Install this plugin?', false);
  if (!ok) {
    console.error('aborted.');
  }
  return ok;
}

/** Prints the install preview (manifest, skills, servers, warnings). */
function printPlan(plan: InstallPlan): void {
  const manifest = plan.validated.manifest;
  console.log(
    `Plugin: ${manifest.name}${manifest.version === undefined ? '' : ` v${manifest.version}`}`,
  );
  console.log(
    `Source: ${plan.raw}${plan.resolvedCommit === undefined ? '' : ` (commit ${plan.resolvedCommit.slice(0, 12)})`}`,
  );
  if (plan.validated.skills.length > 0) {
    console.log(`Skills:  ${plan.validated.skills.join(', ')}`);
  } else {
    console.log('Skills:  (none)');
  }
  if (plan.validated.servers.length > 0) {
    for (const server of plan.validated.servers) {
      const headers = server.headers.length > 0 ? ` headers: ${server.headers.join(', ')}` : '';
      console.log(`MCP:     ${server.name} (${server.kind}) ${server.target}${headers}`);
    }
  } else {
    console.log('MCP:     (none)');
  }
  for (const warning of plan.validated.warnings) {
    console.error(`warn:    ${warning.message}`);
  }
  if (plan.validated.fatal) {
    console.error('error:   the plugin failed validation; install will abort.');
  }
}

/** Prints a failure and returns a non-zero exit code. */
function printFailure(result: OpResult): number {
  if (!result.ok) {
    console.error(`error:   ${result.failure.message}`);
  }
  return 1;
}
