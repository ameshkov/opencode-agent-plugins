/**
 * Diagnostic scanner for the opt-in top-plugins e2e suite.
 *
 * Runs INSIDE the e2e container against a plugin tree (the installed store
 * copy) and prints one JSON document describing:
 *
 * - what the client's own validation pipeline accepts or reports (manifest,
 *   skills, MCP servers, taxonomy warnings) — it imports the same
 *   `build/lib/validate.js` the plugin and CLI use, so install-time and
 *   load-time findings cannot disagree;
 * - what the raw tree contains that the client does NOT consume: unknown
 *   manifest fields, extension namespaces, nested `SKILL.md` files, non-skill
 *   entries under `skills/`, unsupported MCP entry keys/types, and other
 *   component directories (`agents/`, `commands/`, ...).
 *
 * Usage: node /app/scan-plugin.mjs <plugin-root> [data-dir]
 *
 * Copied into the image by `test-e2e/Dockerfile`; a diagnostic helper, not a
 * test case.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** Manifest fields the client understands; every other key is warn+ignored. */
const KNOWN_MANIFEST_FIELDS = new Set([
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

/** Top-level directories that carry component types the client ignores. */
const UNSUPPORTED_COMPONENT_DIRS = new Set([
  'agents',
  'commands',
  'tools',
  'hooks',
  'prompts',
  'workflows',
  '.claude',
  '.claude-plugin',
  '.opencode',
]);

/**
 * Reads and parses a JSON file.
 *
 * @param {string} path - Absolute file path.
 * @returns {Promise<unknown>} The parsed value, or undefined when missing or
 * invalid.
 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * True when the path exists and is a directory.
 *
 * @param {string} path - Absolute path.
 * @returns {Promise<boolean>} Directory check.
 */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * True when the path exists and is a regular file.
 *
 * @param {string} path - Absolute path.
 * @returns {Promise<boolean>} File check.
 */
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Lists regular files under a directory recursively.
 *
 * @param {string} dir - Absolute directory path.
 * @param {string} [prefix] - The relative prefix accumulated so far.
 * @returns {Promise<string[]>} Relative file paths (POSIX separators).
 */
async function walkFiles(dir, prefix = '') {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(join(dir, entry.name), relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

/**
 * Raw scan of the `skills/` layout, valid or not.
 *
 * @param {string} root - Plugin root.
 * @returns {Promise<object>} Presence, immediate dirs, dirs missing SKILL.md,
 * nested SKILL.md files, and stray non-directory entries.
 */
async function scanSkillsLayout(root) {
  const skillsDir = join(root, 'skills');
  const layout = {
    present: await isDirectory(skillsDir),
    dirs: /** @type {string[]} */ ([]),
    dirsWithoutSkillMd: /** @type {string[]} */ ([]),
    nestedSkillFiles: /** @type {string[]} */ ([]),
    strayEntries: /** @type {string[]} */ ([]),
  };
  if (!layout.present) {
    return layout;
  }
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      layout.strayEntries.push(entry.name);
      continue;
    }
    layout.dirs.push(entry.name);
    if (!(await isFile(join(skillsDir, entry.name, 'SKILL.md')))) {
      layout.dirsWithoutSkillMd.push(entry.name);
    }
    for (const file of await walkFiles(join(skillsDir, entry.name))) {
      // `SKILL.md` directly inside the skill dir is the skill itself; only
      // deeper files are nested (docs/explanation/design.md §5.6).
      if (file !== 'SKILL.md' && file.endsWith('SKILL.md')) {
        layout.nestedSkillFiles.push(`${entry.name}/${file}`);
      }
    }
  }
  return layout;
}

/**
 * Raw scan of `mcp.json` including entries the client would skip.
 *
 * @param {string} root - Plugin root.
 * @returns {Promise<object>} Presence, parse state, top-level keys, and one
 * record per server entry (`name`, `type`, `keys`).
 */
async function scanMcpRaw(root) {
  const path = join(root, 'mcp.json');
  const present = await isFile(path);
  const raw = present ? await readJson(path) : undefined;
  const result = {
    present,
    parseError: present && raw === undefined,
    schema: undefined,
    topLevelKeys: /** @type {string[]} */ ([]),
    entries: /** @type {Array<{ name: string; type: unknown; keys: string[] }>} */ ([]),
  };
  if (raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    result.schema = typeof raw.$schema === 'string' ? raw.$schema : undefined;
    result.topLevelKeys = Object.keys(raw);
    const servers = raw.mcpServers;
    if (servers !== null && typeof servers === 'object' && !Array.isArray(servers)) {
      for (const [name, entry] of Object.entries(servers)) {
        const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
        result.entries.push({
          name,
          type: isObject ? (entry.type ?? null) : null,
          keys: isObject ? Object.keys(entry) : [],
        });
      }
    }
  }
  return result;
}

const [root, dataDir = '/tmp/scan-plugin-data'] = process.argv.slice(2);
if (root === undefined || root === '') {
  console.error('usage: node scan-plugin.mjs <plugin-root> [data-dir]');
  process.exit(2);
}

const { validatePluginTree } = await import('/app/plugin/build/lib/validate.js');
const validated = await validatePluginTree(root, dataDir);

const rawManifest = await readJson(join(root, 'plugin.json'));
const manifestIsObject =
  rawManifest !== null && typeof rawManifest === 'object' && !Array.isArray(rawManifest);
const extensionKeys =
  manifestIsObject &&
  rawManifest.extensions !== null &&
  typeof rawManifest.extensions === 'object' &&
  !Array.isArray(rawManifest.extensions)
    ? Object.keys(rawManifest.extensions)
    : [];

const topLevel = (await readdir(root, { withFileTypes: true })).map((entry) => ({
  name: entry.name,
  kind: entry.isDirectory() ? 'dir' : 'file',
}));

console.log(
  JSON.stringify(
    {
      root,
      manifest: {
        name: validated.manifest.name,
        version: validated.manifest.version ?? null,
        schema: validated.manifest.$schema,
        rawKeys: manifestIsObject ? Object.keys(rawManifest) : [],
        unknownKeys: manifestIsObject
          ? Object.keys(rawManifest).filter((key) => !KNOWN_MANIFEST_FIELDS.has(key))
          : [],
        extensions: extensionKeys,
      },
      skills: validated.skills,
      skillsLayout: await scanSkillsLayout(root),
      servers: validated.servers,
      mcpRaw: await scanMcpRaw(root),
      warnings: validated.warnings.map((warning) => ({
        kind: warning.kind,
        level: warning.level,
        message: warning.message,
      })),
      fatal: validated.fatal,
      layout: {
        topLevel,
        unsupportedComponentDirs: topLevel
          .filter((entry) => entry.kind === 'dir' && UNSUPPORTED_COMPONENT_DIRS.has(entry.name))
          .map((entry) => entry.name),
      },
    },
    null,
    2,
  ),
);
