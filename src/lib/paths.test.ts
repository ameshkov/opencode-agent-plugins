import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/helpers.js';
import {
  PLACEHOLDER_DATA,
  PLACEHOLDER_ROOT,
  expandGeneric,
  expandPlaceholders,
  isInside,
  realpathInside,
  resolveCommand,
  resolveCwd,
} from './paths.js';

const ROOT = '/pkg/root';
const DATA = '/data/home/key';

describe('expandPlaceholders', () => {
  it('expands both placeholders in one pass', () => {
    expect(expandPlaceholders(`${PLACEHOLDER_ROOT}/x`, ROOT, DATA)).toBe('/pkg/root/x');
    expect(expandPlaceholders(`${PLACEHOLDER_DATA}/y`, ROOT, DATA)).toBe('/data/home/key/y');
  });

  it('leaves unknown placeholder-shaped text literal', () => {
    expect(expandPlaceholders('${UNKNOWN}/x', ROOT, DATA)).toBe('${UNKNOWN}/x');
  });

  it('does not recurse into inserted paths', () => {
    expect(expandPlaceholders(PLACEHOLDER_ROOT, ROOT, DATA)).toBe(ROOT);
  });
});

describe('expandGeneric', () => {
  it('expands args/env values without containment', () => {
    expect(expandGeneric('${PLUGIN_ROOT}/../outside', ROOT, DATA)).toBe('/pkg/root/../outside');
  });
});

describe('isInside', () => {
  it('accepts the anchor itself and descendants', () => {
    expect(isInside(ROOT, ROOT)).toBe(true);
    expect(isInside(ROOT, `${ROOT}/a/b`)).toBe(true);
  });

  it('rejects siblings and ancestors', () => {
    expect(isInside(ROOT, '/pkg/other')).toBe(false);
    expect(isInside(ROOT, '/pkg')).toBe(false);
    expect(isInside(ROOT, `${ROOT}/../other`)).toBe(false);
  });

  it('treats dot-dot prefixes as names, not parent segments', () => {
    expect(isInside('/a', '/a/..foo')).toBe(true);
    expect(isInside('/a', '/a/..foo/bar')).toBe(true);
  });
});

describe('realpathInside', () => {
  it('accepts a real path inside the root and rejects escapes and misses', async () => {
    const root = await tempDir('oap-paths-');
    const outside = await tempDir('oap-paths-outside-');
    try {
      await mkdir(join(root.root, 'bin'));
      await mkdir(join(root.root, '..foo'));
      await writeFile(join(root.root, 'bin', 'ok'), 'x', 'utf8');
      await writeFile(join(root.root, '..foo', 'ok'), 'x', 'utf8');
      await writeFile(join(outside.root, 'evil'), 'x', 'utf8');
      await symlink(join(outside.root, 'evil'), join(root.root, 'evil'));
      expect(await realpathInside(root.root, join(root.root, 'bin', 'ok'))).toBe(true);
      expect(await realpathInside(root.root, join(root.root, '..foo', 'ok'))).toBe(true);
      expect(await realpathInside(root.root, join(root.root, 'evil'))).toBe(false);
      expect(await realpathInside(root.root, join(root.root, 'missing'))).toBe(false);
    } finally {
      await root.cleanup();
      await outside.cleanup();
    }
  });
});

describe('resolveCommand', () => {
  it('passes bare executable names through', () => {
    expect(resolveCommand('node', ROOT)).toEqual({ ok: true, path: 'node' });
  });

  it('keeps a single token with no whitespace semantics', () => {
    expect(resolveCommand('node --flag', ROOT)).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('resolves ./… against the root and rejects escapes', () => {
    expect(resolveCommand('./bin/serve.js', ROOT)).toEqual({
      ok: true,
      path: `${ROOT}/bin/serve.js`,
    });
    expect(resolveCommand('../bin/serve.js', ROOT)).toMatchObject({
      ok: false,
      kind: 'escape',
      reason: 'command ../bin/serve.js escapes the plugin root',
    });
    expect(resolveCommand('/etc/passwd', ROOT)).toMatchObject({ ok: false, kind: 'invalid' });
  });

  it('rejects a bare-looking token that contains a path separator', () => {
    expect(resolveCommand('bin/../../outside', ROOT)).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
    expect(resolveCommand('bin\\..\\..\\outside', ROOT)).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
  });
});

describe('resolveCwd', () => {
  it('defaults to the plugin root', async () => {
    await expect(resolveCwd(undefined, ROOT, DATA)).resolves.toEqual({ ok: true, path: ROOT });
  });

  it('accepts ./… and ${PLUGIN_ROOT}/… forms', async () => {
    await expect(resolveCwd('./bin', ROOT, DATA)).resolves.toEqual({
      ok: true,
      path: `${ROOT}/bin`,
    });
    await expect(resolveCwd('${PLUGIN_ROOT}/bin', ROOT, DATA)).resolves.toEqual({
      ok: true,
      path: `${ROOT}/bin`,
    });
  });

  it('accepts ${PLUGIN_DATA}/… and anchors there', async () => {
    await expect(resolveCwd('${PLUGIN_DATA}/logs', ROOT, DATA)).resolves.toEqual({
      ok: true,
      path: `${DATA}/logs`,
    });
  });

  it('accepts Windows separators after a placeholder or ./ prefix', async () => {
    await expect(resolveCwd('${PLUGIN_ROOT}\\bin', ROOT, DATA)).resolves.toEqual({
      ok: true,
      path: `${ROOT}/bin`,
    });
    await expect(resolveCwd('${PLUGIN_DATA}\\logs', ROOT, DATA)).resolves.toEqual({
      ok: true,
      path: `${DATA}/logs`,
    });
    await expect(resolveCwd('.\\bin', ROOT, DATA)).resolves.toEqual({
      ok: true,
      path: `${ROOT}/bin`,
    });
  });

  it('rejects escapes both pre- and post-expansion', async () => {
    // Pre-expansion `../` is not an allowed form; post-expansion escapes that
    // slip through a placeholder are true containment violations.
    await expect(resolveCwd('../outside', ROOT, DATA)).resolves.toMatchObject({
      ok: false,
      kind: 'invalid',
    });
    await expect(resolveCwd('${PLUGIN_ROOT}/../outside', ROOT, DATA)).resolves.toMatchObject({
      ok: false,
      kind: 'escape',
    });
    await expect(resolveCwd('${PLUGIN_DATA}/../outside', ROOT, DATA)).resolves.toMatchObject({
      ok: false,
      kind: 'escape',
    });
  });

  it('rejects an existing cwd that resolves outside its anchor', async () => {
    const root = await tempDir('oap-cwd-');
    const outside = await tempDir('oap-cwd-outside-');
    try {
      await symlink(outside.root, join(root.root, 'link'));
      await expect(resolveCwd('./link', root.root, DATA)).resolves.toMatchObject({
        ok: false,
        kind: 'escape',
      });
    } finally {
      await root.cleanup();
      await outside.cleanup();
    }
  });

  it('rejects absolute and unknown forms', async () => {
    await expect(resolveCwd('/etc', ROOT, DATA)).resolves.toMatchObject({
      ok: false,
      kind: 'invalid',
    });
    await expect(resolveCwd('${UNKNOWN}/x', ROOT, DATA)).resolves.toMatchObject({
      ok: false,
      kind: 'invalid',
    });
  });
});
