/**
 * CLI monorepo subpath scenarios (`docs/design.md` §5.3.4, §9.2): two subdirs
 * of one repository install side by side, `list` shows the subdir, `--ref`
 * overrides only the ref, and update/remove on one leaves the other intact.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  gitBareFixture,
  gitCmd,
  skillMd,
  storeEnv,
  tempDir,
  type GitBareFixture,
  type TempDir,
} from '../../test/helpers.js';
import { cmdInstall } from './install.js';
import { cmdRemove } from './remove.js';
import { cmdUpdate } from './update.js';
import { cmdList, cmdDoctor } from './inspect.js';
import { parseArgs } from './args.js';
import { installedRootFor, readMeta } from '../lib/store.js';
import { slugOf } from '../lib/resolve.js';

/** Queued answers for the mocked `confirm` prompt (in order of calls). */
const confirmAnswers = vi.hoisted(() => ({ queue: [] as boolean[] }));
vi.mock('./prompts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./prompts.js')>();
  return {
    ...actual,
    confirm: vi.fn(async () => confirmAnswers.queue.shift() ?? false),
  };
});

/** A minimal valid manifest for a named subdir package. */
function packageManifest(name: string, version: string): string {
  return JSON.stringify(
    {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name,
      version,
      description: `${name} plugin`,
    },
    undefined,
    2,
  );
}

let fixture: GitBareFixture;
let store: TempDir;
let configPath = '';
let env: Record<string, string | undefined> = {};
let alphaSlug = '';
let betaSlug = '';
const alphaSource = () => `${fixture.source}#:packages/alpha`;
const betaSource = () => `${fixture.source}#:packages/beta`;

function argsOf(command: string, positionals: string[], flags: string[] = []) {
  return parseArgs([command, ...positionals, '--config', configPath, ...flags]);
}

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fixture = await gitBareFixture({
    'packages/alpha/plugin.json': packageManifest('alpha', '1.0.0'),
    'packages/alpha/skills/alpha/SKILL.md': skillMd('alpha', 'Alpha skill'),
    'packages/beta/plugin.json': packageManifest('beta', '1.0.0'),
    'packages/beta/skills/beta/SKILL.md': skillMd('beta', 'Beta skill'),
  });
  await gitCmd(['tag', 'v1.0.0'], fixture.work);
  await gitCmd(['push', '--tags'], fixture.work);

  store = await tempDir('oap-cli-subdir-store-');
  env = storeEnv(store.root);
  process.env['XDG_DATA_HOME'] = env['XDG_DATA_HOME'];
  configPath = join(store.root, 'opencode.json');
  await writeFile(
    configPath,
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      plugin: [['opencode-agent-plugins', { plugins: [] }]],
    }),
    'utf8',
  );
  alphaSlug = slugOf(fixture.source, 'packages/alpha');
  betaSlug = slugOf(fixture.source, 'packages/beta');
});

afterAll(async () => {
  delete process.env['XDG_DATA_HOME'];
  vi.restoreAllMocks();
  await fixture.cleanup();
  await store.cleanup();
});

describe('CLI subdir lifecycle', () => {
  it('installs two subdirs of one repository side by side (§9.2)', async () => {
    const alphaExit = await cmdInstall(argsOf('install', [alphaSource()], ['--yes']));
    expect(alphaExit).toBe(0);
    const betaExit = await cmdInstall(
      argsOf('install', [betaSource()], ['--yes', '--ref', 'v1.0.0']),
    );
    expect(betaExit).toBe(0);

    expect(alphaSlug).not.toBe(betaSlug);
    const alphaMeta = await readMeta(alphaSlug, env);
    const betaMeta = await readMeta(betaSlug, env);
    expect(alphaMeta?.subdir).toBe('packages/alpha');
    expect(betaMeta?.subdir).toBe('packages/beta');
    // `--ref` overrides only the ref; the subdir and slug stay intact.
    expect(alphaMeta?.ref).toBeUndefined();
    expect(betaMeta?.ref).toBe('v1.0.0');
    // Each installed tree contains only its own subdir package.
    expect(await readFile(join(installedRootFor(alphaSlug, env), 'plugin.json'), 'utf8')).toContain(
      '"alpha"',
    );
    expect(await readFile(join(installedRootFor(betaSlug, env), 'plugin.json'), 'utf8')).toContain(
      '"beta"',
    );
    // The config round-trip carries both original source strings.
    const config = await readFile(configPath, 'utf8');
    expect(config).toContain(alphaSource());
    expect(config).toContain(betaSource());
  });

  it('refuses a case-only slug collision as already installed (§10)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const exitCode = await cmdInstall(
        argsOf('install', [`${fixture.source}#:Packages/ALPHA`], ['--yes']),
      );
      expect(exitCode).toBe(1);
      expect(err.mock.calls.some((call) => String(call[0]).includes('already installed'))).toBe(
        true,
      );
      const config = await readFile(configPath, 'utf8');
      expect(config.match(/packages\/alpha/g) ?? []).toHaveLength(1);
    } finally {
      err.mockRestore();
    }
  });

  it('list shows the subdir for each installed entry (§5.11)', async () => {
    const exitCode = await cmdList();
    expect(exitCode).toBe(0);
    const output = vi
      .mocked(console.log)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(output).toContain('subdir:packages/alpha');
    expect(output).toContain('subdir:packages/beta');
  });

  it('doctor reports the subdir store entries as referenced (§5.11)', async () => {
    const exitCode = await cmdDoctor(argsOf('doctor', []));
    expect(exitCode).toBe(0);
  });

  it('rejects a malformed subdir with nothing written (§5.3.4)', async () => {
    const before = await readFile(configPath, 'utf8');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const exitCode = await cmdInstall(
        argsOf('install', [`${fixture.source}#:../evil`], ['--yes']),
      );
      expect(exitCode).toBe(1);
      expect(await readFile(configPath, 'utf8')).toBe(before);
    } finally {
      err.mockRestore();
    }
  });

  it('updates one subdir and leaves the other untouched (§5.12.3)', async () => {
    const betaBefore = await readMeta(betaSlug, env);
    await writeFile(
      join(fixture.work, 'packages/alpha/plugin.json'),
      packageManifest('alpha', '1.1.0'),
      'utf8',
    );
    await gitCmd(['add', '-A'], fixture.work);
    await gitCmd(['commit', '-m', 'alpha 1.1.0'], fixture.work);
    await gitCmd(['push', 'origin', 'main'], fixture.work);

    const exitCode = await cmdUpdate(argsOf('update', [alphaSlug], ['--yes']));
    expect(exitCode).toBe(0);
    const alphaMeta = await readMeta(alphaSlug, env);
    const betaMeta = await readMeta(betaSlug, env);
    expect(alphaMeta?.manifestVersion).toBe('1.1.0');
    expect(alphaMeta?.subdir).toBe('packages/alpha');
    expect(betaMeta?.resolvedCommit).toBe(betaBefore?.resolvedCommit);
  });

  it('removes one subdir and leaves the other registered (§5.12.2)', async () => {
    const exitCode = await cmdRemove(argsOf('remove', [alphaSlug], ['--yes']));
    expect(exitCode).toBe(0);
    const config = await readFile(configPath, 'utf8');
    expect(config).not.toContain(alphaSource());
    expect(config).toContain(betaSource());
    expect(await readMeta(alphaSlug, env)).toBeNull();
    expect(await readMeta(betaSlug, env)).not.toBeNull();
  });
});
