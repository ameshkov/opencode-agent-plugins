/**
 * Directory moves and staging cleanup (`docs/explanation/cli-lifecycle.md`).
 *
 * Staging lives in `os.tmpdir()` and the store lives under the OpenCode config
 * directory. The two can be on different filesystems, where `rename` fails
 * with `EXDEV`. The common path stays an atomic rename. The cross-device
 * fallback copies the tree through a temporary sibling and renames it into
 * place; `copyTree` is tested directly because a cross-device rename cannot
 * be manufactured portably.
 */

import { chmod, cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Moves a directory tree to a new path.
 *
 * @param from - Absolute source path.
 * @param to - Absolute destination path (must not exist).
 * @throws The original error when the rename fails for a reason other than
 * `EXDEV`, or the copy/rename error of the fallback.
 */
export async function moveTree(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
      throw error;
    }
  }
  await copyTree(from, to);
  // The tree is in place; a source cleanup failure leaves only a temporary
  // staging directory behind and must not fail the move.
  await rm(from, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Copies a directory tree through a temporary sibling and renames it into
 * place.
 *
 * Used by the cross-device (`EXDEV`) move fallback: copying straight to the
 * destination would expose a partial tree when the copy fails. The copy lands
 * in a temporary directory beside the destination and only a completed copy is
 * renamed, so a failure leaves neither a partial destination nor a temporary
 * tree. Symlinks are copied verbatim, so a relative target stays relative to
 * the copied tree instead of being rewritten to the source path.
 *
 * @param from - Absolute source path.
 * @param to - Absolute destination path (must not exist).
 * @throws The copy or rename error, after the temporary tree is removed.
 * @internal Exported for tests only; `moveTree` calls it internally.
 */
export async function copyTree(from: string, to: string): Promise<void> {
  const parent = dirname(to);
  await mkdir(parent, { recursive: true });
  const temp = await mkdtemp(join(parent, `.${basename(to)}-copy-`));
  try {
    const tree = join(temp, 'tree');
    await cp(from, tree, { recursive: true, verbatimSymlinks: true });
    await rename(tree, to);
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  // The renamed tree is in place; an empty temp directory is only a leftover.
  await rm(temp, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Removes a throwaway staging tree, including unreadable directories.
 *
 * A validation failure can leave a mode-000 directory inside a clone, which
 * `rm` cannot enter. Make each real directory writable first; symlinks are
 * never followed, so a staged link cannot expose an outside tree.
 *
 * @param path - Absolute staging path.
 */
export async function removeTree(path: string): Promise<void> {
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
}

/** Makes a real directory tree writable so `rm` can enter it. */
async function makeWritable(dir: string): Promise<void> {
  await chmod(dir, 0o700).catch(() => undefined);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await makeWritable(join(dir, entry.name));
    }
  }
}
