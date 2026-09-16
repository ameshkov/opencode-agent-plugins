/**
 * `mcp.json` parsing, validation and translation (`docs/explanation/design.md` §5.7).
 *
 * The portable format is a closed schema (`$schema` + `mcpServers` with
 * `stdio` / `streamable-http` / `sse` entries). Each entry is validated
 * independently so a bad entry is skipped with a warning while the rest of
 * the plugin keeps loading; only a bad top-level shape disables MCP for the
 * plugin (skills still load).
 *
 * Translation: `stdio` → opencode `type: "local"` with `${PLUGIN_ROOT}` /
 * `${PLUGIN_DATA}` injected into the subprocess environment; `streamable-http`
 * → `type: "remote"`; `sse` → skipped (unsupported transport, spec OPTIONAL).
 */

import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import type { Failure } from './errors.js';
import { failure } from './errors.js';
import { expandPlaceholders, resolveCommand, resolveCwd } from './paths.js';
import { validateHeaders, validateRemoteUrl } from './remote.js';
import { schemaVersion } from './manifest.js';

const requireJson = createRequire(import.meta.url);

/** Canonical identifier of the 1.0.0 mcp.json schema. */
const MCP_SCHEMA_1_0_0 = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

/** Canonical schema identifiers this client implements (§5.9). */
const SUPPORTED_MCP_SCHEMAS: ReadonlySet<string> = new Set([MCP_SCHEMA_1_0_0]);

/** Opencode-native config for a translated stdio server. */
interface LocalMcpConfig {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  cwd?: string;
}

/** Opencode-native config for a translated remote server. */
interface RemoteMcpConfig {
  type: 'remote';
  url: string;
  headers?: Record<string, string>;
}

/** OpenCode-native MCP config (runtime superset of the SDK type). */
type McpConfigLike = LocalMcpConfig | RemoteMcpConfig;

/** A validated/translated server entry. */
export interface McpServerSpec {
  /** Raw server name from `mcp.json` (validated against the charset). */
  name: string;
  /** What the server translates to: local / remote / skipped. */
  kind: 'local' | 'remote' | 'skipped';
  /** OpenCode config, present for local/remote kinds. */
  config?: McpConfigLike;
  /** Why the entry was skipped (skipped kind only). */
  skipReason?: string;
}

/** Result of processing a plugin's `mcp.json`. */
export interface McpDiscovery {
  /** absent: no mcp.json (valid); ok: loaded; disabled: MCP unusable. */
  status: 'absent' | 'ok' | 'disabled';
  /** Why MCP was disabled (status `disabled`). */
  reason?: string;
  /** Per-entry results, including skipped/invalid entries. */
  servers: McpServerSpec[];
  /** Non-fatal failures: invalid entries and unsupported transports. */
  failures: Failure[];
}

/**
 * Reads, validates and translates `<root>/mcp.json`.
 *
 * @param pluginRoot - Absolute plugin root directory.
 * @param pluginSchemaId - `$schema` of the loaded `plugin.json`, used for the
 * version-consistency check (§5.9; mismatch disables MCP only).
 * @param dataDir - The plugin's `PLUGIN_DATA` dir path (needed for cwd
 * containment checks; the directory itself is created by the caller once the
 * plugin is known to have valid stdio servers).
 * @returns The discovery result; never throws.
 */
export async function discoverMcp(
  pluginRoot: string,
  pluginSchemaId: string,
  dataDir: string,
): Promise<McpDiscovery> {
  let text: string;
  try {
    text = await readFile(join(pluginRoot, 'mcp.json'), 'utf8');
  } catch {
    return { status: 'absent', servers: [], failures: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      status: 'disabled',
      reason: 'mcp.json is not valid JSON',
      servers: [],
      failures: [
        failure('mcp-invalid', 'mcp.json is not valid JSON; MCP disabled', { section: '§5.7' }),
      ],
    };
  }

  if (!isRecord(raw)) {
    return disabled('mcp.json must be a JSON object');
  }
  const topProblem = checkMcpTopLevel(raw, pluginSchemaId);
  if (topProblem !== null) {
    return disabled(topProblem);
  }
  const { servers, failures } = processServerEntries(
    raw['mcpServers'] as Record<string, unknown>,
    pluginRoot,
    dataDir,
  );
  return { status: 'ok', servers, failures };
}

/** Validates the closed top-level shape ($schema + mcpServers only). */
function checkMcpTopLevel(raw: Record<string, unknown>, pluginSchemaId: string): string | null {
  if (!isRecord(raw['mcpServers'])) {
    return 'mcp.json must be an object with an object "mcpServers"';
  }
  const rawSchema = raw['$schema'];
  if (typeof rawSchema !== 'string' || !SUPPORTED_MCP_SCHEMAS.has(rawSchema)) {
    return `unsupported mcp.json $schema: ${String(rawSchema)}`;
  }
  if (schemaVersion(rawSchema) !== schemaVersion(pluginSchemaId)) {
    return `mcp.json version does not match plugin.json (${pluginSchemaId})`;
  }
  for (const key of Object.keys(raw)) {
    if (key !== '$schema' && key !== 'mcpServers') {
      return `unknown top-level mcp.json field "${key}"`;
    }
  }
  return null;
}

/** Validates and translates each server entry (narrowest unit dropped). */
function processServerEntries(
  entries: Record<string, unknown>,
  pluginRoot: string,
  dataDir: string,
): { servers: McpServerSpec[]; failures: Failure[] } {
  const servers: McpServerSpec[] = [];
  const failures: Failure[] = [];
  const validateEntry = entryValidator();
  for (const [name, entry] of Object.entries(entries)) {
    if (!isValidServerName(name)) {
      failures.push(
        failure('server-invalid', `server "${name}": invalid name (use A-Za-z0-9_-, max 64)`, {
          server: name,
          section: '§5.7',
        }),
      );
      continue;
    }
    if (!validateEntry(entry)) {
      const message = entryError(validateEntry.errors);
      failures.push(failure('server-invalid', `server "${name}": ${message}`, { server: name }));
      continue;
    }
    const translated = translateEntry(name, entry as McpServerEntry, pluginRoot, dataDir);
    if (translated.problem !== null) {
      const { kind, message } = translated.problem;
      // A containment escape gets its own taxonomy boundary (§5.5); any other
      // invalid entry stays a generic `server-invalid`.
      if (kind === 'escape') {
        failures.push(
          failure('path-escape', `server "${name}": ${message}`, { server: name, section: '§5.5' }),
        );
      } else {
        failures.push(failure('server-invalid', `server "${name}": ${message}`, { server: name }));
      }
      continue;
    }
    if (translated.spec.kind === 'skipped') {
      failures.push(
        failure('server-transport', `server "${name}": ${translated.spec.skipReason}`, {
          server: name,
        }),
      );
      continue;
    }
    servers.push(translated.spec);
  }
  return { servers, failures };
}

/** A parsed `mcpServers` entry before transport-specific processing. */
type McpServerEntry = Record<string, unknown> & { type: string };

/** Kind of an entry problem: a containment escape vs. any other invalid form. */
type EntryProblemKind = 'escape' | 'invalid';

/** A skipped-entry problem, classified for the failure taxonomy. */
interface EntryProblem {
  /** `escape` = a path leaves the plugin root/anchors (§5.5); else invalid form. */
  kind: EntryProblemKind;
  /** Human-readable description (the entry skip reason). */
  message: string;
}

/**
 * Validates and translates a single entry (already passing `$defs/server`)
 * into OpenCode config, running the transport-specific checks: command/cwd
 * containment (§5.5) for stdio, URL/header rules (§5.7) for remote.
 *
 * @param name - Server name (already charset-validated).
 * @param entry - Validated entry (passes the `$defs/server` schema).
 * @param root - Absolute plugin root.
 * @param dataDir - Absolute plugin data dir (may not exist yet).
 * @returns The spec, plus a problem description when the entry is invalid
 * (skipped); sse entries come back as skipped with a transport reason.
 */
function translateEntry(
  name: string,
  entry: McpServerEntry,
  root: string,
  dataDir: string,
): { spec: McpServerSpec; problem: EntryProblem | null } {
  if (entry['type'] === 'sse') {
    return {
      spec: { name, kind: 'skipped', skipReason: 'transport "sse" is not supported' },
      problem: null,
    };
  }
  return entry['type'] === 'stdio'
    ? translateStdio(name, entry, root, dataDir)
    : translateRemote(name, entry);
}

/** Translates a stdio entry: containment checks + expansion + env injection. */
function translateStdio(
  name: string,
  entry: McpServerEntry,
  root: string,
  dataDir: string,
): { spec: McpServerSpec; problem: EntryProblem | null } {
  const command = entry['command'] as string;
  const resolved = resolveCommand(command, root);
  const cwdResolved = resolveCwd(entry['cwd'] as string | undefined, root, dataDir);
  if (!resolved.ok) {
    return {
      spec: { name, kind: 'skipped' },
      problem: { kind: resolved.kind, message: resolved.reason },
    };
  }
  if (!cwdResolved.ok) {
    return {
      spec: { name, kind: 'skipped' },
      problem: { kind: cwdResolved.kind, message: cwdResolved.reason },
    };
  }
  const env = expandedEnvOf(entry, root, dataDir);
  env['PLUGIN_ROOT'] = root;
  env['PLUGIN_DATA'] = dataDir;
  const config: LocalMcpConfig = {
    type: 'local',
    command: [resolved.path, ...expandedArgsOf(entry, root, dataDir)],
    environment: env,
    cwd: cwdResolved.path,
  };
  return { spec: { name, kind: 'local', config }, problem: null };
}

/** Translates a streamable-http entry: URL/header rules, then build config. */
function translateRemote(
  name: string,
  entry: McpServerEntry,
): { spec: McpServerSpec; problem: EntryProblem | null } {
  const url = entry['url'] as string;
  const urlProblem = validateRemoteUrl(url);
  if (urlProblem !== null) {
    return {
      spec: { name, kind: 'skipped' },
      problem: { kind: 'invalid', message: urlProblem },
    };
  }
  const rawHeaders = isRecord(entry['headers']) ? (entry['headers'] as Record<string, string>) : {};
  const headerProblem = Object.keys(rawHeaders).length > 0 ? validateHeaders(rawHeaders) : null;
  if (headerProblem !== null) {
    return {
      spec: { name, kind: 'skipped' },
      problem: { kind: 'invalid', message: headerProblem },
    };
  }
  const config: RemoteMcpConfig = { type: 'remote', url };
  if (Object.keys(rawHeaders).length > 0) {
    config.headers = rawHeaders;
  }
  return { spec: { name, kind: 'remote', config }, problem: null };
}

/** Expands env values (keys never expanded). */
function expandedEnvOf(
  entry: McpServerEntry,
  root: string,
  dataDir: string,
): Record<string, string> {
  const rawEnv = isRecord(entry['env']) ? entry['env'] : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    env[key] = expandPlaceholders(String(value), root, dataDir);
  }
  return env;
}

/** Expands args values (arguments are generic path-ish strings). */
function expandedArgsOf(entry: McpServerEntry, root: string, dataDir: string): string[] {
  const args = Array.isArray(entry['args']) ? (entry['args'] as string[]) : [];
  return args.map((arg) => expandPlaceholders(arg, root, dataDir));
}

/** Sanitizes a name for use as an opencode MCP server name (§5.7). */
export function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-');
}

/** Checks a server name against the opencode tool-prefix charset. */
export function isValidServerName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[A-Za-z0-9_-]+$/.test(name);
}

/** Builds a disabled-MCP result with the reason recorded. */
function disabled(reason: string): McpDiscovery {
  return {
    status: 'disabled',
    reason,
    servers: [],
    failures: [failure('mcp-invalid', `${reason}; MCP disabled`, { section: '§5.7' })],
  };
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

/** Type guard for a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
