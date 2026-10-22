/**
 * Opt-in Docker e2e scenario: real Agent Plugins from the wild.
 *
 * Ten plugins (the agentpluginsdirectory.com top-10 by repository stars,
 * 2026-09-11 inventory) are each installed into a FRESH container and driven
 * through a real opencode with the shared fake OpenAI-compatible provider.
 * For every plugin the suite records:
 *
 * - the CLI install preview (skills/MCP servers, taxonomy warnings);
 * - a structured scan of the installed store tree (`scan-plugin.mjs`) that
 *   runs the client's own validation pipeline and reports anything the client
 *   does not consume (nested SKILL.md, unknown manifest keys, extension
 *   namespaces, unsupported entry types, other component directories);
 * - the host-side registration (`config.get`), connection status
 *   (`mcp.list`), and skill discovery (`skill.list`);
 * - what actually reaches the provider (tool list + `<available_skills>` in
 *   the captured chat-completions request).
 *
 * External network and third-party servers make this suite non-hermetic, so
 * it is skipped unless `E2E_TOP_PLUGINS=1` is set (CI's `pnpm test:e2e` does
 * not run it). Run:
 *
 *     E2E_TOP_PLUGINS=1 pnpm test:e2e test-e2e/top-plugins.e2e.test.ts
 *
 * Evidence is rewritten to the JSON path printed at the end after every
 * plugin, so partial results survive a failing scenario.
 */

import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpListOutput, SkillListOutput } from '@opencode/client';
import { afterAll, describe, expect, it } from 'vitest';
import {
  mainRequestOf,
  systemText,
  toolsOf,
  type ChatCompletionRequest,
} from './helpers/capture.js';
import { STORE_DIR } from './helpers/constants.js';
import { imageTag } from './helpers/image.js';
import { withScenario } from './helpers/scenario-run.js';
import type { Scenario } from './helpers/scenario.js';
import { TOP_PLUGINS, type PluginReport, type ScanResult } from './top-plugins.data.js';

/** Gate: the suite talks to GitHub and third-party services on every run. */
const RUN = process.env['E2E_TOP_PLUGINS'] === '1';

/** Where the evidence JSON is rewritten after every plugin. */
const REPORT_FILE = join(tmpdir(), 'opencode-agent-plugins-top-plugins-report.json');

/** Collected evidence, one entry per plugin. */
const REPORTS: PluginReport[] = [];

/** Rewrites the evidence file (partial evidence survives a hard failure). */
async function writeReport(): Promise<void> {
  await writeFile(REPORT_FILE, `${JSON.stringify(REPORTS, null, 2)}\n`);
}

/**
 * Skill names advertised in a captured request: the `<available_skills>`
 * block of the system prompt, or the `skill` tool description on releases
 * that carry it there (docs/explanation/registration.md).
 *
 * @param request - A captured chat-completions request.
 * @returns The advertised skill names.
 */
function skillNamesOf(request: ChatCompletionRequest): Set<string> {
  const sources = [systemText(request)];
  const skillToolDescription = toolsOf(request).get('skill');
  if (skillToolDescription !== undefined) {
    sources.push(skillToolDescription);
  }
  const names = new Set<string>();
  for (const source of sources) {
    const block = /<available_skills>([\s\S]*?)<\/available_skills>/.exec(source)?.[1] ?? '';
    for (const match of block.matchAll(/<name>([^<]+)<\/name>/g)) {
      names.add(match[1]);
    }
  }
  return names;
}

/**
 * MCP server names from a V2 `mcp.list` response (the plugin registry; V2
 * transform registrations do not appear in the effective config).
 *
 * @param response - The MCP list response.
 * @returns The registered server names.
 */
function mcpNamesOf(response: McpListOutput): string[] {
  return response.data.map((server) => server.name);
}

/**
 * Skill names from a V2 `skill.list` response.
 *
 * @param response - The skills list response.
 * @returns The skill names.
 */
function skillNamesFromEndpoint(response: SkillListOutput): string[] {
  return response.data.map((entry) => String(entry.name));
}

/**
 * Status strings from a V2 `mcp.list` response.
 *
 * @param response - The MCP list response.
 * @returns Map of server name → status string.
 */
function mcpStatusesOf(response: McpListOutput): Record<string, string> {
  const statuses: Record<string, string> = {};
  for (const server of response.data) {
    statuses[server.name] = server.status.status;
  }
  return statuses;
}

/** opencode log lines that mention this plugin's registrations. */
function registrationLogsOf(output: string): string[] {
  return output
    .split('\n')
    .filter(
      (line) =>
        line.includes('opencode-agent-plugins') ||
        line.includes('agent plugins') ||
        line.includes('plugin "'),
    )
    .slice(-200);
}

/** The single installed store tree of a clean-container scenario. */
async function installedRoot(scenario: Scenario): Promise<string> {
  const result = await scenario.exec([
    'node',
    '-e',
    'const fs = require("fs");' +
      `const dir = ${JSON.stringify(join(STORE_DIR, 'installed'))};` +
      'const entries = fs.readdirSync(dir).filter((name) => !name.startsWith("."));' +
      'if (entries.length !== 1) {' +
      ' console.error("expected one installed plugin, got: " + entries.join(", ")); process.exit(1);' +
      '}' +
      'process.stdout.write(dir + "/" + entries[0]);',
  ]);
  expect(result.code, result.output).toBe(0);
  return result.stdout.trim();
}

describe.runIf(RUN)('e2e top plugins: real Agent Plugins from the wild', () => {
  for (const plugin of TOP_PLUGINS) {
    it(
      `${plugin.id}: install → register → provider`,
      async () => {
        const report: PluginReport = { id: plugin.id, source: plugin.source };
        try {
          await withScenario(await imageTag(), 'cli', {}, async (scenario) => {
            const install = await scenario.cli(['install', plugin.source, '--yes']);
            report.install = { exit: install.code, output: install.output };
            expect(install.code, install.output).toBe(0);

            const root = await installedRoot(scenario);
            report.storeRoot = root;
            const scanned = await scenario.exec(['node', '/app/scan-plugin.mjs', root]);
            expect(scanned.code, scanned.output).toBe(0);
            const scan = JSON.parse(scanned.stdout) as ScanResult;
            report.scan = scan;
            expect.soft(scan.manifest.name, 'installed manifest name').toBe(plugin.manifestName);
            expect.soft(scan.fatal, 'validation must not be fatal').toBe(false);
            expect
              .soft(scan.skills.length, 'validated skill count')
              .toBe(plugin.expectedSkillCount);

            await scenario.markServe();
            const run = await scenario.session(
              'ping',
              plugin.expectedMcp.map((name) => ({ name })),
            );
            const main = mainRequestOf(run.captures);
            const tools = toolsOf(main.request);
            const providerSkills = skillNamesOf(main.request);
            const providerTools = [...tools.keys()].sort();
            report.providerTools = providerTools;
            report.providerSkills = [...providerSkills].sort();

            // Host-side state: registered config, MCP status, discovered skills.
            report.config = await scenario.config();
            const mcpList = await scenario.mcpList();
            report.mcpEndpoint = mcpList;
            report.skillEndpoint = skillNamesFromEndpoint(await scenario.skillList());
            report.registrationLogs = registrationLogsOf(scenario.output());

            const configMcp = mcpNamesOf(mcpList);
            const statuses = mcpStatusesOf(mcpList);
            report.mcpDiscovery = {};
            for (const server of plugin.expectedMcp) {
              report.mcpDiscovery[server] = {
                registered: configMcp.includes(server),
                status: statuses[server] ?? 'absent',
                // V2 wraps MCP tools in Code Mode by default, so the provider
                // request does not list them directly; a connected server is
                // the discovery evidence.
                discovered: statuses[server] === 'connected',
              };
              expect.soft(configMcp, `server "${server}" must be registered`).toContain(server);
            }

            const missingFromProvider = scan.skills.filter((skill) => !providerSkills.has(skill));
            expect
              .soft(missingFromProvider, 'skills missing from the provider request')
              .toEqual([]);
            const missingFromHost = scan.skills.filter(
              (skill) => !(report.skillEndpoint ?? []).includes(skill),
            );
            expect.soft(missingFromHost, 'skills missing from opencode discovery').toEqual([]);
          });
        } catch (error) {
          report.failure = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          REPORTS.push(report);
          await writeReport();
        }
      },
      20 * 60 * 1000,
    );
  }

  afterAll(async () => {
    await writeReport();
    console.log(`top-plugins report: ${REPORT_FILE}`);
  });
});
