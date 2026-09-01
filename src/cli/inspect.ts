/**
 * `list`, `doctor`, and `prune` commands.
 */

import { pruneDoctor, runDoctor } from '../lib/doctor.js';
import { listInstalled, manifestNameOf } from '../lib/store.js';
import type { DoctorReport } from '../lib/doctor.js';
import { boolFlag, scopeOf, type ParsedArgs } from './args.js';
import { confirm } from './prompts.js';

/**
 * Runs `list` — installed plugins with their local status (no network).
 *
 * @returns The process exit code.
 */
export async function cmdList(): Promise<number> {
  const installed = await listInstalled();
  if (installed.length === 0) {
    console.log('no plugins installed in the client store.');
    return 0;
  }
  for (const entry of installed) {
    const name = await manifestNameOf(entry.root);
    const meta = entry.meta;
    if (meta === null) {
      console.log(`${entry.slug}  [corrupted: missing metadata]`);
      continue;
    }
    const version = meta.manifestVersion === undefined ? '' : ` v${meta.manifestVersion}`;
    const ref = meta.ref === undefined ? 'HEAD' : meta.ref;
    console.log(
      `${name ?? entry.slug}${version}  ${meta.url}  ref:${ref}  commit:${meta.resolvedCommit.slice(0, 12)}`,
    );
  }
  return 0;
}

/**
 * Runs `doctor` — read-only health report.
 *
 * @param args - Parsed command line.
 * @returns The process exit code (2 when issues found).
 */
export async function cmdDoctor(args: ParsedArgs): Promise<number> {
  const report = await runDoctor(scopeOf(args));
  return printReport(report);
}

/**
 * Runs `prune [--yes]` — removes the unreferenced/stale findings of doctor.
 *
 * @param args - Parsed command line.
 * @returns The process exit code.
 */
export async function cmdPrune(args: ParsedArgs): Promise<number> {
  const report = await runDoctor(scopeOf(args));
  const removable = report.items.filter(
    (item) => !item.referenced && item.kind !== 'no-store-entry',
  );
  if (removable.length === 0) {
    console.log('nothing to prune.');
    return 0;
  }
  printReport(report);
  if (!boolFlag(args.flags, '--yes')) {
    const ok = await confirm('Prune the listed unreferenced store entries?', false);
    if (!ok) {
      console.error('aborted.');
      return 1;
    }
  }
  const pruned = await pruneDoctor(report);
  console.log(`pruned: ${pruned.join(', ') || 'nothing'}`);
  return 0;
}

/** Prints a doctor report; returns 2 when it found issues. */
function printReport(report: DoctorReport): number {
  if (report.items.length === 0) {
    console.log('store is healthy.');
    return 0;
  }
  for (const item of report.items) {
    console.log(
      `[${item.kind}] ${item.id} — ${item.detail}${item.referenced ? ' (referenced)' : ''}`,
    );
  }
  return 2;
}
