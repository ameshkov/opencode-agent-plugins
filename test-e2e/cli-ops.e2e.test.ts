/**
 * Docker e2e tests for the CLI lifecycle — no opencode server booted, so
 * these scenarios are cheap: they `docker exec` the `opencode-agent-plugins`
 * binary inside the `cli` scenario container and assert on the resulting
 * store/config filesystem (docs/design.md §5.12 — staging, validation,
 * atomic swap, doctor/prune, ref semantics).
 *
 * The container boots with the `opencode-agent-plugins` config tuple
 * registered (empty `plugins` array, the form the CLI edits) and a git
 * fixture remote at `file:///app/git-fixtures/remote.git` (v1.0.0, tag
 * `v1.0.0`). The tests mutate the fixture via `git-fixture.mjs` (push new
 * versions, break the manifest, move the tag) to create real drift.
 */

import { describe, expect, it } from 'vitest';
import { imageTag } from './helpers/image.js';
import { withScenario } from './helpers/scenario-run.js';
import type { Scenario } from './helpers/scenario.js';
import {
  GIT_FIXTURE_SLUG,
  GIT_FIXTURE_SOURCE,
  OPENCODE_VERSION,
  PLUGIN_ROOT,
  STORE_DIR,
} from './helpers/constants.js';

const CLI = GIT_FIXTURE_SOURCE;
const SLUG = GIT_FIXTURE_SLUG;
const INSTALLED = `${STORE_DIR}/installed/${SLUG}`;
const META = `${STORE_DIR}/meta/${SLUG}.json`;
const DATA_DIR = `${STORE_DIR}/data/${SLUG}`;

/** Runs a git-fixture mutation inside the scenario container. */
async function gitFixture(scenario: Scenario, ...args: string[]): Promise<void> {
  const result = await scenario.exec(['node', '/app/git-fixture.mjs', ...args]);
  expect(result.code, `git-fixture ${args.join(' ')} failed:\n${result.output}`).toBe(0);
}

/** Runs the CLI and asserts success (exit code 0). */
async function cliOk(scenario: Scenario, args: string[]): Promise<string> {
  const result = await scenario.cli(args);
  expect(result.code, `cli ${args.join(' ')} failed:\n${result.output}`).toBe(0);
  return result.output;
}

/** Runs the CLI and asserts failure with the given exit code. */
async function cliFail(scenario: Scenario, args: string[], code: number): Promise<string> {
  const result = await scenario.cli(args);
  expect(result.code, `cli ${args.join(' ')} expected exit ${code}:\n${result.output}`).toBe(code);
  return result.output;
}

/** Asserts the config's plugin array still references only the given text. */
async function configOf(scenario: Scenario): Promise<string> {
  return scenario.readFile('/app/workspace/opencode.json');
}

describe(`e2e cli ops: real filesystem, opencode ${OPENCODE_VERSION}`, () => {
  it(
    'install: sets up the store, edits the config JSONC, records the commit',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        const before = await configOf(scenario);
        expect(before).not.toContain(CLI);

        const out = await cliOk(scenario, ['install', CLI, '--yes']);
        expect(out).toContain('installed gitplug 1.0.0');
        expect(out).toContain('Restart OpenCode to use it');

        const after = await configOf(scenario);
        // The original source string is registered (never store-internal
        // paths, §5.11); the tuple is the npm package form (§5.11).
        expect(after).toContain(CLI);
        expect(after).toContain('opencode-agent-plugins');

        const meta = JSON.parse(await scenario.readFile(META)) as {
          resolvedCommit: string;
          manifestVersion: string;
          source: string;
        };
        expect(meta.resolvedCommit).toMatch(/^[0-9a-f]{40}$/);
        expect(meta.manifestVersion).toBe('1.0.0');
        expect(meta.source).toBe(CLI);

        const installedManifest = await scenario.readFile(`${INSTALLED}/plugin.json`);
        expect(installedManifest).toContain('"gitplug"');
        expect(await scenario.exists(`${INSTALLED}/.git`)).toBe(false);
      });
    },
    10 * 60 * 1000,
  );

  it(
    'check/update lifecycle: drift detection, atomic swap, PLUGIN_DATA preserved',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        await cliOk(scenario, ['install', CLI, '--yes']);

        // PLUGIN_DATA survives updates: seed it like a running plugin would.
        const seed = await scenario.exec([
          'node',
          '-e',
          [
            `require('fs').mkdirSync(${JSON.stringify(`${DATA_DIR}/nested`)}, { recursive: true });`,
            `require('fs').writeFileSync(${JSON.stringify(`${DATA_DIR}/nested/state.txt`)}, 'keep me');`,
            `process.exit(0);`,
          ].join(''),
        ]);
        expect(seed.code).toBe(0);

        // At the installed commit: up to date.
        let out = await cliOk(scenario, ['check']);
        expect(out).toContain(`${CLI}: up-to-date`);

        // Real drift: the fixture remote moves forward.
        await gitFixture(scenario, 'push-version', '1.1.0');
        const checkDrift = await scenario.cli(['check']);
        expect(checkDrift.code, checkDrift.output).toBe(2);
        expect(checkDrift.output).toContain('update-available');

        // Apply the update: staging → validate → atomic swap.
        out = await cliOk(scenario, ['update', '--yes']);
        expect(out).toContain('updated gitplug 1.1.0 (commit');
        expect(out).toContain('Restart OpenCode to pick it up');

        const meta = JSON.parse(await scenario.readFile(META)) as { manifestVersion: string };
        expect(meta.manifestVersion).toBe('1.1.0');
        const installedManifest = JSON.parse(
          await scenario.readFile(`${INSTALLED}/plugin.json`),
        ) as { version: string };
        expect(installedManifest.version).toBe('1.1.0');

        // The rollback dir is gone and PLUGIN_DATA survived.
        expect(await scenario.exists(`${STORE_DIR}/installed/.old-${SLUG}`)).toBe(false);
        expect(await scenario.readFile(`${DATA_DIR}/nested/state.txt`)).toBe('keep me');

        out = await cliOk(scenario, ['check']);
        expect(out).toContain(`${CLI}: up-to-date`);
      });
    },
    10 * 60 * 1000,
  );

  it(
    'update aborts on an invalid new manifest; the previous install is untouched',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        await cliOk(scenario, ['install', CLI, '--yes']);
        await gitFixture(scenario, 'push-broken');

        const out = await cliFail(scenario, ['update', '--yes'], 1);
        expect(out).toContain('fails validation');

        // Nothing half-applied: same commit recorded, same tree on disk.
        const meta = JSON.parse(await scenario.readFile(META)) as { manifestVersion: string };
        expect(meta.manifestVersion).toBe('1.0.0');
        const installedManifest = JSON.parse(
          await scenario.readFile(`${INSTALLED}/plugin.json`),
        ) as { version: string };
        expect(installedManifest.version).toBe('1.0.0');
      });
    },
    10 * 60 * 1000,
  );

  it(
    'tag ref semantics: pinned, moved-tag warning, --force to follow',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        // Install pinned to the tag.
        const tagged = `${CLI}#v1.0.0`;
        await cliOk(scenario, ['install', tagged, '--yes']);

        // Unmoved tag: pinned / up to date.
        const check = await scenario.cli(['check']);
        expect(check.code, check.output).toBe(0);
        expect(check.output).toContain('pinned at');

        // Advance main, then move the tag to the new commit: drift on a
        // tagged ref. Check warns; update refuses without --force.
        await gitFixture(scenario, 'push-version', '1.1.0');
        await gitFixture(scenario, 'move-tag', 'v1.0.0');
        const movedCheck = await scenario.cli(['check']);
        expect(movedCheck.output).toContain('moved-tag');
        const refused = await cliFail(scenario, ['update'], 1);
        expect(refused).toContain('tag moved; update requires --force');

        // --force follows the moved tag.
        const forced = await cliOk(scenario, ['update', '--yes', '--force']);
        expect(forced).toContain('Restart OpenCode to pick it up');
      });
    },
    10 * 60 * 1000,
  );

  it(
    'check reports unreachable remotes, path sources, and plain HEAD installs',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        // HEAD install: up to date.
        await cliOk(scenario, ['install', CLI, '--yes']);
        const head = await scenario.cli(['check']);
        expect(head.output).toContain(`${CLI}: up-to-date`);

        // Break the recorded URL: unreachable.
        await scenario.exec([
          'node',
          '-e',
          [
            `const fs = require('fs');`,
            `const p = ${JSON.stringify(META)};`,
            `const meta = JSON.parse(fs.readFileSync(p, 'utf8'));`,
            `meta.url = 'file:///app/git-fixtures/nowhere.git';`,
            `fs.writeFileSync(p, JSON.stringify(meta));`,
          ].join(' '),
        ]);
        const unreachable = await scenario.cli(['check']);
        expect(unreachable.output).toContain('unreachable');

        // Path source: "local path — update by editing the source".
        await cliOk(scenario, ['install', PLUGIN_ROOT, '--yes']);
        const pathCheck = await scenario.cli(['check']);
        expect(pathCheck.output).toContain('local path — update by editing the source');
      });
    },
    10 * 60 * 1000,
  );

  it(
    'doctor/prune: orphan data and stale .old-* are listed and removed',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        await cliOk(scenario, ['install', CLI, '--yes']);
        // Seed the referenced plugin's data dir (created by opencode at
        // startup in real runs) so prune can verify it is preserved.
        const seed = await scenario.exec([
          'node',
          '-e',
          `require('fs').mkdirSync(${JSON.stringify(DATA_DIR)}, { recursive: true });`,
        ]);
        expect(seed.code).toBe(0);

        // Orphan PLUGIN_DATA dir + a stray swap leftover.
        const orphan = await scenario.exec([
          'node',
          '-e',
          `require('fs').mkdirSync(${JSON.stringify(`${STORE_DIR}/data/orphan-dir`)}, { recursive: true });`,
        ]);
        expect(orphan.code).toBe(0);
        const stale = await scenario.exec([
          'node',
          '-e',
          `require('fs').mkdirSync(${JSON.stringify(`${STORE_DIR}/installed/.old-${SLUG}`)}, { recursive: true });`,
        ]);
        expect(stale.code).toBe(0);

        const doctor = await scenario.cli(['doctor']);
        expect(doctor.code, doctor.output).toBe(2);
        expect(doctor.output).toContain('[orphan-data] orphan-dir');
        expect(doctor.output).toContain(`[stale-old] .old-${SLUG}`);

        const pruned = await cliOk(scenario, ['prune', '--yes']);
        expect(pruned).toContain(`pruned: orphan-dir, .old-${SLUG}`);

        // Referenced entry and its data survived.
        expect(await scenario.exists(INSTALLED)).toBe(true);
        expect(await scenario.exists(`${STORE_DIR}/data/${SLUG}`)).toBe(true);
        expect(await scenario.exists(`${STORE_DIR}/data/orphan-dir`)).toBe(false);
        expect(await scenario.exists(`${STORE_DIR}/installed/.old-${SLUG}`)).toBe(false);
      });
    },
    10 * 60 * 1000,
  );

  it(
    'remove: --dry-run writes nothing, --keep-data keeps PLUGIN_DATA, plain remove deletes it',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        // install --dry-run writes nothing.
        const pristine = await configOf(scenario);
        const dry = await cliOk(scenario, ['install', CLI, '--dry-run', '--yes']);
        expect(dry).toContain('dry-run: nothing was written');
        expect(await configOf(scenario)).toBe(pristine);
        expect(await scenario.exists(META)).toBe(false);

        await cliOk(scenario, ['install', CLI, '--yes']);
        // PLUGIN_DATA is created by the plugin at opencode startup; in these
        // no-opencode scenarios the CLI still preserves whatever a running
        // plugin wrote, so seed a data dir like a live instance would.
        const seed = await scenario.exec([
          'node',
          '-e',
          `require('fs').mkdirSync(${JSON.stringify(DATA_DIR)}, { recursive: true }); ` +
            `require('fs').writeFileSync(${JSON.stringify(`${DATA_DIR}/state.txt`)}, 'keep');`,
        ]);
        expect(seed.code).toBe(0);

        // remove --keep-data: config/store gone, data dir retained.
        const removed = await cliOk(scenario, ['remove', SLUG, '--yes', '--keep-data']);
        expect(removed).toContain('Restart OpenCode to drop its tools and skills');
        expect(await configOf(scenario)).not.toContain(CLI);
        expect(await scenario.exists(INSTALLED)).toBe(false);
        expect(await scenario.exists(META)).toBe(false);
        expect(await scenario.exists(DATA_DIR)).toBe(true);

        // Reinstall, then a plain remove deletes the data dir too.
        await cliOk(scenario, ['install', CLI, '--yes']);
        await cliOk(scenario, ['remove', SLUG, '--yes']);
        expect(await scenario.exists(DATA_DIR)).toBe(false);
      });
    },
    10 * 60 * 1000,
  );
});
