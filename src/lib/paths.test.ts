import { describe, expect, it } from 'vitest';
import {
  PLACEHOLDER_DATA,
  PLACEHOLDER_ROOT,
  expandGeneric,
  expandPlaceholders,
  isInside,
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
});

describe('resolveCommand', () => {
  it('passes bare executable names through', () => {
    expect(resolveCommand('node', ROOT)).toEqual({ ok: true, path: 'node' });
  });

  it('keeps a single token with no whitespace semantics', () => {
    expect(resolveCommand('node --flag', ROOT).ok).toBe(false);
  });

  it('resolves ./… against the root and rejects escapes', () => {
    expect(resolveCommand('./bin/serve.js', ROOT)).toEqual({
      ok: true,
      path: `${ROOT}/bin/serve.js`,
    });
    expect(resolveCommand('../bin/serve.js', ROOT).ok).toBe(false);
    expect(resolveCommand('/etc/passwd', ROOT).ok).toBe(false);
  });
});

describe('resolveCwd', () => {
  it('defaults to the plugin root', () => {
    expect(resolveCwd(undefined, ROOT, DATA)).toEqual({ ok: true, path: ROOT });
  });

  it('accepts ./… and ${PLUGIN_ROOT}/… forms', () => {
    expect(resolveCwd('./bin', ROOT, DATA)).toEqual({ ok: true, path: `${ROOT}/bin` });
    expect(resolveCwd('${PLUGIN_ROOT}/bin', ROOT, DATA)).toEqual({
      ok: true,
      path: `${ROOT}/bin`,
    });
  });

  it('accepts ${PLUGIN_DATA}/… and anchors there', () => {
    expect(resolveCwd('${PLUGIN_DATA}/logs', ROOT, DATA)).toEqual({
      ok: true,
      path: `${DATA}/logs`,
    });
  });

  it('rejects escapes both pre- and post-expansion', () => {
    expect(resolveCwd('../outside', ROOT, DATA).ok).toBe(false);
    expect(resolveCwd('${PLUGIN_ROOT}/../outside', ROOT, DATA).ok).toBe(false);
    expect(resolveCwd('${PLUGIN_DATA}/../outside', ROOT, DATA).ok).toBe(false);
  });

  it('rejects absolute and unknown forms', () => {
    expect(resolveCwd('/etc', ROOT, DATA).ok).toBe(false);
    expect(resolveCwd('${UNKNOWN}/x', ROOT, DATA).ok).toBe(false);
  });
});
