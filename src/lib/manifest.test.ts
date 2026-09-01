import { describe, expect, it } from 'vitest';
import { loadManifest, validateManifest, schemaVersion } from './manifest.js';
import { tempDir, VALID_PLUGIN_JSON } from '../../test/helpers.js';

const VALID = JSON.parse(VALID_PLUGIN_JSON) as Record<string, unknown>;

describe('validateManifest', () => {
  it('accepts a valid manifest', () => {
    const result = validateManifest(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('hello');
      expect(result.warnings).toEqual([]);
    }
  });

  it('rejects a missing $schema', () => {
    const { name, ...rest } = VALID;
    void name;
    const result = validateManifest(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('manifest-fatal');
    }
  });

  it('rejects an unsupported $schema version', () => {
    const result = validateManifest({
      ...VALID,
      $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('manifest-schema');
    }
  });

  it('rejects name constraint violations', () => {
    for (const name of [
      'bad..name',
      'bad--name',
      'Uppercase',
      '-lead',
      'trail-',
      '_x',
      'x'.repeat(65),
    ]) {
      const result = validateManifest({ ...VALID, name });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('manifest-fatal');
      }
    }
  });

  it('rejects a non-object author', () => {
    const result = validateManifest({ ...VALID, author: 'nobody' });
    expect(result.ok).toBe(false);
  });

  it('reports and ignores unknown top-level fields', () => {
    const result = validateManifest({ ...VALID, unknownField: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((w) => w.kind)).toEqual(['manifest-unknown-fields']);
      expect(result.manifest).not.toHaveProperty('unknownField');
    }
  });

  it('reports and ignores a non-object extensions field', () => {
    const result = validateManifest({ ...VALID, extensions: 'nope' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings.map((w) => w.kind)).toEqual(['extensions-non-object']);
    }
  });

  it('rejects a non-object manifest', () => {
    const result = validateManifest('string');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('manifest-fatal');
    }
  });
});

describe('loadManifest', () => {
  it('reads a manifest from disk', async () => {
    const dir = await tempDir('oap-manifest-');
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${dir.root}/plugin.json`, VALID_PLUGIN_JSON, 'utf8');
      const result = await loadManifest(dir.root);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.name).toBe('hello');
      }
    } finally {
      await dir.cleanup();
    }
  });

  it('reports a missing manifest as plugin-missing', async () => {
    const dir = await tempDir('oap-manifest-');
    try {
      const result = await loadManifest(dir.root);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('plugin-missing');
      }
    } finally {
      await dir.cleanup();
    }
  });

  it('reports an unparsable manifest as plugin-missing', async () => {
    const dir = await tempDir('oap-manifest-');
    try {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${dir.root}/plugin.json`, '{ nope', 'utf8');
      const result = await loadManifest(dir.root);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.kind).toBe('plugin-missing');
      }
    } finally {
      await dir.cleanup();
    }
  });
});

describe('schemaVersion', () => {
  it('extracts the version segment', () => {
    expect(schemaVersion('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')).toBe(
      '1.0.0',
    );
    expect(schemaVersion('nope')).toBeNull();
  });
});
