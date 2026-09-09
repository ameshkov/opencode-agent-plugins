// Dev-only helper to vendor or refresh the two Agent Plugins JSON schemas
// under src/schemas/ (docs/design.md §5.4).
//
// The plugin must never fetch a schema at runtime ("Clients MUST NOT
// retrieve a schema while loading a plugin"), so the schemas are committed.
// This script:
//   1. Downloads the canonical schemas from agent-plugins.org.
//   2. Asserts each top-level schema actually encodes closedness
//      (`additionalProperties: false` / `unevaluatedProperties: false` at
//      top level and per `$defs` entry) — reclassification of unknown keys
//      as report-and-ignore (docs/design.md §5.4) is meaningless against an
//      open schema.
//   3. Writes the downloaded bytes to src/schemas/ (only if they changed or
//      the file is missing), and reports a summary.
//
// Run manually: `node scripts/update-schemas.ts`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const schemasDir = resolve(here, '..', 'src', 'schemas');

/** Maps vendored file name -> canonical URL. */
const SCHEMAS: Record<string, string> = {
  '1.0.0-plugin.schema.json': 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
  '1.0.0-mcp.schema.json': 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
};

/**
 * Asserts that a schema encodes closedness: an object node
 * (`type: "object"` or one with `properties`) must either close itself with
 * `additionalProperties: false` / `unevaluatedProperties: false`, or be
 * intentionally open as a value map (`additionalProperties` is a schema, e.g.
 * the `headers` string map). Composition nodes (`oneOf`/`anyOf`/`allOf`) are
 * not object containers — their branches carry the closure, so the check
 * recurses into them.
 *
 * @param name - Schema name (for error messages).
 * @param schema - Parsed schema object.
 * @throws {Error} When an object node is implicitly open.
 */
function assertClosedness(name: string, schema: { $defs?: Record<string, unknown> }): void {
  const check = (label: string, node: unknown): void => {
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const record = node as Record<string, unknown>;
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      const branches = record[key];
      if (Array.isArray(branches)) {
        branches.forEach((branch, branchIndex) => {
          check(`${label}.${key}[${branchIndex}]`, branch);
        });
      }
    }
    const isObjectNode = record['type'] === 'object' || record['properties'] !== undefined;
    if (!isObjectNode) {
      return;
    }
    if (record['additionalProperties'] === false || record['unevaluatedProperties'] === false) {
      return;
    }
    const additional = record['additionalProperties'];
    // A schema object as `additionalProperties` is an intentional value map
    // (e.g. a string map); `false` closes the node (handled above); `true`
    // would leave it open — only the object form is exempt.
    if (typeof additional === 'object' && additional !== null) {
      return;
    }
    throw new Error(
      `${name}: "${label}" is not closed ` +
        '(additionalProperties / unevaluatedProperties must be false)',
    );
  };
  check('root', schema);
  for (const [key, defs] of Object.entries(schema.$defs ?? {})) {
    check(`$defs.${key}`, defs);
  }
}

mkdirSync(schemasDir, { recursive: true });

for (const [fileName, url] of Object.entries(SCHEMAS)) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch ${url}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const schema = JSON.parse(bytes.toString('utf8')) as { $defs?: Record<string, unknown> };
  assertClosedness(fileName, schema);

  const target = resolve(schemasDir, fileName);
  const existing = existsSync(target) ? readFileSync(target, 'utf8') : null;
  const changed = existing !== bytes.toString('utf8');
  if (changed) {
    writeFileSync(target, bytes);
  }
  console.log(`${fileName}: ${changed ? 'updated' : 'unchanged'} (${bytes.length} bytes)`);
}
