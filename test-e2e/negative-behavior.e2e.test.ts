/**
 * Docker e2e tests for the §6 failure taxonomy's most user-visible rows,
 * anchored against a REAL opencode session (the unit layer covers the full
 * taxonomy against a fake V2 context; this suite pins that a dropped
 * component never breaks the session):
 *
 * - invalid manifest → that plugin is rejected, the other plugin still loads;
 * - mcp.json $schema version mismatch → MCP disabled, skills still load
 *   (§5.9);
 * - user-authored `mcp.servers.echo` entry → user config wins, our server is
 *   skipped (§3.2, §5.7);
 * - user-authored `skills` entry → the host's skill registry keeps the user's
 *   `hello` skill over the plugin's registration (§3.2, §5.6, §9.1.5).
 *
 * V2 wraps MCP tools in Code Mode by default, so callability is probed with
 * an `execute` call to `tools.echo.echo_ping`.
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
import { CODE_ECHO, OPENCODE_VERSION } from './helpers/constants.js';

describe(`e2e negative: real opencode ${OPENCODE_VERSION} in Docker`, () => {
  it(
    'invalid manifest plugin is rejected; the valid plugin still loads',
    async () => {
      await withScenario(
        await imageTag(),
        'negative-invalid',
        { emitToolCall: 'execute', emitToolCode: CODE_ECHO },
        async (scenario) => {
          const result = await scenario.session();
          const roundTrip = toolRoundTripOf(result.captures);
          expect(roundTrip.call, 'the valid plugin must still be callable').toBe(true);
          expect(roundTrip.result).toBe(true);
          expect(toolResultTextOf(result.captures)).toContain('pong hello from e2e');
          expect(assistantReplied(result.messages)).toBe(true);
        },
      );
    },
    10 * 60 * 1000,
  );

  it(
    'mcp.json version mismatch: MCP disabled, skills still load',
    async () => {
      await withScenario(await imageTag(), 'negative-mismatch', {}, async (scenario) => {
        const result = await scenario.session();
        const main = mainRequestOf(result.captures);
        // The plugin's MCP server never reached the host registry (§5.9).
        expect((await scenario.mcpList()).data).toEqual([]);
        // But the skill did reach the session (§5.9 "skills still load").
        expect(systemText(main.request)).toContain('<name>editme</name>');
        expect(assistantReplied(result.messages)).toBe(true);
      });
    },
    10 * 60 * 1000,
  );

  it(
    'user-authored mcp entry wins: the colliding server is skipped',
    async () => {
      await withScenario(
        await imageTag(),
        'negative-stub',
        { emitToolCall: 'execute', emitToolCode: CODE_ECHO },
        async (scenario) => {
          const result = await scenario.session();
          const main = mainRequestOf(result.captures);
          // The stub `echo` server (disabled) is the user's config — our
          // `echo` server collided and was skipped (reported at replay), so
          // the Code Mode call cannot reach a plugin-provided tool.
          expect(toolResultTextOf(result.captures)).not.toContain('pong hello from e2e');
          const servers = (await scenario.mcpList()).data;
          expect(servers.map((server) => `${server.name}:${server.status.status}`)).toEqual([
            'echo:disabled',
          ]);
          expect(scenario.output()).toContain('user config wins');
          // The plugin itself still loaded its skills.
          expect(systemText(main.request)).toContain('<name>hello</name>');
          expect(assistantReplied(result.messages)).toBe(true);
        },
      );
    },
    10 * 60 * 1000,
  );

  it(
    "user-authored skills entry wins: the host keeps the config skill over the plugin's registration",
    async () => {
      await withScenario(await imageTag(), 'skill-collision', {}, async (scenario) => {
        const result = await scenario.session();
        const main = mainRequestOf(result.captures);
        const system = systemText(main.request);
        // The user's `hello` skill is still advertised — their `skills`
        // entry is left untouched (§3.2) ...
        expect(system).toContain('<name>hello</name>');
        expect(system).toContain('A user-authored hello skill shadowing');
        // ... and V2 enforces config precedence in its skill registry: a
        // plugin transform cannot override a config skill, so the plugin's
        // own `hello` description never reaches the model (the client cannot
        // see config skills from a transform, so the host owns this rule).
        expect(system).not.toContain('Greets the world in the e2e test');
        expect(assistantReplied(result.messages)).toBe(true);
      });
    },
    10 * 60 * 1000,
  );
});
