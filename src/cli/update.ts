/**
 * `check` and `update` commands (read-only status / apply updates).
 */

import { applyUpdates, runCheck } from '../lib/update.js';
import type { UpdateStatus } from '../lib/update.js';
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
 * Runs `update [<name>...] [--yes] [--force]`.
 *
 * @param args - Parsed command line.
 * @returns The process exit code.
 */
export async function cmdUpdate(args: ParsedArgs): Promise<number> {
  if (!boolFlag(args.flags, '--yes')) {
    const changes = (await runCheck(args.positionals, scopeOf(args))).filter(
      (s) => s.status === 'update-available' || s.status === 'moved-tag',
    );
    if (changes.length === 0) {
      console.log('nothing to update.');
      return 0;
    }
    for (const status of changes) {
      console.log(
        `${status.source}: ${status.status}${status.detail === undefined ? '' : ` (${status.detail})`}`,
      );
    }
  }
  const statuses = await applyUpdates(args.positionals, scopeOf(args), {
    force: boolFlag(args.flags, '--force'),
  });
  printStatuses(statuses);
  return statuses.some((s) => s.status === 'update-available') ? 0 : 1;
}

/** Prints update statuses one per line. */
function printStatuses(statuses: UpdateStatus[]): void {
  if (statuses.length === 0) {
    console.log('nothing to report.');
    return;
  }
  for (const status of statuses) {
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
}
