import { execFile } from 'node:child_process';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/helpers.js';
import { cloneInto, stageTree } from './clone.js';

/** Runs a git command, failing the test on error. */
function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
        return;
      }
      resolveResult(stdout);
    });
  });
}

/** A local bare remote with a tag and a branch at an older commit. */
async function fixture(): Promise<{
  source: string;
  mainTip: string;
  v1Tip: string;
  sha: (spec: string) => Promise<string>;
  cleanup: () => Promise<void>;
}> {
  const work = await tempDir('oap-clone-work-');
  const bare = await tempDir('oap-clone-bare-');
  const barePath = join(bare.root, 'remote.git');
  await git(['init', '--bare', barePath]);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], barePath);
  await git(['init', '-b', 'main', work.root]);
  await git(['config', 'user.email', 'a@b.c'], work.root);
  await git(['config', 'user.name', 'Test'], work.root);
  await writeFile(join(work.root, 'a.txt'), 'one', 'utf8');
  await git(['add', '-A'], work.root);
  await git(['commit', '-m', 'v1'], work.root);
  const v1Tip = (await git(['rev-parse', 'HEAD'], work.root)).trim();
  await git(['remote', 'add', 'origin', barePath], work.root);
  await git(['push', '-u', 'origin', 'main'], work.root);
  await git(['checkout', '-b', 'feature'], work.root);
  await git(['push', '-u', 'origin', 'feature'], work.root);
  await git(['checkout', 'main'], work.root);
  await writeFile(join(work.root, 'b.txt'), 'two', 'utf8');
  await git(['add', '-A'], work.root);
  await git(['commit', '-m', 'v2'], work.root);
  const mainTip = (await git(['rev-parse', 'HEAD'], work.root)).trim();
  await git(['push', 'origin', 'main'], work.root);
  await git(['tag', '-a', 'v1.0.0', '-m', 'v1.0.0', v1Tip], work.root);
  await git(['push', 'origin', 'v1.0.0'], work.root);
  return {
    source: `file://${barePath}`,
    mainTip,
    v1Tip,
    sha: (spec) => git(['rev-parse', spec], work.root).then((out) => out.trim()),
    cleanup: async () => {
      await work.cleanup();
      await bare.cleanup();
    },
  };
}

/** Removes a staged tree left by `stageTree`. */
async function cleanupStaged(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

describe('clone strategy (§5.12.1)', () => {
  it('stages a HEAD install at the remote tip, exported without .git', async () => {
    const fx = await fixture();
    try {
      const staged = await stageTree(fx.source, undefined, fx.mainTip);
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(await readFile(join(staged.dir, 'a.txt'), 'utf8')).toBe('one');
      expect(await readFile(join(staged.dir, 'b.txt'), 'utf8')).toBe('two');
      expect(await stat(join(staged.dir, '.git')).catch(() => null)).toBeNull();
      await cleanupStaged(staged.dir);
    } finally {
      await fx.cleanup();
    }
  });

  it('stages a branch install at the resolved commit (not the ref tip)', async () => {
    const fx = await fixture();
    try {
      const featureTip = await fx.sha('feature');
      const staged = await stageTree(fx.source, 'feature', featureTip);
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(await readFile(join(staged.dir, 'a.txt'), 'utf8')).toBe('one');
      expect(await stat(join(staged.dir, 'b.txt')).catch(() => null)).toBeNull();
      await cleanupStaged(staged.dir);
    } finally {
      await fx.cleanup();
    }
  });

  it('stages an annotated-tag install at the dereferenced commit', async () => {
    const fx = await fixture();
    try {
      const tagged = await fx.sha('v1.0.0^{}');
      const staged = await stageTree(fx.source, 'v1.0.0', tagged);
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(await readFile(join(staged.dir, 'a.txt'), 'utf8')).toBe('one');
      expect(await stat(join(staged.dir, 'b.txt')).catch(() => null)).toBeNull();
      await cleanupStaged(staged.dir);
    } finally {
      await fx.cleanup();
    }
  });

  it('stages a raw SHA pin at the pinned commit', async () => {
    const fx = await fixture();
    try {
      const staged = await stageTree(fx.source, fx.v1Tip, fx.v1Tip);
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(await readFile(join(staged.dir, 'a.txt'), 'utf8')).toBe('one');
      expect(await stat(join(staged.dir, 'b.txt')).catch(() => null)).toBeNull();
      await cleanupStaged(staged.dir);
    } finally {
      await fx.cleanup();
    }
  });

  it('accepts the git+ URL prefix', async () => {
    const fx = await fixture();
    try {
      const staged = await stageTree(`git+${fx.source}`, undefined, fx.mainTip);
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(await readFile(join(staged.dir, 'b.txt'), 'utf8')).toBe('two');
      await cleanupStaged(staged.dir);
    } finally {
      await fx.cleanup();
    }
  });

  it('clones shallow at the resolved commit (init + fetch --depth 1)', async () => {
    const fx = await fixture();
    const dir = await tempDir('oap-clone-dir-');
    try {
      const result = await cloneInto(fx.source, undefined, fx.mainTip, dir.root);
      expect(result.ok).toBe(true);
      expect(await readFile(join(dir.root, '.git', 'shallow'), 'utf8')).toContain(fx.mainTip);
      expect(await readFile(join(dir.root, 'b.txt'), 'utf8')).toBe('two');
    } finally {
      await dir.cleanup();
      await fx.cleanup();
    }
  });

  it('stages a HEAD install from a remote with an unset default branch', async () => {
    const work = await tempDir('oap-clone-work-');
    const bare = await tempDir('oap-clone-bare-');
    const barePath = join(bare.root, 'remote.git');
    await git(['init', '--bare', barePath]);
    await git(['symbolic-ref', 'HEAD', 'refs/heads/nonexistent'], barePath);
    await git(['init', '-b', 'main', work.root]);
    await git(['config', 'user.email', 'a@b.c'], work.root);
    await git(['config', 'user.name', 'Test'], work.root);
    await writeFile(join(work.root, 'a.txt'), 'one', 'utf8');
    await git(['add', '-A'], work.root);
    await git(['commit', '-m', 'v1'], work.root);
    await git(['remote', 'add', 'origin', barePath], work.root);
    await git(['push', 'origin', 'main'], work.root);
    const tip = (await git(['rev-parse', 'HEAD'], work.root)).trim();
    try {
      const staged = await stageTree(`file://${barePath}`, undefined, tip);
      expect(staged.ok).toBe(true);
      if (!staged.ok) return;
      expect(await readFile(join(staged.dir, 'a.txt'), 'utf8')).toBe('one');
      await cleanupStaged(staged.dir);
    } finally {
      await work.cleanup();
      await bare.cleanup();
    }
  });

  it('fails cleanly on an unresolvable commit', async () => {
    const fx = await fixture();
    const dir = await tempDir('oap-clone-dir-');
    try {
      const result = await cloneInto(fx.source, undefined, 'f'.repeat(40), dir.root);
      expect(result.ok).toBe(false);
    } finally {
      await dir.cleanup();
      await fx.cleanup();
    }
  });
});
