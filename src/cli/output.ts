/**
 * Shared CLI output helpers.
 */

import type { ReloadOutcome } from './reload.js';

/**
 * Prints the config-file announcement carried by a successful result (cli-lifecycle.md).
 *
 * `install` and `remove` edit the resolved config; when `opencode.jsonc` was
 * preferred over `opencode.json`, the result carries a note so the user knows
 * which file was changed.
 *
 * @param result - A successful operation result (only `configNote` is read).
 */
export function printConfigNote(result: { configNote?: string }): void {
  if (result.configNote !== undefined) {
    console.log(result.configNote);
  }
}

/**
 * Prints the outcome of a best-effort reload.
 *
 * A successful reload replaces the restart hint. A missing service or a failed
 * request keeps the command's deterministic fallback: the hint printed by
 * earlier releases.
 *
 * @param outcome - The reload result.
 * @param restartHint - The command-specific restart message.
 */
export function printReloadOutcome(outcome: ReloadOutcome, restartHint: string): void {
  switch (outcome.status) {
    case 'reloaded':
      console.log('OpenCode reloaded; the change applies where this config is loaded.');
      break;
    case 'no-service':
      console.log(restartHint);
      break;
    case 'failed':
      console.error(`warn:    could not reload OpenCode: ${outcome.message}`);
      console.log(restartHint);
      break;
  }
}
