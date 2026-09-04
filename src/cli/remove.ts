/**
 * `remove` command: unregister + delete store entry and `PLUGIN_DATA`.
 */

import { removePlugin } from '../lib/install.js';
import { findStoreEntry } from '../lib/store.js';
import { dataDirForKey } from '../lib/data.js';
import { boolFlag, scopeOf, type ParsedArgs } from './args.js';
import { printConfigNote } from './output.js';
import { confirm } from './prompts.js';

/**
 * Runs `remove <name> [--keep-data] [--yes]`.
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
    console.log(`would remove ${entry.meta?.source ?? entry.slug} (${entry.slug})`);
    if (!boolFlag(args.flags, '--keep-data')) {
      console.log(`would delete PLUGIN_DATA ${dataDirForKey(entry.slug)}`);
    }
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
    console.error(`error:   ${result.failure.message}`);
    return 1;
  }
  console.log(result.message ?? 'removed.');
  printConfigNote(result);
  return 0;
}
