/**
 * Docker e2e tests for the CLI-→-opencode chain against a REAL opencode:
 * the store/config written by the CLI is what a restarted opencode loads.
 *
 * Every scenario boots the `cli` scenario container (the
 * `opencode-agent-plugins` config tuple with an empty `plugins` array — the
 * form the CLI edits). The test runs CLI commands via `docker exec`, then
 * bootstraps opencode (the `/app/ctrl/serve` marker), drives sessions, and
 * `restart()`s the SAME container (filesystem preserved) to prove what the
 * NEXT opencode start sees (docs/explanation/design.md §5.12.4: registrations only change
 * at startup).
 *
 * Covered: install→restart picks up the git-sourced plugin (C1), no live
 * reload while opencode runs (C10), update→restart serves the new version and
 * preserves PLUGIN_DATA (C3, C4), remove→restart drops it (C7), store
 * round-trip / `list` output (C12), and a git source configured but NOT
 * installed starts opencode cleanly (C11, §5.3.3 no network at startup).
 */

import { describe, expect, it } from 'vitest';
import { imageTag } from './helpers/image.js';
import { withScenario } from './helpers/scenario-run.js';
import type { Scenario } from './helpers/scenario.js';
import { mainRequestOf, toolsOf } from './helpers/capture.js';
import {
  GIT_FIXTURE_SLUG,
  GIT_FIXTURE_SOURCE,
  OPENCODE_VERSION,
  STORE_DIR,
  TOOL_ECHO,
} from './helpers/constants.js';

const CLI = GIT_FIXTURE_SOURCE;
const SLUG = GIT_FIXTURE_SLUG;

/** Asserts the main request tool list of a session run. */
const toolsOfRun = (result: Awaited<ReturnType<Scenario['session']>>) =>
  toolsOf(mainRequestOf(result.captures).request);

/** Runs the CLI inside the scenario and asserts success. */
async function cliOk(scenario: Scenario, args: string[]): Promise<string> {
  const result = await scenario.cli(args);
  expect(result.code, `cli ${args.join(' ')} failed:\n${result.output}`).toBe(0);
  return result.output;
}

/** Pushes a fixture version via the container's git fixture. */
async function pushVersion(scenario: Scenario, version: string): Promise<void> {
  const result = await scenario.exec(['node', '/app/git-fixture.mjs', 'push-version', version]);
  expect(result.code, result.output).toBe(0);
}

describe(`e2e cli session: real opencode ${OPENCODE_VERSION} in Docker`, () => {
  it(
    'install while opencode runs: no live reload, restart picks the plugin up',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        // opencode starts with NO sources registered.
        await scenario.markServe();
        const first = await scenario.session();
        expect(toolsOfRun(first).has(TOOL_ECHO)).toBe(false);

        // Install while opencode is running: the config/store change.
        const out = await cliOk(scenario, ['install', CLI, '--yes']);
        expect(out).toContain('Restart OpenCode to use it');

        // §5.12.4: no supported live re-registration — a NEW session on the
        // still-running opencode does not gain the plugin.
        const second = await scenario.session();
        expect(toolsOfRun(second).has(TOOL_ECHO), 'no live reload').toBe(false);

        // The store round-trip: the original source string is what was
        // registered and what `list` reports (never a store-internal path).
        const config = await scenario.readFile('/app/workspace/opencode.json');
        expect(config).toContain(CLI);
        const listed = await scenario.cli(['list']);
        expect(listed.output).toContain('gitplug');
        expect(listed.output).toContain('file:///app/git-fixtures/remote.git');
        // §5.11: the status column classifies the ref like `check` — the
        // just-installed (up to date) HEAD-sourced plugin reads "current".
        expect(listed.output).toContain('  current');

        // Restart the SAME container: the next start loads the installed
        // plugin from the store and the tool reaches the session.
        await scenario.restart();
        const third = await scenario.session();
        const tools = toolsOfRun(third);
        expect(tools.has(TOOL_ECHO), 'restarted opencode must serve the plugin').toBe(true);
        expect(tools.get(TOOL_ECHO)).toContain('GIT_VERSION=1.0.0');
      });
    },
    10 * 60 * 1000,
  );

  it(
    'update lifecycle: restart serves the new version, PLUGIN_DATA survives',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        await cliOk(scenario, ['install', CLI, '--yes']);

        // Simulate plugin-owned data before the first boot.
        const seed = await scenario.exec([
          'node',
          '-e',
          `require('fs').mkdirSync(${JSON.stringify(`${STORE_DIR}/data/${SLUG}`)}, { recursive: true }); ` +
            `require('fs').writeFileSync(${JSON.stringify(`${STORE_DIR}/data/${SLUG}/keep.txt`)}, 'keep me');`,
        ]);
        expect(seed.code).toBe(0);

        await scenario.markServe();
        const first = await scenario.session();
        const firstTools = toolsOfRun(first);
        expect(firstTools.has(TOOL_ECHO)).toBe(true);
        // The tool description carries the installed version marker.
        expect(firstTools.get(TOOL_ECHO)).toContain('GIT_VERSION=1.0.0');

        // Drift + update while opencode runs (update touches only the store).
        await pushVersion(scenario, '1.1.0');
        const drifting = await scenario.cli(['list']);
        expect(drifting.output).toContain('update available');
        await cliOk(scenario, ['update', '--yes']);

        await scenario.restart();
        const second = await scenario.session();
        const secondTools = toolsOfRun(second);
        expect(secondTools.has(TOOL_ECHO)).toBe(true);
        expect(secondTools.get(TOOL_ECHO)).toContain('GIT_VERSION=1.1.0');

        // The swap left no rollback dir; PLUGIN_DATA content survived.
        expect(await scenario.exists(`${STORE_DIR}/installed/.old-${SLUG}`)).toBe(false);
        expect(await scenario.readFile(`${STORE_DIR}/data/${SLUG}/keep.txt`)).toBe('keep me');
      });
    },
    10 * 60 * 1000,
  );

  it(
    'remove: config/store/data cleaned, restarted opencode drops the plugin',
    async () => {
      await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
        await cliOk(scenario, ['install', CLI, '--yes']);
        await scenario.markServe();
        const first = await scenario.session();
        expect(toolsOfRun(first).has(TOOL_ECHO)).toBe(true);

        const removed = await cliOk(scenario, ['remove', SLUG, '--yes']);
        expect(removed).toContain('Restart OpenCode to drop its tools and skills');
        expect(await scenario.exists(`${STORE_DIR}/installed/${SLUG}`)).toBe(false);
        expect(await scenario.exists(`${STORE_DIR}/data/${SLUG}`)).toBe(false);

        await scenario.restart();
        const second = await scenario.session();
        expect(toolsOfRun(second).has(TOOL_ECHO), 'removed plugin must be gone').toBe(false);
        expect(second.prompt.info.role).toBe('assistant');
      });
    },
    10 * 60 * 1000,
  );

  it(
    'git source configured but NOT installed: opencode starts and skips it',
    async () => {
      // cli-missing mode writes the source into the config but never
      // installs it — startup resolution must warn + skip, never fetch
      // (§5.3.3) and never break the session.
      await withScenario(await imageTag(), 'cli-missing', {}, async (scenario) => {
        const result = await scenario.session();
        expect(toolsOfRun(result).has(TOOL_ECHO)).toBe(false);
        expect(result.prompt.info.role).toBe('assistant');
      });
    },
    10 * 60 * 1000,
  );
});
