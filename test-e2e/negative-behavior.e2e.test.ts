/**
 * Docker e2e tests for the §6 failure taxonomy's most user-visible rows,
 * anchored against a REAL opencode session (the unit layer covers the full
 * taxonomy against a fake Config; this suite pins that a dropped component
 * never breaks the session):
 *
 * - invalid manifest → that plugin is rejected, the other plugin still loads;
 * - mcp.json $schema version mismatch → MCP disabled, skills still load
 *   (§5.9);
 * - user-authored `mcp.echo` entry → user config wins, our server is skipped
 *   (§3.2, §5.7).
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
import { OPENCODE_VERSION, TOOL_ECHO } from './helpers/constants.js';

describe(`e2e negative: real opencode ${OPENCODE_VERSION} in Docker`, () => {
  it(
    'invalid manifest plugin is rejected; the valid plugin still loads',
    async () => {
      await withScenario(
        await imageTag(),
        'negative-invalid',
        { emitToolCall: TOOL_ECHO },
        async (scenario) => {
          const result = await scenario.session();
          const roundTrip = toolRoundTripOf(result.captures);
          expect(roundTrip.call, 'the valid plugin must still be callable').toBe(true);
          expect(roundTrip.result).toBe(true);
          expect(toolResultTextOf(result.captures)).toContain('pong hello from e2e');
          expect(result.prompt.info.role).toBe('assistant');
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
        // The plugin's MCP server never reached opencode's config (§5.9).
        expect(toolsOf(main.request).has(TOOL_ECHO)).toBe(false);
        // But the skill did reach the session (§5.9 "skills still load").
        expect(systemText(main.request)).toContain('<name>editme</name>');
        expect(result.prompt.info.role).toBe('assistant');
      });
    },
    10 * 60 * 1000,
  );

  it(
    'user-authored mcp entry wins: the colliding server is skipped',
    async () => {
      await withScenario(await imageTag(), 'negative-stub', {}, async (scenario) => {
        const result = await scenario.session();
        const main = mainRequestOf(result.captures);
        // The stub `mcp.echo` (enabled:false) is the user's config — our
        // `echo` server collided and was skipped; nothing of it is served.
        expect(toolsOf(main.request).has(TOOL_ECHO), 'user config must win').toBe(false);
        // The plugin itself still loaded its skills.
        expect(systemText(main.request)).toContain('<name>hello</name>');
        expect(result.prompt.info.role).toBe('assistant');
      });
    },
    10 * 60 * 1000,
  );
});
