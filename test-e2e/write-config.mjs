/**
 * Writes the opencode config per e2e scenario mode (single source of truth
 * for both the hook-mode and static-mode registrations).
 *
 * `hook` mode registers the plugin by path (`["/app/plugin/build/index.js",
 * { plugins: [...] }]`) so the real config hook does the registration.
 * `static` mode writes the exact values the hook would produce directly into
 * the config — the baseline the design proves behaviorally equivalent
 * (docs/design.md §9.1).
 */

import { writeFile } from 'node:fs/promises';

/**
 * Writes `/app/workspace/opencode.json` for the given mode.
 *
 * @param {'hook' | 'static'} mode - Scenario mode: `hook` (plugin does the
 * registration) or `static` (values handwritten, the baseline).
 */
export async function writeConfig(mode) {
  const base = {
    $schema: 'https://opencode.ai/config.json',
    model: 'e2e/test-model',
    provider: {
      e2e: {
        npm: '@ai-sdk/openai-compatible',
        name: 'E2E',
        options: {
          baseURL: 'http://127.0.0.1:8787/v1',
          apiKey: 'e2e-key',
        },
        models: {
          'test-model': { name: 'E2E test model' },
        },
      },
    },
  };

  if (mode === 'hook') {
    base['plugin'] = [['/app/plugin/build/index.js', { plugins: ['/app/fixtures/my-plugin'] }]];
  } else if (mode === 'static') {
    // Values identical to what the config hook produces for the fixture:
    // ./bin/serve.js resolves to the absolute path inside the plugin root,
    // cwd defaults to the plugin root, PLUGIN_ROOT/PLUGIN_DATA are injected.
    base['mcp'] = {
      echo: {
        type: 'local',
        command: ['/app/fixtures/my-plugin/bin/serve.js'],
        environment: {
          PLUGIN_ROOT: '/app/fixtures/my-plugin',
          PLUGIN_DATA: '/app/static-data/hello',
        },
        cwd: '/app/fixtures/my-plugin',
      },
    };
    base['skills'] = { paths: ['/app/fixtures/my-plugin/skills'] };
  } else {
    throw new Error(`unknown mode: ${String(mode)}`);
  }

  await writeFile('/app/workspace/opencode.json', `${JSON.stringify(base, null, 2)}\n`);
  console.log(`wrote opencode.json for mode: ${mode}`);
}
