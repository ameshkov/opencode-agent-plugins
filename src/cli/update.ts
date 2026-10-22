/**
 * `check` and `update` commands (read-only status / apply updates).
 */

import { applyUpdates, runCheck, UpdateTargetError } from '../lib/update.js';
import type { UpdateStatus } from '../lib/update.js';
import { boolFlag, scopeOf, type ParsedArgs } from './args.js';
import { reloadAfter } from './reload.js';

/**
 * Runs `check [<name>...]` — read-only, network-only.
 *
 * @param args - Parsed command line.
 * @returns The process exit code.
 */
export async function cmdCheck(args: ParsedArgs): Promise<number> {
  let statuses: UpdateStatus[];
  try {
    statuses = await runCheck(args.positionals, scopeOf(args));
  } catch (error) {
    return commandError(error);
  }
  printStatuses(statuses);
  return statuses.some((s) => s.status === 'update-available') ? 2 : 0;
}

/**
 * Runs `update [<name>...] [--yes] [--force] [--dry-run] [--no-reload]`.
 *
 * Without `--yes` it prints the changes it is about to apply, then applies
 * them. With `--dry-run` it stops after that preview: nothing is staged,
 * swapped, or written. A name that matches no store entry is an error.
 *
 * @param args - Parsed command line.
 * @returns The process exit code.
 */
export async function cmdUpdate(args: ParsedArgs): Promise<number> {
  try {
    return await runUpdate(args);
  } catch (error) {
    return commandError(error);
  }
}

/**
 * Applies an update command after the target names are validated.
 *
 * @param args - Parsed command line.
 * @returns The process exit code.
 */
async function runUpdate(args: ParsedArgs): Promise<number> {
  const force = boolFlag(args.flags, '--force');
  if (boolFlag(args.flags, '--dry-run')) {
    const preview = printUpdatePreview(await runCheck(args.positionals, scopeOf(args)));
    console.log('dry-run: nothing was written.');
    return preview.failed ? 1 : 0;
  }
  if (!boolFlag(args.flags, '--yes')) {
    const preview = printUpdatePreview(await runCheck(args.positionals, scopeOf(args)));
    if (!preview.hasChanges) {
      return preview.failed ? 1 : 0;
    }
  }
  const statuses = await applyUpdates(args.positionals, scopeOf(args), { force });
  if (statuses.length === 0) {
    console.log('nothing to update.');
    return 0;
  }
  let applied = false;
  for (const status of statuses) {
    if (status.status === 'update-available') {
      applied = true;
      console.log(`updated ${status.detail ?? status.source}.`);
    } else {
      printStatusLine(status);
    }
  }
  // A genuine no-op (everything is up to date) succeeds. A run that attempted
  // an update and could not apply it (invalid new tree, unreachable remote,
  // refused moved tag) fails, even when another entry updated successfully.
  const failed = statuses.some(
    (status) =>
      status.status === 'corrupted' ||
      status.status === 'unreachable' ||
      status.status === 'moved-tag',
  );
  if (applied) {
    await reloadAfter(args, 'Restart OpenCode to pick it up.');
  }
  return failed ? 1 : 0;
}

/**
 * Reports a failed check/update without a stack trace.
 *
 * An unmatched or ambiguous name ({@link UpdateTargetError}) and filesystem or
 * staging errors both reach the command boundary as thrown values; the CLI
 * prints the message and exits with code 1 (cli-lifecycle.md).
 *
 * @param error - The thrown value.
 * @returns 1.
 */
function commandError(error: unknown): number {
  if (error instanceof UpdateTargetError) {
    console.error(`error:   ${error.message}`);
    return 1;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error:   ${message}`);
  return 1;
}

/**
 * Prints the update preview: actionable changes plus failure statuses.
 *
 * A corrupted or unreachable entry is a failure even when another entry has
 * an update to apply. The preview reports it and the caller exits 1.
 *
 * @param statuses - Full status list from `check`.
 * @returns Whether there is at least one actionable change and whether any
 * failure status exists.
 */
function printUpdatePreview(statuses: UpdateStatus[]): {
  hasChanges: boolean;
  failed: boolean;
} {
  const changes = statuses.filter(
    (status) => status.status === 'update-available' || status.status === 'moved-tag',
  );
  const failed = statuses.filter(
    (status) => status.status === 'corrupted' || status.status === 'unreachable',
  );
  if (changes.length === 0 && failed.length === 0) {
    console.log('nothing to update.');
    return { hasChanges: false, failed: false };
  }
  for (const status of changes) {
    console.log(
      `${status.source}: ${status.status}${status.detail === undefined ? '' : ` (${status.detail})`}`,
    );
  }
  for (const status of failed) {
    printStatusLine(status);
  }
  return { hasChanges: changes.length > 0, failed: failed.length > 0 };
}

/** Prints one status line to stdout/stderr by severity. */
function printStatusLine(status: UpdateStatus): void {
  const source = status.source;
  const detail = status.detail === undefined ? '' : ` — ${status.detail}`;
  if (status.status === 'moved-tag') {
    console.error(`warn:   ${source}: ${status.status}${detail}`);
  } else if (status.status === 'corrupted' || status.status === 'unreachable') {
    console.error(`error:  ${source}: ${status.status}${detail}`);
  } else {
    console.log(`${source}: ${status.status}${detail}`);
  }
}

/** Prints update statuses one per line. */
function printStatuses(statuses: UpdateStatus[]): void {
  if (statuses.length === 0) {
    console.log('nothing to report.');
    return;
  }
  for (const status of statuses) {
    printStatusLine(status);
  }
}
