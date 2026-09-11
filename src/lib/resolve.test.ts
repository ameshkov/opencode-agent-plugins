import { cp, mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSource, resolveSource, slugOf } from './resolve.js';
import { storeDir } from './data.js';
import { installedRootFor, writeMeta } from './store.js';
import { tempDir, storeEnv, tmpPlugin, VALID_PLUGIN_JSON } from '../../test/helpers.js';

describe('parseSource', () => {
  it('parses git URLs with schemes and git+ prefixes', () => {
    for (const raw of [
      'https://github.com/org/repo.git',
      'git+https://github.com/org/repo.git',
      'ssh://git@github.com/org/repo.git',
      'git+ssh://git@github.com/org/repo.git',
      'git@github.com:org/repo.git',
    ]) {
      expect(parseSource(raw).kind).toBe('git');
    }
  });

  it('splits a #ref off a git URL', () => {
    const parsed = parseSource('git+https://github.com/org/repo.git#v1.2.0');
    if (parsed.kind === 'git') {
      expect(parsed.source.ref).toBe('v1.2.0');
      expect(parsed.source.url).toBe('https://github.com/org/repo.git');
      expect(parsed.source.slug).toBe('org-repo');
    } else {
      expect.unreachable('expected git');
    }
  });

  it('parses subdir fragments with and without a ref (§5.3.4)', () => {
    const pinned = parseSource('https://github.com/org/repo.git#v1.2.0:packages/linter');
    if (pinned.kind === 'git') {
      expect(pinned.source.ref).toBe('v1.2.0');
      expect(pinned.source.subdir).toBe('packages/linter');
      expect(pinned.source.slug).toMatch(/^org-repo-packages-linter-[0-9a-f]{8}$/);
    } else {
      expect.unreachable('expected git');
    }
    const unpinned = parseSource('git@github.com:org/repo.git#:apps/research');
    if (unpinned.kind === 'git') {
      expect(unpinned.source.ref).toBeUndefined();
      expect(unpinned.source.subdir).toBe('apps/research');
      expect(unpinned.source.url).toBe('git@github.com:org/repo.git');
      expect(unpinned.source.slug).toMatch(/^org-repo-apps-research-[0-9a-f]{8}$/);
    } else {
      expect.unreachable('expected git');
    }
  });

  it('rejects malformed refs before any network call', () => {
    expect(() => parseSource('https://github.com/org/repo.git#')).toThrow('invalid git ref');
    expect(() => parseSource('https://github.com/org/repo.git#bad ref')).toThrow('invalid git ref');
    expect(() => parseSource('https://github.com/org/repo.git#a..b')).toThrow('invalid git ref');
  });

  it('rejects malformed subdirs before any network call (§5.3.4)', () => {
    for (const fragment of [
      '#:',
      '#a:',
      '#:a//b',
      '#:a/../b',
      '#:a/./b',
      '#:/abs',
      '#:a/b/',
      '#:a\\b',
      '#:a:b',
    ]) {
      expect(() => parseSource(`https://github.com/org/repo.git${fragment}`)).toThrow(
        'invalid git subdir',
      );
    }
  });

  it('treats everything else as a local path', () => {
    expect(parseSource('./agent-plugins/my-plugin').kind).toBe('path');
    expect(parseSource('/abs/dir').kind).toBe('path');
    expect(parseSource('C:\\dev\\plugin').kind).toBe('path');
  });
});

describe('slugOf', () => {
  it('derives org-repo from URLs', () => {
    expect(slugOf('https://github.com/org/repo.git')).toBe('org-repo');
    expect(slugOf('ssh://git@github.com/org/repo')).toBe('org-repo');
    expect(slugOf('git@github.com:org/repo.git')).toBe('org-repo');
  });

  it('flattens a subdir into the slug and appends a disambiguating hash (§5.3.4)', () => {
    const slug = slugOf('https://github.com/org/repo.git', 'packages/My_App');
    expect(slug.startsWith('org-repo-packages-my-app-')).toBe(true);
    expect(slug.slice(-8)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps lossy subdir flattenings distinct (§5.3.4)', () => {
    const url = 'https://github.com/org/repo.git';
    const slugs = new Set([
      slugOf(url, 'packages/a/b'),
      slugOf(url, 'packages/a-b'),
      slugOf(url, 'packages/a_b'),
    ]);
    expect(slugs.size).toBe(3);
  });

  it('treats case-only subdir variants as the same slug (§10)', () => {
    const url = 'https://github.com/org/repo.git';
    expect(slugOf(url, 'Packages/ALPHA')).toBe(slugOf(url, 'packages/alpha'));
  });

  it('treats an empty subdir like an absent one', () => {
    const url = 'https://github.com/org/repo.git';
    expect(slugOf(url, '')).toBe(slugOf(url));
  });

  it('truncates long slugs and keeps distinct subdirs distinct (§5.3.4)', () => {
    const url = 'https://github.com/very-long-org-name/very-long-repo-name.git';
    const first = slugOf(url, 'packages/some-extremely-long-plugin-directory-name');
    const second = slugOf(url, 'packages/another-extremely-long-plugin-dir-name');
    expect(first).toHaveLength(64);
    expect(first.startsWith('very-long-org-name-very-long-repo-name-packages-some')).toBe(true);
    expect(first.slice(-9, -8)).toBe('-');
    expect(first.slice(-8)).toMatch(/^[0-9a-f]{8}$/);
    expect(second).toHaveLength(64);
    expect(second.slice(-8)).toMatch(/^[0-9a-f]{8}$/);
    expect(second).not.toBe(first);
  });
});

describe('resolveSource', () => {
  it('resolves an absolute local directory in place (realpathed)', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    try {
      const result = await resolveSource(plugin.root, '/');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source.kind).toBe('path');
        expect(result.source.root).toBe(await realpath(plugin.root));
      }
    } finally {
      await plugin.cleanup();
    }
  });

  it('resolves relative paths against the workspace dir', async () => {
    const workspace = await tempDir('oap-ws-');
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    try {
      const target = join(workspace.root, 'agent-plugins', 'my-plugin');
      await mkdir(join(workspace.root, 'agent-plugins'), { recursive: true });
      await cp(plugin.root, target, { recursive: true });
      const result = await resolveSource('./agent-plugins/my-plugin', workspace.root);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.source.root).toBe(await realpath(target));
      }
    } finally {
      await workspace.cleanup();
      await plugin.cleanup();
    }
  });

  it('reports an uninstalled git source as source-missing', async () => {
    const home = await tempDir('oap-env-');
    try {
      const env = storeEnv(home.root);
      const result = await resolveSource(
        'git+https://github.com/org/not-installed.git#v1',
        '/',
        env,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('source-missing');
      }
      expect(storeDir('installed', env)).toContain(home.root);
    } finally {
      await home.cleanup();
    }
  });

  it('reports a malformed ref as a failure instead of throwing', async () => {
    const result = await resolveSource('git+https://github.com/org/repo.git#bad ref', '/');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('source-missing');
      expect(result.failure.message).toContain('invalid git ref');
    }
  });

  it('rejects ~user/... forms', async () => {
    const result = await resolveSource('~nobody/plugin', '/');
    expect(result.ok).toBe(false);
  });

  it('resolves an installed subdir entry and carries its subdir (§5.3.4)', async () => {
    const home = await tempDir('oap-env-');
    try {
      const env = storeEnv(home.root);
      const url = 'https://github.com/org/mono.git';
      const subdir = 'packages/alpha';
      const slug = slugOf(url, subdir);
      const root = installedRootFor(slug, env);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, 'plugin.json'), VALID_PLUGIN_JSON, 'utf8');
      await writeMeta(
        slug,
        {
          source: `${url}#:${subdir}`,
          url,
          subdir,
          resolvedCommit: 'a'.repeat(40),
          manifestVersion: '1.0.0',
          installedAt: '2026-09-01T00:00:00.000Z',
        },
        env,
      );

      const byUrl = await resolveSource(`${url}#:${subdir}`, '/', env);
      expect(byUrl.ok).toBe(true);
      if (byUrl.ok && byUrl.source.kind === 'git') {
        expect(byUrl.source.source.subdir).toBe(subdir);
        expect(byUrl.source.source.slug).toBe(slug);
      }

      const bySlug = await resolveSource(slug, '/', env);
      expect(bySlug.ok).toBe(true);
      if (bySlug.ok && bySlug.source.kind === 'git') {
        expect(bySlug.source.source.subdir).toBe(subdir);
        expect(bySlug.source.meta.subdir).toBe(subdir);
      }
    } finally {
      await home.cleanup();
    }
  });
});
