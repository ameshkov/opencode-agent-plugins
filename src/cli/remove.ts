/**
 * `remove` command: unregister + delete store entry and `PLUGIN_DATA`.
 */

import { removePlugin } from '../lib/remove.js';
import { findStoreEntry, metaPathFor, type StoreEntry } from '../lib/store.js';
import { dataDirForKey } from '../lib/data.js';
import { boolFlag, scopeOf, type ParsedArgs } from './args.js';
import { printConfigNote } from './output.js';
import { reloadAfter } from './reload.js';
import { confirm } from './prompts.js';

/**
 * Runs `remove <name> [--keep-data] [--yes] [--dry-run] [--no-reload]`.
 *
 * @param args - Parsed command line.
 * @returns The process exit code.
 */
export async function cmdRemove(args: ParsedArgs): Promise<number> {
  const name = args.positionals[0];
  if (name === undefined) {
    console.error('usage: opencode-agent-plugins remove <name> [options]');
    return 1;
  }
  const entries = await findStoreEntry(name);
  if (entries.length === 0) {
    console.error(
      `error:   "${name}" is not installed in the client store ` +
        '(path-sourced plugins are removed by editing the config)',
    );
    return 1;
  }
  if (entries.length > 1) {
    console.error(
      `error:   "${name}" matches multiple store entries (${entries.map((e) => e.slug).join(', ')}); use the slug`,
    );
    return 1;
  }
  const entry = entries[0]!;

  if (boolFlag(args.flags, '--dry-run')) {
    printRemovePlan(entry, boolFlag(args.flags, '--keep-data'));
    return 0;
  }
  if (!boolFlag(args.flags, '--yes')) {
    const ok = await confirm(
      `Remove ${entry.meta?.source ?? entry.slug} and delete its store entry and data?`,
      false,
    );
    if (!ok) {
      console.error('aborted.');
      return 1;
    }
  }
  const result = await removePlugin(name, {
    configScope: scopeOf(args),
    keepData: boolFlag(args.flags, '--keep-data'),
  });
  if (!result.ok) {
    return printRemoveFailure(result, args);
  }
  console.log(result.message ?? 'removed.');
  printConfigNote(result);
  await reloadAfter(args, 'Restart OpenCode to drop its tools and skills.');
  return 0;
}

/**
 * Prints a remove failure and returns 1.
 *
 * When the config edit already succeeded, the running location still has the
 * plugin loaded even though the on-disk deletion failed, so print the restart
 * hint as well.
 *
 * @param result - The failed remove result.
 * @param args - Parsed command line (for the reload opt-out flags).
 * @returns 1.
 */
async function printRemoveFailure(
  result: { failure: { message: string }; configEdited?: boolean },
  args: ParsedArgs,
): Promise<number> {
  console.error(`error:   ${result.failure.message}`);
  if (result.configEdited === true) {
    await reloadAfter(args, 'Restart OpenCode to drop its tools and skills.');
  }
  return 1;
}

/**
 * Prints the `remove --dry-run` plan.
 *
 * @param entry - The resolved store entry.
 * @param keepData - True when `--keep-data` was given.
 */
function printRemovePlan(entry: StoreEntry, keepData: boolean): void {
  console.log(`would remove ${entry.meta?.source ?? entry.slug} (${entry.slug})`);
  console.log(`would delete installed tree ${entry.root}`);
  console.log(`would delete metadata ${metaPathFor(entry.slug)}`);
  if (!keepData) {
    console.log(`would delete PLUGIN_DATA ${dataDirForKey(entry.slug)}`);
  }
  console.log('dry-run: nothing was written.');
}
