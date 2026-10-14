/**
 * Writes the opencode config per e2e scenario mode (single source of truth
 * for every configuration the scenarios use).
 *
 * `hook`-style modes register the plugin by path
 * (`{ package: "/app/plugin", options: { plugins: [...] } }`) so the real V2
 * `setup` transform registration runs. `static` mode writes
 * the equivalent native V2 config directly — the baseline the design proves
 * behaviorally equivalent (docs/explanation/design.md §9.1).
 *
 * `cli`-style modes register the plugin under its npm package name
 * (`{ package: "opencode-agent-plugins", options: { plugins: [...] } }`) —
 * the V2 entry form the CLI edits (§5.11). The package is installed globally,
 * into the workspace, and seeded into opencode's npm plugin cache in the
 * image so opencode resolves the name; the plugin entry stays registered
 * while the CLI mutates the `options.plugins` array through config edits.
 *
 * Scenario modes:
 * - `hook`            path plugin, the stdio fixture (my-plugin).
 * - `static`          handwritten native-V2 baseline of what `hook` produces.
 * - `remote`          path plugin, the remote fixture (remote-plugin).
 * - `negative-invalid`  my-plugin + a plugin with an unparsable manifest.
 * - `negative-mismatch` mcp.json `$schema` version mismatch fixture.
 * - `negative-stub`   my-plugin + a user-authored disabled `mcp.servers.echo`.
 * - `skill-collision` my-plugin + a user-authored `skills` entry whose
 *                     `hello` skill collides with the plugin's.
 * - `cli`             `opencode-agent-plugins` entry, empty `plugins` (the
 *                     CLI then registers sources into it).
 * - `cli-missing`     entry pre-seeded with a git source that is NOT
 *                     installed (startup warn + skip, §5.3.3).
 */

import { writeFile } from 'node:fs/promises';

/** Model/provider baseline shared by every mode (the fake server). */
function baseConfig() {
  return {
    $schema: 'https://opencode.ai/config.json',
    model: 'e2e/test-model',
    providers: {
      e2e: {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: 'E2E',
        settings: {
          baseURL: 'http://127.0.0.1:8787/v1',
          // Not a credential: the in-container fake model server accepts any
          // key, and this value authenticates nothing outside the container.
          apiKey: 'e2e-key',
        },
        models: {
          'test-model': { name: 'E2E test model' },
        },
      },
    },
  };
}

/** The plugin entry as the path-loaded module (V2 `{ package, options }`).
 *
 * V2 requires configured path entries to be plugin *directories* (a file path
 * is rejected with "configured plugin path must be a directory"); the
 * directory ships a `server.js` shim re-exporting the compiled entry.
 */
function pathPlugin(sources) {
  return [{ package: '/app/plugin', options: { plugins: sources } }];
}

/** The plugin entry under the npm package name (what the CLI edits). */
function packagePlugin(sources) {
  return [{ package: 'opencode-agent-plugins', options: { plugins: sources } }];
}

/** Writes `/app/workspace/opencode.json` for the given mode. */
export async function writeConfig(mode) {
  const base = baseConfig();

  switch (mode) {
    case 'hook':
      base['plugins'] = pathPlugin(['/app/fixtures/my-plugin']);
      break;
    case 'static': {
      // Native V2 values equivalent to what the plugin registers for the
      // fixture: the same stdio server (absolute paths, expanded
      // ${PLUGIN_ROOT}/${PLUGIN_DATA} values, cwd = plugin root) and the same
      // skills directory, written by hand.
      base['mcp'] = {
        servers: {
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
        },
      };
      base['skills'] = ['/app/fixtures/my-plugin/skills'];
      break;
    }
    case 'remote':
      base['plugins'] = pathPlugin(['/app/fixtures/remote-plugin']);
      break;
    case 'negative-invalid':
      base['plugins'] = pathPlugin(['/app/fixtures/my-plugin', '/app/fixtures/broken-plugin']);
      break;
    case 'negative-mismatch':
      base['plugins'] = pathPlugin(['/app/fixtures/mismatch-plugin']);
      break;
    case 'negative-stub':
      // The user authored a disabled `echo` server; the plugin's `echo`
      // server of the same name must be skipped, user config wins (§5.7).
      base['plugins'] = pathPlugin(['/app/fixtures/my-plugin']);
      base['mcp'] = {
        servers: { echo: { type: 'local', command: ['/bin/true'], disabled: true } },
      };
      break;
    case 'skill-collision':
      // The user authored a `skills` entry providing a `hello` skill; the
      // host's skill registry keeps the user's skill over the plugin's
      // registration of the same name (§3.2, §5.6, §9.1.5).
      base['plugins'] = pathPlugin(['/app/fixtures/my-plugin']);
      base['skills'] = ['/app/fixtures/user-skills'];
      break;
    case 'cli':
      base['plugins'] = packagePlugin([]);
      break;
    case 'cli-missing':
      base['plugins'] = packagePlugin(['file:///app/git-fixtures/remote.git']);
      break;
    default:
      throw new Error(`unknown mode: ${String(mode)}`);
  }

  await writeFile('/app/workspace/opencode.json', `${JSON.stringify(base, null, 2)}\n`);
  console.log(`wrote opencode.json for mode: ${mode}`);
}
