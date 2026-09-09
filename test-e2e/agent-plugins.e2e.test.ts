/**
 * Docker e2e tests for the agent-plugins client (`docs/design.md` §9.1,
 * §9.2.4): the core config-hook registration contract.
 *
 * Everything opencode-related runs inside a container built from
 * `test-e2e/Dockerfile` (built once per run by `test-e2e/global-setup.ts`).
 * This suite drives opencode's server API from the host:
 *
 * - hook mode: the plugin imports the fixture and its config hook registers
 *   the skill + MCP server; the fake model emits a tool call to
 *   `echo_echo_ping`, so opencode executes it and the result carries
 *   PLUGIN_ROOT/PLUGIN_DATA/CWD/DATA_EXISTS plus the EXPANDED placeholders
 *   (§5.5, §5.8);
 * - static mode: the exact values the hook would produce written by hand —
 *   the baseline proving behavioral equivalence (§9.1.1).
 *
 * The suite also pins per-release host behavior: the skills scan depth
 * implies the stray nested SKILL.md shows up in `<available_skills>` for the
 * pinned release (fixture comment + §5.6/§2.2), and the fixture's
 * `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` args/env literals pin placeholder
 * expansion (opencode passes env values verbatim — finding §9.1.5).
 */

import { describe, expect, it } from 'vitest';
import { imageTag } from './helpers/image.js';
import { withScenario } from './helpers/scenario-run.js';
import {
  mainRequestOf,
  systemText,
  toolResultTextOf,
  toolRoundTripOf,
  toolsOf,
} from './helpers/capture.js';
import {
  DATA_DIR_PREFIX,
  OPENCODE_VERSION,
  PLUGIN_ROOT,
  STATIC_DATA_DIR,
  TOOL_ECHO,
} from './helpers/constants.js';

describe(`e2e: real opencode ${OPENCODE_VERSION} in Docker (testcontainers)`, () => {
  it(
    'hook mode: registered components reach the live session',
    async () => {
      await withScenario(
        await imageTag(),
        'hook',
        { emitToolCall: TOOL_ECHO },
        async (scenario) => {
          const result = await scenario.session();

          // The fake model emits a tool call to the plugin's MCP server,
          // opencode executes it, and the executed result is sent back to the
          // model — proving the server was registered, spawned with the right
          // env and cwd, and is callable (not merely listed).
          const roundTrip = toolRoundTripOf(result.captures);
          expect(roundTrip.call, 'opencode must call echo_echo_ping').toBe(true);
          expect(roundTrip.result, 'the MCP tool result must reach the model').toBe(true);
          const resultText = toolResultTextOf(result.captures);

          // The executed server reported its subprocess contract (§5.7–§5.8).
          expect(resultText).toContain('pong hello from e2e');
          expect(resultText).toContain(`PLUGIN_ROOT=${PLUGIN_ROOT}`);
          expect(resultText).toContain(`PLUGIN_DATA=${DATA_DIR_PREFIX}`);
          expect(resultText).toContain(`CWD=${PLUGIN_ROOT}`);
          expect(resultText).toContain('DATA_EXISTS=true');

          // Placeholder expansion (§5.5): the mcp.json env/args literals were
          // expanded by the loader BEFORE registration (opencode passes env
          // values verbatim, finding §9.1.5).
          expect(resultText).toContain(`E2E_ROOT=${PLUGIN_ROOT}`);
          expect(resultText).toContain(`E2E_DATA=${DATA_DIR_PREFIX}`);
          expect(resultText).toContain('ARGS_OK=true');

          // The definition request listed the tool and advertised the skills.
          const main = mainRequestOf(result.captures);
          const tools = toolsOf(main.request);
          const echo = tools.get(TOOL_ECHO);
          expect(echo, 'MCP tool echo_echo_ping must be registered').toBeDefined();
          expect(echo!).toContain(`PLUGIN_ROOT=${PLUGIN_ROOT}`);
          expect(echo!).toContain(`PLUGIN_DATA=${DATA_DIR_PREFIX}`);
          expect(echo!).toContain(`CWD=${PLUGIN_ROOT}`);

          const system = systemText(main.request);
          expect(system).toContain('<available_skills>');
          expect(system).toContain('<name>hello</name>');
          // Scan-depth pin (opencode 1.18.30): the skills scan is recursive, so
          // the stray nested SKILL.md IS exposed — see the fixture comment and
          // §2.2.
          expect(system).toContain('<name>nested</name>');

          // The session round-tripped to completion.
          expect(result.prompt.info.role).toBe('assistant');
        },
      );
    },
    10 * 60 * 1000,
  );

  it(
    'static mode: handwritten config is behaviorally equivalent',
    async () => {
      await withScenario(
        await imageTag(),
        'static',
        { emitToolCall: TOOL_ECHO },
        async (scenario) => {
          const result = await scenario.session();

          const roundTrip = toolRoundTripOf(result.captures);
          expect(roundTrip.call, 'opencode must call echo_echo_ping').toBe(true);
          expect(roundTrip.result, 'the MCP tool result must reach the model').toBe(true);
          const resultText = toolResultTextOf(result.captures);
          expect(resultText).toContain(`PLUGIN_ROOT=${PLUGIN_ROOT}`);
          expect(resultText).toContain(`PLUGIN_DATA=${STATIC_DATA_DIR}`);
          expect(resultText).toContain(`CWD=${PLUGIN_ROOT}`);
          // The static baseline writes the expanded values by hand — the
          // same values the hook produced in hook mode.
          expect(resultText).toContain(`E2E_ROOT=${PLUGIN_ROOT}`);
          expect(resultText).toContain(`E2E_DATA=${STATIC_DATA_DIR}`);
          expect(resultText).toContain('ARGS_OK=true');

          const main = mainRequestOf(result.captures);
          const tools = toolsOf(main.request);
          const echo = tools.get(TOOL_ECHO);
          expect(echo, 'MCP tool echo_echo_ping must be registered').toBeDefined();
          expect(echo!).toContain(`PLUGIN_ROOT=${PLUGIN_ROOT}`);
          expect(echo!).toContain(`PLUGIN_DATA=${STATIC_DATA_DIR}`);
          expect(echo!).toContain(`CWD=${PLUGIN_ROOT}`);

          const system = systemText(main.request);
          expect(system).toContain('<available_skills>');
          expect(system).toContain('<name>hello</name>');
          // Same host scan behavior as the hook mode above, for the same
          // release.
          expect(system).toContain('<name>nested</name>');

          expect(result.prompt.info.role).toBe('assistant');
        },
      );
    },
    10 * 60 * 1000,
  );
});
