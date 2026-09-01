import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('returns null without a frontmatter block', () => {
    expect(parseFrontmatter('# just a heading\n')).toBeNull();
  });

  it('returns null when the closing delimiter is missing', () => {
    expect(parseFrontmatter('---\nname: x\n')).toBeNull();
  });

  it('parses simple key-value pairs', () => {
    const fm = parseFrontmatter('---\nname: hello\ndescription: Greets the world.\n---\n');
    expect(fm).toEqual({ name: 'hello', description: 'Greets the world.' });
  });

  it('unquotes double- and single-quoted values', () => {
    const fm = parseFrontmatter('---\nname: "quoted"\nother: \'single\'\n---\n');
    expect(fm).toEqual({ name: 'quoted', other: 'single' });
  });

  it('parses folded and literal multi-line blocks', () => {
    const source = '---\ndescription: >\n  Line one\n  line two\nname: hello\n---\n';
    expect(parseFrontmatter(source)).toEqual({
      description: 'Line one line two',
      name: 'hello',
    });
  });

  it('ignores comment lines and blank lines', () => {
    const source = '---\n# a comment\n\nname: hello\ndescription: x\n---\n';
    expect(parseFrontmatter(source)).toEqual({ name: 'hello', description: 'x' });
  });

  it('converts booleans and null scalars', () => {
    const source = '---\nenabled: true\noptional: null\nscore: 1\n---\n';
    expect(parseFrontmatter(source)).toEqual({
      enabled: true,
      optional: null,
      score: '1',
    });
  });

  it('keeps unknown keys as raw strings', () => {
    const source = '---\nname: a\ndescription: b\nallowed-tools: [x, y]\n---\n';
    const fm = parseFrontmatter(source);
    expect(fm?.['allowed-tools']).toBe('[x, y]');
  });
});
