import { describe, expect, it } from 'vitest';
import { parseOptions } from './options.js';

describe('parseOptions', () => {
  it('normalizes a single source string into an array', () => {
    const { options, warnings } = parseOptions({ plugins: './agent-plugins/my-plugin' });
    expect(options.plugins).toEqual(['./agent-plugins/my-plugin']);
    expect(options.prefix).toBe(false);
    expect(options.logLevel).toBe('info');
    expect(warnings).toEqual([]);
  });

  it('keeps an array of sources as is', () => {
    const { options } = parseOptions({
      plugins: ['./local', 'git+https://github.com/org/repo.git#v1.0.0'],
    });
    expect(options.plugins).toHaveLength(2);
  });

  it('applies prefix and logLevel defaults and overrides', () => {
    const { options } = parseOptions({
      plugins: ['./local'],
      prefix: true,
      logLevel: 'debug',
    });
    expect(options.prefix).toBe(true);
    expect(options.logLevel).toBe('debug');
  });

  it('reports unknown options as warnings', () => {
    const { options, warnings } = parseOptions({ plugins: ['./local'], unknown: 1 });
    expect(options.plugins).toEqual(['./local']);
    expect(warnings).toEqual(['unknown option "unknown" ignored']);
  });

  it('throws when plugins is missing', () => {
    expect(() => parseOptions({ prefix: true })).toThrow('invalid plugin options');
  });

  it('throws when a known option has an invalid value', () => {
    expect(() => parseOptions({ plugins: ['./local'], logLevel: 'verbose' })).toThrow(
      'invalid plugin options',
    );
  });

  it('treats a non-object options tuple as an empty object', () => {
    const raw = undefined;
    expect(() => parseOptions(raw)).toThrow('invalid plugin options');
  });
});
