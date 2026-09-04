import { describe, expect, it } from 'vitest';
import { failure, levelOf, type FailureKind } from './errors.js';

describe('failure taxonomy', () => {
  it('maps every kind to its documented report level', () => {
    expect(failure('plugin-missing', 'x').level).toBe('error');
    expect(failure('manifest-unknown-fields', 'x').level).toBe('warn');
    expect(failure('skills-missing', 'x').level).toBe('debug');
    expect(failure('skills-invalid', 'x').level).toBe('warn');
    expect(failure('skills-collision', 'x').level).toBe('warn');
    expect(failure('mcp-invalid', 'x').level).toBe('error');
    expect(failure('server-invalid', 'x').level).toBe('warn');
    expect(failure('server-transport', 'x').level).toBe('warn');
    expect(failure('source-missing', 'x').level).toBe('warn');
    expect(failure('extension-namespace', 'x').level).toBe('debug');
    expect(failure('update-ref', 'x').level).toBe('warn');
    expect(failure('config-edit', 'x').level).toBe('error');
  });

  it('preserves extra metadata', () => {
    const f = failure('server-invalid', 'bad', { server: 'echo' });
    expect(f.extra).toEqual({ server: 'echo' });
  });

  it('levelOf agrees with failure-built records', () => {
    const kinds: FailureKind[] = [
      'plugin-missing',
      'manifest-schema',
      'manifest-fatal',
      'manifest-unknown-fields',
      'extensions-non-object',
      'extension-namespace',
      'path-escape',
      'skills-missing',
      'skills-invalid',
      'skills-collision',
      'skills-nested',
      'mcp-missing',
      'mcp-invalid',
      'server-invalid',
      'server-transport',
      'server-collision',
      'source-missing',
      'source-corrupt',
      'install-fail',
      'check-unreachable',
      'update-ref',
      'config-edit',
    ];
    for (const kind of kinds) {
      expect(levelOf(kind)).toBe(failure(kind, 'x').level);
    }
  });
});
