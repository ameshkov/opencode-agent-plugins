/**
 * `moveTree` and `copyTree` tests (`docs/explanation/cli-lifecycle.md`).
 *
 * The `EXDEV` branch itself cannot be manufactured portably, so the copy
 * fallback is exercised through `copyTree` directly.
 */

import {
  chmod,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyTree, moveTree, removeTree } from './move.js';
import { tempDir } from '../../test/helpers.js';

describe('moveTree', () => {
  it('renames a directory tree on the common path', async () => {
    const source = await tempDir('oap-move-src-');
    const target = await tempDir('oap-move-dst-');
    try {
      await mkdir(join(source.root, 'nested'), { recursive: true });
      await writeFile(join(source.root, 'nested', 'file.txt'), 'moved', 'utf8');
      const destination = join(target.root, 'installed');

      await moveTree(source.root, destination);

      expect(await readFile(join(destination, 'nested', 'file.txt'), 'utf8')).toBe('moved');
      await expect(stat(source.root)).rejects.toThrow();
    } finally {
      await source.cleanup();
      await target.cleanup();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'removes a staging tree that contains an unreadable directory',
    async () => {
      const source = await tempDir('oap-move-locked-');
      try {
        await mkdir(join(source.root, 'skills'), { recursive: true });
        await writeFile(join(source.root, 'skills', 'SKILL.md'), 'x', 'utf8');
        await chmod(join(source.root, 'skills'), 0o000);

        await removeTree(source.root);

        await expect(stat(source.root)).rejects.toThrow();
      } finally {
        await chmod(join(source.root, 'skills'), 0o700).catch(() => undefined);
        await source.cleanup();
      }
    },
  );

  it('propagates a rename error other than EXDEV', async () => {
    const source = await tempDir('oap-move-src-');
    const target = await tempDir('oap-move-dst-');
    try {
      await mkdir(join(source.root, 'child'), { recursive: true });
      await writeFile(join(source.root, 'child', 'file.txt'), 'x', 'utf8');
      // A non-empty destination makes rename fail with ENOTEMPTY/EEXIST.
      await mkdir(join(target.root, 'installed'), { recursive: true });
      await writeFile(join(target.root, 'installed', 'existing.txt'), 'x', 'utf8');

      await expect(moveTree(source.root, join(target.root, 'installed'))).rejects.toThrow();
      expect((await stat(source.root)).isDirectory()).toBe(true);
    } finally {
      await source.cleanup();
      await target.cleanup();
    }
  });
});

describe('copyTree (EXDEV fallback)', () => {
  it('keeps a relative symlink target relative', async () => {
    const source = await tempDir('oap-copy-src-');
    const target = await tempDir('oap-copy-dst-');
    try {
      await mkdir(join(source.root, 'nested'), { recursive: true });
      await writeFile(join(source.root, 'nested', 'file.txt'), 'moved', 'utf8');
      await symlink('nested/file.txt', join(source.root, 'link.txt'));
      const destination = join(target.root, 'installed');

      await copyTree(source.root, destination);

      expect(await readlink(join(destination, 'link.txt'))).toBe('nested/file.txt');
      expect(await readFile(join(destination, 'nested', 'file.txt'), 'utf8')).toBe('moved');
    } finally {
      await source.cleanup();
      await target.cleanup();
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    'leaves no destination and no temp tree when the copy fails midway',
    async () => {
      const source = await tempDir('oap-copy-src-');
      const target = await tempDir('oap-copy-dst-');
      const blocked = join(source.root, 'blocked.txt');
      try {
        await writeFile(join(source.root, 'a.txt'), 'a', 'utf8');
        await writeFile(blocked, 'b', 'utf8');
        // A mode-000 file makes `cp` fail after it has copied other entries.
        await chmod(blocked, 0o000);

        await expect(copyTree(source.root, join(target.root, 'installed'))).rejects.toThrow();

        await expect(stat(join(target.root, 'installed'))).rejects.toThrow();
        expect(await readdir(target.root)).toEqual([]);
      } finally {
        await chmod(blocked, 0o600).catch(() => undefined);
        await source.cleanup();
        await target.cleanup();
      }
    },
  );
});
