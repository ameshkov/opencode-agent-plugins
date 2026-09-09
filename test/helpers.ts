/**
 * Shared test helpers: temporary plugin trees and store env.
 *
 * Test support code — must NOT end in `.test.ts` (AGENTS.md "Testing").
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { slugOf } from '../src/lib/resolve.js';

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

/**
 * Runs a git command, failing the test on error.
 *
 * @param args - Git arguments (without the `git` binary itself).
 * @param cwd - Working directory, when the command is repo-scoped.
 * @returns The command's stdout.
 */
export async function gitCmd(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
        return;
      }
      resolveResult(stdout);
    });
  });
}

/**
 * Writes the standard test plugin tree (plugin.json + skills + MCP servers)
 * into a directory.
 *
 * @param dir - Directory to write into.
 * @param version - `plugin.json` version to write.
 */
export async function writePluginTree(dir: string, version: string): Promise<void> {
  await mkdir(join(dir, 'skills', 'hello'), { recursive: true });
  await writeFile(
    join(dir, 'plugin.json'),
    JSON.stringify(
      {
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'hello',
        version,
        description: 'Test plugin',
      },
      undefined,
      2,
    ),
    'utf8',
  );
  await writeFile(join(dir, 'skills', 'hello', 'SKILL.md'), skillMd('hello', 'Hi'), 'utf8');
  await writeFile(
    join(dir, 'mcp.json'),
    JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { echo: { type: 'stdio', command: 'echo', args: ['--ping'] } },
    }),
    'utf8',
  );
}

/** A git fixture: bare remote plus its working tree. */
export interface GitBareFixture {
  /** Bare-remote source URL, usable as a plugin source. */
  source: string;
  /** Store slug derived from the source URL. */
  slug: string;
  /** Working-tree directory (edits + pushes happen here). */
  work: string;
  /** Bare remote directory. */
  bare: string;
  /** Removes both temp directories. */
  cleanup: () => Promise<void>;
}

/**
 * Creates an initialized git fixture (bare remote + working tree on `main`)
 * seeded with the given files and pushed.
 *
 * @param files - Map of relative path → file content (nested paths created).
 * @param prefix - Temp directory prefix.
 * @returns The fixture with its source URL, slug, and working/bare paths.
 */
export async function gitBareFixture(
  files: Record<string, string>,
  prefix = 'oap-git-',
): Promise<GitBareFixture> {
  const work = await tempDir(`${prefix}work-`);
  const bare = await tempDir(`${prefix}bare-`);
  const barePath = join(bare.root, 'remote.git');
  await gitCmd(['init', '--bare', barePath]);
  await gitCmd(['symbolic-ref', 'HEAD', 'refs/heads/main'], barePath);
  await gitCmd(['init', '-b', 'main', work.root]);
  await gitCmd(['config', 'user.email', 'a@b.c'], work.root);
  await gitCmd(['config', 'user.name', 'Test'], work.root);
  for (const [rel, content] of Object.entries(files)) {
    const target = join(work.root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await gitCmd(['add', '-A'], work.root);
  await gitCmd(['commit', '-m', 'init'], work.root);
  await gitCmd(['remote', 'add', 'origin', barePath], work.root);
  await gitCmd(['push', '-u', 'origin', 'main'], work.root);
  const source = `file://${barePath}`;
  return {
    source,
    slug: slugOf(source),
    work: work.root,
    bare: barePath,
    cleanup: async () => {
      await work.cleanup();
      await bare.cleanup();
    },
  };
}
