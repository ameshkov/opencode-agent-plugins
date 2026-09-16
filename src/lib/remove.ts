/**
 * Plugin remove lifecycle (`docs/explanation/design.md` §5.12.2).
 *
 * Remove resolves a name to exactly one store entry (ambiguous manifest names
 * are refused, never guessed), unregisters the entry's original source from
 * the OpenCode config (JSONC-preserving, atomic, backed up outside the user's
 * repo), then deletes the store entry, its metadata, and its `PLUGIN_DATA`
 * (kept with `--keep-data`).
 */

import { readFile, rm } from 'node:fs/promises';
import {
  applyRemoveSource,
  configError,
  configPreferenceNote,
  resolveConfigFile,
  saveConfig,
} from './config-file.js';
import { dataDirForKey } from './data.js';
import {
  findStoreEntry,
  installedRootFor,
  metaPathFor,
  removeMeta,
  type StoreEntry,
} from './store.js';
import { failure, type Failure } from './errors.js';
import type { LifecycleOptions, OpResult } from './install.js';

/**
 * Removes a plugin: resolves the name to a store entry (ambiguous names are
 * refused), unregisters its source from the config, then deletes the store
 * entry, metadata, and `PLUGIN_DATA`.
 *
 * @param name - Store slug or manifest name.
 * @param options - Lifecycle options.
 * @param options.keepData - Keep `PLUGIN_DATA` on disk.
 * @returns The outcome.
 */
export async function removePlugin(
  name: string,
  options: LifecycleOptions & { keepData?: boolean },
): Promise<OpResult> {
  const entries = await findStoreEntry(name, options.env);
  if (entries.length === 0) {
    return {
      ok: false,
      failure: failure(
        'install-fail',
        `"${name}" is not installed in the client store (path-sourced plugins are removed by editing the config)`,
      ),
    };
  }
  if (entries.length > 1) {
    const slugs = entries.map((e) => e.slug).join(', ');
    return {
      ok: false,
      failure: failure(
        'install-fail',
        `"${name}" matches multiple store entries (${slugs}); use the slug`,
      ),
    };
  }
  return removeStoreEntry(entries[0]!, options);
}

/** Unregisters and deletes one store entry (config edit + removal). */
async function removeStoreEntry(
  entry: StoreEntry,
  options: LifecycleOptions & { keepData?: boolean },
): Promise<OpResult> {
  const meta = entry.meta;
  if (meta === null) {
    return {
      ok: false,
      failure: failure('source-corrupt', `store entry "${entry.slug}" is corrupted`),
    };
  }
  let backupPath: string | undefined;
  let configNote: string | undefined;
  try {
    const resolved = await resolveConfigFile(options.configScope);
    const previous = await readFile(resolved.path, 'utf8').catch(() => null);
    // A missing or whitespace-only config holds no registration: normalize it
    // to `{}` so a later failure names the real cause ("not registered")
    // instead of reporting an unparsable JSONC document.
    const current = previous === null || previous.trim() === '' ? '{}' : previous;
    const edited = applyRemoveSource(current, meta.source);
    const saved = await saveConfig(resolved.path, edited, options.env, previous);
    backupPath = saved.backupPath ?? undefined;
    configNote = configPreferenceNote(resolved) ?? undefined;
  } catch (error) {
    return { ok: false, failure: failure('config-edit', configError(error)) };
  }
  const leftover = await removeStoreEntryFiles(entry.slug, meta.source, options);
  if (leftover !== null) {
    return { ok: false, failure: leftover };
  }
  return {
    ok: true,
    message: `removed ${meta.source}. Restart OpenCode to drop its tools and skills.`,
    backupPath,
    ...(configNote === undefined ? {} : { configNote }),
  };
}

/**
 * Deletes the store tree, metadata, and `PLUGIN_DATA` of a removed entry.
 *
 * The config entry is already gone at this point, so a deletion failure must
 * not reject: each step is attempted independently and every path that could
 * not be deleted is reported, leaving the user with an actionable message
 * instead of a half-removed entry and a raw filesystem error.
 *
 * @param slug - Store slug of the removed entry.
 * @param source - Original source string (for the failure message).
 * @param options - Lifecycle options (`keepData`).
 * @returns A failure describing the leftovers, or null when all deletions
 * succeeded.
 */
async function removeStoreEntryFiles(
  slug: string,
  source: string,
  options: LifecycleOptions & { keepData?: boolean },
): Promise<Failure | null> {
  const steps: Array<{ what: string; path: string; remove: () => Promise<void> }> = [
    {
      what: 'installed tree',
      path: installedRootFor(slug, options.env),
      remove: () => rm(installedRootFor(slug, options.env), { recursive: true, force: true }),
    },
    {
      what: 'metadata file',
      path: metaPathFor(slug, options.env),
      remove: () => removeMeta(slug, options.env),
    },
  ];
  if (!options.keepData) {
    steps.push({
      what: 'PLUGIN_DATA directory',
      path: dataDirForKey(slug, options.env),
      remove: () => rm(dataDirForKey(slug, options.env), { recursive: true, force: true }),
    });
  }
  const leftover: string[] = [];
  for (const step of steps) {
    try {
      await step.remove();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      leftover.push(`${step.what} at ${step.path}: ${message}`);
    }
  }
  if (leftover.length === 0) {
    return null;
  }
  return failure(
    'install-fail',
    `"${source}" was unregistered from the config, but deleting its store entry failed: ${leftover.join('; ')}`,
  );
}
