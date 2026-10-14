/**
 * Docker e2e tests for the agent-plugins client (`docs/explanation/design.md` §9.1,
 * §9.2.4): the core V2 setup/transform registration contract.
 *
 * Everything opencode-related runs inside a container built from
 * `test-e2e/Dockerfile` (built once per run by `test-e2e/global-setup.ts`).
 * This suite drives opencode's server API from the host:
 *
 * - hook mode: the plugin imports the fixture and its V2 `setup` registers
 *   the skill + MCP server through the context transforms; V2 wraps MCP tools
 *   in Code Mode by default, so the fake model emits an `execute` call whose
 *   code invokes `tools.echo.echo_ping` — opencode executes it and the result
 *   carries PLUGIN_ROOT/PLUGIN_DATA/CWD/DATA_EXISTS plus the EXPANDED
 *   placeholders (§5.5, §5.8);
 * - static mode: the equivalent native V2 config written by hand — the
 *   baseline proving behavioral equivalence (§9.1, "what was proven").
 *
 * The suite also pins per-release host behavior: V2 registers skills
 * individually (id + content), so the fixture's stray nested SKILL.md is
 * never exposed in hook mode — a config `skills` directory, by contrast, is
 * scanned recursively and does expose it (static mode). The fixture's
 * `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` args/env literals pin placeholder
 * expansion (opencode passes env values verbatim — §9.1.8).
 */

import { describe, expect, it } from 'vitest';
import { imageTag } from './helpers/image.js';
import { withScenario } from './helpers/scenario-run.js';
import {
  assistantReplied,
  mainRequestOf,
  systemText,
  toolResultTextOf,
  toolRoundTripOf,
} from './helpers/capture.js';
import {
  CODE_ECHO,
  DATA_DIR_PREFIX,
  OPENCODE_VERSION,
  PLUGIN_ROOT,
  STATIC_DATA_DIR,
} from './helpers/constants.js';

describe(`e2e: real opencode ${OPENCODE_VERSION} in Docker (testcontainers)`, () => {
  it(
    'hook mode: registered components reach the live session',
    async () => {
      await withScenario(
        await imageTag(),
        'hook',
        { emitToolCall: 'execute', emitToolCode: CODE_ECHO },
        async (scenario) => {
          const result = await scenario.session();

          // The server registered through the plugin's transform connected.
          const servers = (await scenario.mcpList()).data;
          expect(servers.map((server) => `${server.name}:${server.status.status}`)).toEqual([
            'echo:connected',
          ]);

          // The fake model's Code Mode call ran the plugin's MCP server, and
          // the executed result was sent back to the model — proving the
          // server was registered, spawned with the right env and cwd, and is
          // callable (not merely listed).
          const roundTrip = toolRoundTripOf(result.captures);
          expect(roundTrip.call, 'opencode must call the execute tool').toBe(true);
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
          // values verbatim, §9.1.8).
          expect(resultText).toContain(`E2E_ROOT=${PLUGIN_ROOT}`);
          expect(resultText).toContain(`E2E_DATA=${DATA_DIR_PREFIX}`);
          expect(resultText).toContain('ARGS_OK=true');

          // The skill reached the model-visible system prompt.
          const system = systemText(mainRequestOf(result.captures).request);
          expect(system).toContain('<available_skills>');
          expect(system).toContain('<name>hello</name>');
          // V2 registration is per-skill (validated immediate children only),
          // so the stray nested SKILL.md is NOT exposed — see the fixture
          // comment and §5.6.
          expect(system).not.toContain('<name>nested</name>');

          // The session round-tripped to completion.
          expect(assistantReplied(result.messages)).toBe(true);
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
        { emitToolCall: 'execute', emitToolCode: CODE_ECHO },
        async (scenario) => {
          const result = await scenario.session();

          const servers = (await scenario.mcpList()).data;
          expect(servers.map((server) => `${server.name}:${server.status.status}`)).toEqual([
            'echo:connected',
          ]);

          const roundTrip = toolRoundTripOf(result.captures);
          expect(roundTrip.call, 'opencode must call the execute tool').toBe(true);
          expect(roundTrip.result, 'the MCP tool result must reach the model').toBe(true);
          const resultText = toolResultTextOf(result.captures);
          expect(resultText).toContain(`PLUGIN_ROOT=${PLUGIN_ROOT}`);
          expect(resultText).toContain(`PLUGIN_DATA=${STATIC_DATA_DIR}`);
          expect(resultText).toContain(`CWD=${PLUGIN_ROOT}`);
          // The static baseline writes the expanded values by hand — the
          // same values the plugin registered in hook mode.
          expect(resultText).toContain(`E2E_ROOT=${PLUGIN_ROOT}`);
          expect(resultText).toContain(`E2E_DATA=${STATIC_DATA_DIR}`);
          expect(resultText).toContain('ARGS_OK=true');

          const system = systemText(mainRequestOf(result.captures).request);
          expect(system).toContain('<available_skills>');
          expect(system).toContain('<name>hello</name>');
          // Host behavior pin: a config `skills` *directory* is scanned
          // recursively in V2, so the stray nested SKILL.md IS exposed here —
          // unlike hook mode, where the plugin registers skills individually
          // and never exposes it. That is the one deliberate difference
          // between the two modes (§5.6).
          expect(system).toContain('<name>nested</name>');

          expect(assistantReplied(result.messages)).toBe(true);
        },
      );
    },
    10 * 60 * 1000,
  );
});
