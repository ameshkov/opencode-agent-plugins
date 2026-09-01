/**
 * Shared test helpers: temporary plugin trees and store env.
 *
 * Test support code — must NOT end in `.test.ts` (AGENTS.md "Testing").
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A temporary directory plus its cleanup. */
export interface TempDir {
  root: string;
  cleanup: () => Promise<void>;
}

/**
 * Creates a temporary directory.
 *
 * @param prefix - Directory-name prefix.
 * @returns The temp dir.
 */
export async function tempDir(prefix: string): Promise<TempDir> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/**
 * Writes a plugin tree into a temp directory.
 *
 * @param files - Map of relative path → file content (nested paths created).
 * @param prefix - Temp directory prefix.
 * @returns The temp plugin root.
 */
export async function tmpPlugin(
  files: Record<string, string>,
  prefix = 'oap-plugin-',
): Promise<TempDir> {
  const dir = await tempDir(prefix);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir.root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  return dir;
}

/** A minimal valid `plugin.json`. */
export const VALID_PLUGIN_JSON = JSON.stringify(
  {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'hello',
    version: '1.0.0',
    description: 'Test plugin',
    author: { name: 'Test Author' },
  },
  undefined,
  2,
);

/** A minimal valid `SKILL.md`. */
export function skillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

/** A minimal `mcp.json` with one stdio server. */
export function stdioMcp(name = 'echo'): string {
  return JSON.stringify(
    {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: {
        [name]: { type: 'stdio', command: './bin/serve.js', args: ['--ping'] },
      },
    },
    undefined,
    2,
  );
}

/** A valid in-memory plugin tree (as used by several tests). */
export const VALID_PLUGIN_TREE: Record<string, string> = {
  'plugin.json': VALID_PLUGIN_JSON,
  'skills/hello/SKILL.md': skillMd('hello', 'Greets the world.'),
  'mcp.json': stdioMcp(),
};

/**
 * Builds an environment whose XDG data home is a temp dir (isolaing the
 * client store per test).
 *
 * @param dir - The temp data home.
 * @returns `{ XDG_DATA_HOME: dir }` (plus the real HOME for ~ expansion).
 */
export function storeEnv(dir: string): Record<string, string | undefined> {
  return { XDG_DATA_HOME: dir, HOME: process.env['HOME'] };
}
