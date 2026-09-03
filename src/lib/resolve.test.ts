import { cp, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSource, resolveSource, slugOf } from './resolve.js';
import { storeDir } from './data.js';
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

  it('rejects malformed refs before any network call', () => {
    expect(() => parseSource('https://github.com/org/repo.git#')).toThrow('invalid git ref');
    expect(() => parseSource('https://github.com/org/repo.git#bad ref')).toThrow('invalid git ref');
    expect(() => parseSource('https://github.com/org/repo.git#a..b')).toThrow('invalid git ref');
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
});
