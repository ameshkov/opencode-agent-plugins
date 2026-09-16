/**
 * Writes the opencode config per e2e scenario mode (single source of truth
 * for every configuration the scenarios use).
 *
 * `hook`-style modes register the plugin by path
 * (`["/app/plugin/build/index.js", { plugins: [...] }]`) so the real config
 * hook does the registration. `static` mode writes the exact values the hook
 * would produce directly into the config — the baseline the design proves
 * behaviorally equivalent (docs/explanation/design.md §9.1).
 *
 * `cli`-style modes register the plugin under its npm package name
 * (`["opencode-agent-plugins", { plugins: [...] }]`) — the tuple form the CLI
 * edits (§5.11). The package is installed globally (and into the workspace)
 * in the image so opencode can resolve the name; the plugin entry stays
 * registered while the CLI mutates the `plugins` array through config edits.
 *
 * Scenario modes:
 * - `hook`            path plugin, the stdio fixture (my-plugin).
 * - `static`          handwritten baseline of what `hook` produces.
 * - `remote`          path plugin, the remote fixture (remote-plugin).
 * - `negative-invalid`  my-plugin + a plugin with an unparsable manifest.
 * - `negative-mismatch` mcp.json `$schema` version mismatch fixture.
 * - `negative-stub`   my-plugin + a user-authored `mcp.echo` stub.
 * - `skill-collision` my-plugin + a user-authored `skills.paths` entry whose
 *                     `hello` skill collides with the plugin's.
 * - `cli`             `opencode-agent-plugins` tuple, empty `plugins` (the
 *                     CLI then registers sources into it).
 * - `cli-missing`     tuple pre-seeded with a git source that is NOT
 *                     installed (startup warn + skip, §5.3.3).
 */

import { writeFile } from 'node:fs/promises';

/** Model/provider baseline shared by every mode (the fake server). */
function baseConfig() {
  return {
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
}

/** The plugin entry as the path-loaded module (config-hook harness). */
function pathPlugin(sources) {
  return [['/app/plugin/build/index.js', { plugins: sources }]];
}

/** Writes `/app/workspace/opencode.json` for the given mode. */
export async function writeConfig(mode) {
  const base = baseConfig();

  switch (mode) {
    case 'hook':
      base['plugin'] = pathPlugin(['/app/fixtures/my-plugin']);
      break;
    case 'static': {
      // Values identical to what the config hook produces for the fixture:
      // ./bin/serve.js resolves to the absolute path inside the plugin root,
      // the ${PLUGIN_ROOT}/${PLUGIN_DATA} placeholders of args/env are
      // expanded ($5.5), cwd defaults to the plugin root, PLUGIN_ROOT and
      // PLUGIN_DATA are injected.
      base['mcp'] = {
        echo: {
          type: 'local',
          command: [
            '/app/fixtures/my-plugin/bin/serve.js',
            '--placeholder-root',
            '/app/fixtures/my-plugin',
            '--placeholder-data',
            '/app/static-data/hello',
          ],
          environment: {
            PLUGIN_ROOT: '/app/fixtures/my-plugin',
            PLUGIN_DATA: '/app/static-data/hello',
            E2E_ROOT: '/app/fixtures/my-plugin',
            E2E_DATA: '/app/static-data/hello',
          },
          cwd: '/app/fixtures/my-plugin',
        },
      };
      base['skills'] = { paths: ['/app/fixtures/my-plugin/skills'] };
      break;
    }
    case 'remote':
      base['plugin'] = pathPlugin(['/app/fixtures/remote-plugin']);
      break;
    case 'negative-invalid':
      base['plugin'] = pathPlugin(['/app/fixtures/my-plugin', '/app/fixtures/broken-plugin']);
      break;
    case 'negative-mismatch':
      base['plugin'] = pathPlugin(['/app/fixtures/mismatch-plugin']);
      break;
    case 'negative-stub':
      // The user authored an `mcp.echo` entry; the plugin's `echo` server of
      // the same name must be skipped, user config wins (§5.7).
      base['plugin'] = pathPlugin(['/app/fixtures/my-plugin']);
      base['mcp'] = {
        echo: { type: 'local', command: ['/bin/true'], enabled: false },
      };
      break;
    case 'skill-collision':
      // The user authored a `skills.paths` entry providing a `hello` skill;
      // the plugin's `hello` skill of the same name must be skipped, user
      // config wins (§3.2, §5.6). The plugin's `skills/` dir must NOT be
      // added to `config.skills.paths`.
      base['plugin'] = pathPlugin(['/app/fixtures/my-plugin']);
      base['skills'] = { paths: ['/app/fixtures/user-skills'] };
      break;
    case 'cli':
      base['plugin'] = [['opencode-agent-plugins', { plugins: [] }]];
      break;
    case 'cli-missing':
      base['plugin'] = [
        ['opencode-agent-plugins', { plugins: ['file:///app/git-fixtures/remote.git'] }],
      ];
      break;
    default:
      throw new Error(`unknown mode: ${String(mode)}`);
  }

  await writeFile('/app/workspace/opencode.json', `${JSON.stringify(base, null, 2)}\n`);
  console.log(`wrote opencode.json for mode: ${mode}`);
}
