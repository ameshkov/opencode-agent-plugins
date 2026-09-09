// Unit tests for the taxonomy gate's comment stripper
// (`scripts/check-failure-kinds.ts`).
//
// Regression: `//` inside a string literal (e.g. a `https://...` URL) must
// never be treated as a comment, or a `failure('<kind>', ...)` call sharing
// the line would vanish and the gate would mis-report taxonomy drift. Running
// the import must not execute the gate itself (guarded in the module).
import { describe, expect, it } from 'vitest';
import { stripComments } from './check-failure-kinds.js';

// Same pattern the gate uses to find `failure('<kind>', ...)` occurrences:
// single-quoted kind literals only.
const FAILURE_CALL_RE = /failure\(\s*'([a-z][a-z-]*)'/g;

/** Kinds found by the gate's call regex in `src`. */
function failureKinds(src: string): string[] {
  return [...stripComments(src).matchAll(FAILURE_CALL_RE)].map((match) => match[1]);
}

describe('stripComments (check-failure-kinds gate)', () => {
  it('removes line comments but keeps the newline', () => {
    const stripped = stripComments("const a = 1; // failure('mcp-missing') note\nconst b = 2;");
    expect(stripped).toBe('const a = 1; \nconst b = 2;');
  });

  it('removes block comments preserving newlines', () => {
    const stripped = stripComments("const a = 1;\n/* failure('x')\nspans lines */\nconst b = 2;");
    expect(stripped).toBe('const a = 1;\n\n\nconst b = 2;');
  });

  it('preserves // inside single-quoted strings (URL regression)', () => {
    const src = "failure('server-invalid', 'https://example.com/x', { server: 's' });";
    expect(stripComments(src)).toBe(src);
    expect(failureKinds(src)).toEqual(['server-invalid']);
  });

  it('preserves // inside double-quoted strings', () => {
    const src = "const u = \"https://example.com/x\"; failure('server-invalid', 'x');";
    expect(failureKinds(src)).toEqual(['server-invalid']);
  });

  it('preserves // inside template literals and re-enters code on ${…}', () => {
    const src = "const u = `https://example.com/${x}`; failure('mcp-missing', 'no mcp.json');";
    expect(stripComments(src)).toContain('https://example.com/${x}');
    expect(failureKinds(src)).toEqual(['mcp-missing']);
  });

  it('sees a failure() call on the same line as a URL string (the regression)', () => {
    const src = "failure('check-unreachable', 'remote unreachable: https://example.com/repo.git');";
    expect(failureKinds(src)).toEqual(['check-unreachable']);
  });

  it('still strips comments that merely mention failure()', () => {
    const src = "// failure('path-escape') prose\nfailure('path-escape', 'x');";
    expect(failureKinds(src)).toEqual(['path-escape']);
  });
});
