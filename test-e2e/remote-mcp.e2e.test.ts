/**
 * Docker e2e tests for remote (streamable-http) MCP registration and for the
 * behaviors the design delegates to opencode's MCP client and pins here
 * (`docs/design.md` §7 "Delegated-to-host requirements"): header forwarding,
 * client-generated header precedence, redirect header forwarding, and
 * bare-command PATH search. The design states these are asserted in E2E, not
 * unit tests (§5.7, §7); this suite is the tripwire.
 *
 * Fixture: `test-e2e/fixtures/remote-plugin` (a streamable-http server on
 * 127.0.0.1:3999 started by bootstrap.mjs in `remote` mode) exposes:
 *
 * - `http`     → direct endpoint `/mcp`, configured headers x-e2e-token and
 *   user-agent (precedence probe);
 * - `redirect` → `/redirect` answers 307 to `/mcp-final` (spec §7.2.1);
 * - `pathtool` → stdio server via a BARE command name resolved on PATH;
 * - `sse`      → unsupported transport, skipped by the loader;
 * - `badurl`   → non-loopback http URL, invalid per §5.7, skipped.
 *
 * The remote server prints every request as a `REMOTE:` line and embeds the
 * current request's path/headers into each tool result, so assertions run on
 * the same capture pipeline as the rest of the suite.
 */

import { describe, expect, it } from 'vitest';
import { imageTag } from './helpers/image.js';
import { withScenario } from './helpers/scenario-run.js';
import { mainRequestOf, toolResultTextOf, toolRoundTripOf, toolsOf } from './helpers/capture.js';
import {
  FIXTURES_DIR,
  OPENCODE_VERSION,
  REMOTE_MCP_PORT,
  TOOL_PATH,
  TOOL_REDIRECT,
  TOOL_REMOTE,
} from './helpers/constants.js';

describe(`e2e remote: real opencode ${OPENCODE_VERSION} in Docker`, () => {
  it(
    'streamable-http server: registered, called, headers forwarded, invalid entries skipped',
    async () => {
      await withScenario(
        await imageTag(),
        'remote',
        { emitToolCall: TOOL_REMOTE },
        async (scenario) => {
          const result = await scenario.session();

          // The remote server was registered and actually called.
          const roundTrip = toolRoundTripOf(result.captures);
          expect(roundTrip.call, 'opencode must call http_ping').toBe(true);
          expect(roundTrip.result, 'the remote tool result must reach the model').toBe(true);
          const resultText = toolResultTextOf(result.captures);
          expect(resultText).toContain('pong hello from e2e');
          expect(resultText).toContain('R_ENDPOINT=mcp');
          expect(resultText).toContain('R_PATH=/mcp');

          // Plugin-configured headers are forwarded by opencode's HTTP stack.
          expect(resultText).toContain('R_TOKEN=e2e-token');

          // Client-generated header precedence (§7): the configured
          // user-agent is what the opencode HTTP stack sent — pinned here
          // because the rule is owned by the client, not reimplemented by us.
          expect(resultText).toContain('R_UA=plugin-ua');

          // The main request lists the remote tool and the PATH-resolved
          // stdio server; the sse / badurl entries produced nothing.
          const tools = toolsOf(mainRequestOf(result.captures).request);
          expect(tools.has(TOOL_REMOTE), 'http_ping must be registered').toBe(true);
          expect(tools.has(TOOL_PATH), 'pathtool_ping (bare command) must be registered').toBe(
            true,
          );
          for (const name of tools.keys()) {
            expect(name.startsWith('sse_'), `sse entry must be skipped (found ${name})`).toBe(
              false,
            );
            expect(name.startsWith('badurl_'), `badurl entry must be skipped (found ${name})`).toBe(
              false,
            );
          }
          expect(result.prompt.info.role).toBe('assistant');
        },
      );
    },
    10 * 60 * 1000,
  );

  it(
    'bare-command stdio server: resolved through PATH and callable',
    async () => {
      await withScenario(
        await imageTag(),
        'remote',
        { emitToolCall: TOOL_PATH },
        async (scenario) => {
          const result = await scenario.session();

          const roundTrip = toolRoundTripOf(result.captures);
          expect(roundTrip.call, 'opencode must call pathtool_ping').toBe(true);
          expect(roundTrip.result, 'the PATH-resolved tool result must reach the model').toBe(true);
          const resultText = toolResultTextOf(result.captures);
          expect(resultText).toContain('pong hello from e2e');
          expect(resultText).toContain('PATH_TOOL=ok');
          expect(resultText).toContain(`PLUGIN_ROOT=${FIXTURES_DIR}/remote-plugin`);
          // cwd defaults to the plugin root (spec default honored).
          expect(resultText).toContain(`CWD=${FIXTURES_DIR}/remote-plugin`);
          expect(result.prompt.info.role).toBe('assistant');
        },
      );
    },
    10 * 60 * 1000,
  );

  it(
    'redirect: 307 followed, configured headers forwarded to the target',
    async () => {
      await withScenario(
        await imageTag(),
        'remote',
        { emitToolCall: TOOL_REDIRECT },
        async (scenario) => {
          const result = await scenario.session();

          const roundTrip = toolRoundTripOf(result.captures);
          expect(roundTrip.call, 'opencode must call redirect_ping').toBe(true);
          expect(roundTrip.result, 'the redirected tool result must reach the model').toBe(true);
          const resultText = toolResultTextOf(result.captures);
          expect(resultText).toContain('pong hello from e2e');
          // The MCP session was served by the redirect target.
          expect(resultText).toContain('R_ENDPOINT=final');
          expect(resultText).toContain('R_PATH=/mcp-final');
          // The configured header survived the redirect hop.
          expect(resultText).toContain('R_TOKEN=red-token');

          // The server-side log shows the 307 hop and the follow-up request
          // arriving at the target (spec §7.2.1 header forwarding).
          const remoteLines = result.output
            .split('\n')
            .filter((line) => line.startsWith('REMOTE:'));
          expect(
            remoteLines.some((line) => line.includes('"path":"/redirect"')),
            'the redirect endpoint must be requested first',
          ).toBe(true);
          expect(
            remoteLines.some((line) => line.includes('"path":"/mcp-final"')),
            'a request must arrive at the redirect target',
          ).toBe(true);
          expect(result.prompt.info.role).toBe('assistant');
        },
      );
    },
    10 * 60 * 1000,
  );

  it(
    'invalid and unsupported entries do not break the session (negative sanity)',
    async () => {
      await withScenario(await imageTag(), 'remote', {}, async (scenario) => {
        // No tool call is emitted: the assertion is that the session still
        // completes and never lists the invalid entries.
        const result = await scenario.session();
        const tools = toolsOf(mainRequestOf(result.captures).request);
        expect(tools.has(TOOL_REMOTE), 'the valid remote server still loads').toBe(true);
        for (const name of tools.keys()) {
          expect(name.startsWith('sse_'), `sse entry must be skipped (found ${name})`).toBe(false);
          expect(name.startsWith('badurl_'), `badurl entry must be skipped (found ${name})`).toBe(
            false,
          );
        }
        expect(result.prompt.info.role).toBe('assistant');
      });
    },
    10 * 60 * 1000,
  );
});
