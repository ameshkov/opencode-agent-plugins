/**
 * Shared CLI output helpers.
 */

import type { OpResult } from '../lib/install.js';

/**
 * Prints the config-file announcement carried by a successful result (§5.11).
 *
 * `install` and `remove` edit the resolved config; when `opencode.jsonc` was
 * preferred over `opencode.json`, the result carries a note so the user knows
 * which file was changed.
 *
 * @param result - A successful operation result.
 */
export function printConfigNote(result: OpResult): void {
  if (result.ok && result.configNote !== undefined) {
    console.log(result.configNote);
  }
}
