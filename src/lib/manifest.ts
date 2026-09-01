/**
 * `plugin.json` parsing and validation (`docs/design.md` §5.4).
 *
 * The manifest is a closed schema validated with Ajv against the vendored
 * Agent Plugins schema (`src/schemas/1.0.0-plugin.schema.json`), which is
 * committed to the repo and never fetched at runtime (the spec forbids
 * schema retrieval while loading a plugin).
 *
 * Validation order per design: unknown top-level keys are stripped first, so
 * a fatal error in a known field is never masked by the presence of unknown
 * ones, and the report-and-ignore reclassification of unknown fields is
 * meaningful only against the closed schema.
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { Failure } from './errors.js';
import { failure } from './errors.js';

const requireJson = createRequire(import.meta.url);

/** Canonical identifier of the 1.0.0 plugin manifest schema. */
const PLUGIN_SCHEMA_1_0_0 = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

/**
 * Canonical schema identifiers this client implements (`docs/design.md`
 * §5.9). Adding a new spec version is a one-line extension of this map.
 */
const SUPPORTED_PLUGIN_SCHEMAS: ReadonlySet<string> = new Set([PLUGIN_SCHEMA_1_0_0]);

/** The manifest fields known to the closed schema (top level). */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  '$schema',
  'name',
  'version',
  'description',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords',
  'extensions',
]);

/** Validated `plugin.json` contents. */
export interface ManifestData {
  /** Canonical schema identifier of the manifest. */
  $schema: string;
  /** Plugin name: 1–64 chars, `a-z 0-9 - .`, alphanumeric start/end. */
  name: string;
  /** Semver-ish version string, when present. */
  version?: string;
  /** Short human-readable description, when present. */
  description?: string;
  /** Author information (all fields optional). */
  author?: { name?: string; email?: string; url?: string };
  /** Homepage URL, when present. */
  homepage?: string;
  /** Repository URL, when present. */
  repository?: string;
  /** License identifier, when present. */
  license?: string;
  /** Keyword strings, when present. */
  keywords?: string[];
  /** Client extension namespaces (unimplemented namespace objects). */
  extensions?: Record<string, unknown>;
}

/** Result of manifest validation. */
export type ManifestResult =
  { ok: true; manifest: ManifestData; warnings: Failure[] } | { ok: false; failure: Failure };

/**
 * Extracts the spec version from a canonical schema identifier.
 *
 * @param schemaId - A canonical `.../schemas/<version>/...` identifier.
 * @returns The version segment (e.g. `"1.0.0"`), or null when the identifier
 * has no recognizable version segment.
 */
export function schemaVersion(schemaId: string): string | null {
  const match = /\/schemas\/([^/]+)\//.exec(schemaId);
  return match === null ? null : match[1]!;
}

/**
 * Reads and validates `<root>/plugin.json`.
 *
 * @param pluginRoot - Absolute plugin root directory.
 * @returns The validation result. Rejection failures carry the taxonomy
 * kind (`plugin-missing`, `manifest-schema`, `manifest-fatal`).
 */
export async function loadManifest(pluginRoot: string): Promise<ManifestResult> {
  let text: string;
  try {
    text = await readFile(join(pluginRoot, 'plugin.json'), 'utf8');
  } catch {
    return {
      ok: false,
      failure: failure('plugin-missing', `plugin.json not found in ${pluginRoot}`),
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      failure: failure('plugin-missing', `plugin.json in ${pluginRoot} is not valid JSON`),
    };
  }
  return validateManifest(raw);
}

/** @internal Exported for tests only; not part of the public module API. */
export function validateManifest(raw: unknown): ManifestResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      failure: failure('manifest-fatal', 'plugin.json must be a JSON object'),
    };
  }

  const rawSchema = raw['$schema'];
  if (typeof rawSchema !== 'string') {
    return {
      ok: false,
      failure: failure('manifest-fatal', 'plugin.json "$schema" must be a string'),
    };
  }
  if (!SUPPORTED_PLUGIN_SCHEMAS.has(rawSchema)) {
    return {
      ok: false,
      failure: failure('manifest-schema', `unsupported Agent Plugins version: ${rawSchema}`),
    };
  }

  const warnings: Failure[] = [];
  const clean = splitKnownFields(raw, warnings);

  const validate = validator();
  const valid = validate(clean);
  if (!valid) {
    const message = firstError(validate.errors);
    return {
      ok: false,
      failure: failure('manifest-fatal', `invalid plugin.json: ${message}`),
    };
  }
  return { ok: true, manifest: clean as unknown as ManifestData, warnings };
}

/** Extracts the known (closed-schema) fields, reporting ignored ones. */
function splitKnownFields(
  raw: Record<string, unknown>,
  warnings: Failure[],
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(
        failure('manifest-unknown-fields', `unknown plugin.json field "${key}" ignored`, {
          field: key,
          section: '§5.4',
        }),
      );
      continue;
    }
    if (
      key === 'extensions' &&
      (typeof value !== 'object' || value === null || Array.isArray(value))
    ) {
      warnings.push(
        failure('extensions-non-object', `plugin.json "extensions" ignored (not an object)`),
      );
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

/** Lazily-built, cached Ajv validator for the vendored schema. */
let cachedValidate: ValidateFunction | null = null;

/** Returns (and caches) the Ajv validator for the plugin schema. */
function validator(): ValidateFunction {
  if (cachedValidate === null) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const json = requireJson('../schemas/1.0.0-plugin.schema.json') as object;
    cachedValidate = ajv.compile(json);
  }
  return cachedValidate;
}

/** Formats the first Ajv error for a human-readable rejection message. */
function firstError(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) {
    return 'validation failed';
  }
  const first = errors[0] as { instancePath: string; message?: string };
  const where = first.instancePath === '' ? '(root)' : first.instancePath;
  return `${where}: ${first.message ?? 'invalid'}`;
}

/** Type guard for a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
