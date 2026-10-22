/**
 * `mcp.json` per-entry schema validation (`docs/explanation/registration.md`).
 *
 * The schema is vendored under `src/schemas/` and compiled lazily with Ajv.
 * Keeping it separate from discovery keeps `mcp.ts` focused on translation.
 */

import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';

const requireJson = createRequire(import.meta.url);

/** Result of per-entry schema validation. */
export type EntryValidation = { ok: true } | { ok: false; message: string };

/**
 * Validates one `mcpServers` entry against the vendored schema.
 *
 * @param entry - Parsed entry value.
 * @returns `{ ok: true }`, or the first schema error message.
 */
export function validateMcpEntry(entry: unknown): EntryValidation {
  const validate = entryValidator();
  if (validate(entry)) {
    return { ok: true };
  }
  return { ok: false, message: entryError(validate.errors) };
}

/** Lazily-built Ajv validator for `#/$defs/server` (per-entry conformance). */
let cachedEntryValidate: ValidateFunction | null = null;

/** Returns (and caches) the per-entry validator compiled from the mcp schema. */
function entryValidator(): ValidateFunction {
  if (cachedEntryValidate === null) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const schema = requireJson('../schemas/1.0.0-mcp.schema.json') as object & { $id: string };
    ajv.addSchema(schema);
    cachedEntryValidate = ajv.compile({
      $ref: `${schema.$id}#/$defs/server`,
    } as never);
  }
  return cachedEntryValidate;
}

/** Formats the first Ajv error of an entry validation. */
function entryError(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) {
    return 'invalid server entry';
  }
  const first = errors[0] as { message?: string };
  return first.message ?? 'invalid server entry';
}
