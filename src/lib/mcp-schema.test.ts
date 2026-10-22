import { describe, expect, it } from 'vitest';
import { validateMcpEntry } from './mcp-schema.js';

describe('validateMcpEntry', () => {
  it('accepts a stdio entry with a command', () => {
    expect(validateMcpEntry({ type: 'stdio', command: './bin/serve.js' })).toEqual({ ok: true });
  });

  it('accepts a streamable-http entry with a URL', () => {
    expect(validateMcpEntry({ type: 'streamable-http', url: 'https://example.com/mcp' })).toEqual({
      ok: true,
    });
  });

  it('rejects a stdio entry without a command', () => {
    const result = validateMcpEntry({ type: 'stdio' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects a non-object entry', () => {
    expect(validateMcpEntry('stdio')).toMatchObject({ ok: false });
  });
});
