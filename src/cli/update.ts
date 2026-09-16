/**
 * `check` and `update` commands (read-only status / apply updates).
 */

import { applyUpdates, runCheck } from '../lib/update.js';
import type { UpdateStatus } from '../lib/update.js';
import type { ConfigScope } from '../lib/config-file.js';
import { boolFlag, scopeOf, type ParsedArgs } from './args.js';

/**
 * Runs `check [<name>...]` — read-only, network-only.
 *
 * @param args - Parsed command line.
 * @returns The process exit code.
 */
export async function cmdCheck(args: ParsedArgs): Promise<number> {
  const statuses = await runCheck(args.positionals, scopeOf(args));
  printStatuses(statuses);
  return statuses.some((s) => s.status === 'update-available') ? 2 : 0;
}

/**
 * Runs `update [<name>...] [--yes] [--force] [--dry-run]`.
 *
 * Without `--yes` it prints the changes it is about to apply, then applies
 * them. With `--dry-run` it stops after that preview: nothing is staged,
 * swapped, or written.
 *
 * @param args - Parsed command line.
 * @returns The process exit code.
 */
export async function cmdUpdate(args: ParsedArgs): Promise<number> {
  const force = boolFlag(args.flags, '--force');
  if (boolFlag(args.flags, '--dry-run')) {
    printUpdatePreview(await updateCandidates(args.positionals, scopeOf(args)));
    console.log('dry-run: nothing was written.');
    return 0;
  }
  if (!boolFlag(args.flags, '--yes')) {
    if (!printUpdatePreview(await updateCandidates(args.positionals, scopeOf(args)))) {
      return 0;
    }
  }
  const statuses = await applyUpdates(args.positionals, scopeOf(args), { force });
  for (const status of statuses) {
    if (status.status === 'update-available') {
      // Applied in this run: the design's "updated … Restart OpenCode to
      // pick it up." message (§5.12.3).
      console.log(`updated ${status.detail ?? status.source}. Restart OpenCode to pick it up.`);
    } else {
      printStatusLine(status);
    }
  }
  return statuses.some((s) => s.status === 'update-available') ? 0 : 1;
}

/**
 * Selects the statuses `update` acts on: commit drift (branch/HEAD sources)
 * plus moved tags (`--force` decides whether the apply path follows them).
 *
 * @param names - Filter by slug; empty = all.
 * @param configScope - Config scope for store and path-source resolution.
 * @returns The actionable statuses.
 */
async function updateCandidates(
  names: string[],
  configScope: ConfigScope,
): Promise<UpdateStatus[]> {
  const statuses = await runCheck(names, configScope);
  return statuses.filter((s) => s.status === 'update-available' || s.status === 'moved-tag');
}

/**
 * Prints the update preview.
 *
 * @param changes - The actionable statuses.
 * @returns `true` when there is at least one update to show, `false` after
 * printing the "nothing to update." line.
 */
function printUpdatePreview(changes: UpdateStatus[]): boolean {
  if (changes.length === 0) {
    console.log('nothing to update.');
    return false;
  }
  for (const status of changes) {
    console.log(
      `${status.source}: ${status.status}${status.detail === undefined ? '' : ` (${status.detail})`}`,
    );
  }
  return true;
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
