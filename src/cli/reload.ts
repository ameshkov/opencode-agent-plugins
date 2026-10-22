/**
 * Best-effort reload of a running OpenCode service
 * (`docs/explanation/changes-and-reload.md`).
 *
 * Discovery and authentication come from `@opencode/client/service`, the same
 * mechanism the official OpenCode clients use. The module lives in `src/cli/`
 * because it is the only place allowed to import `@opencode/client` at
 * runtime; `src/lib/` stays OpenCode-free.
 */

import { OpenCode } from '@opencode/client';
import { discover, headers } from '@opencode/client/service';
import { boolFlag, type ParsedArgs } from './args.js';
import { printReloadOutcome } from './output.js';

/** Result of a reload attempt. */
export type ReloadOutcome =
  { status: 'reloaded' } | { status: 'no-service' } | { status: 'failed'; message: string };

/** Maximum time the reload request may take. */
const RELOAD_TIMEOUT_MS = 5000;

/**
 * Reloads the local OpenCode service when one is running.
 *
 * A missing service is not an error: it means no reload is needed, and the
 * caller prints the restart hint. A failed request is returned as data; the
 * caller prints a warning and the restart hint without failing the
 * already-applied command. The service rebuilds every loaded location, not
 * only the caller's.
 *
 * @internal Exported for tests only; not part of the public module API.
 * @returns The reload outcome.
 */
export async function reloadOpenCode(): Promise<ReloadOutcome> {
  let endpoint: Awaited<ReturnType<typeof discover>>;
  try {
    endpoint = await discover();
  } catch (error) {
    return { status: 'failed', message: messageOf(error) };
  }
  if (endpoint === undefined) {
    return { status: 'no-service' };
  }

  try {
    const client = OpenCode.make({
      baseUrl: endpoint.url,
      headers: headers(endpoint),
    });
    // The endpoint rebuilds every loaded location, not only this one.
    await client.location.reload({ signal: AbortSignal.timeout(RELOAD_TIMEOUT_MS) });
    return { status: 'reloaded' };
  } catch (error) {
    return { status: 'failed', message: messageOf(error) };
  }
}

/**
 * Reloads a running OpenCode after an applied change, or prints the restart
 * hint when the command opted out.
 *
 * Every command prints exactly one of: the reload outcome, or a hint.
 * `--no-register` and `--no-reload` both select a hint; `--no-register` can
 * use its own hint because the config was not edited.
 *
 * @param args - Parsed command line (for `--no-register` and `--no-reload`).
 * @param restartHint - The command-specific restart message.
 * @param reload - Reload function; injectable so tests need no module mock.
 * @param noRegisterHint - Hint for `--no-register`; defaults to `restartHint`.
 */
export async function reloadAfter(
  args: ParsedArgs,
  restartHint: string,
  reload: () => Promise<ReloadOutcome> = reloadOpenCode,
  noRegisterHint: string = restartHint,
): Promise<void> {
  if (boolFlag(args.flags, '--no-register')) {
    console.log(noRegisterHint);
    return;
  }
  if (boolFlag(args.flags, '--no-reload')) {
    console.log(restartHint);
    return;
  }
  printReloadOutcome(await reload(), restartHint);
}

/**
 * Formats a thrown value as a message for the warning line.
 *
 * @param error - The thrown value.
 * @returns The error message, or the string form of a non-error value.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
