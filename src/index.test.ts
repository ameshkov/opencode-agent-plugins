import { stat } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '@opencode/plugin/promise/plugin';
import agentPlugins from './index.js';
import { stubContext } from '../test/stub-context.js';
import { skillMd, tmpPlugin, VALID_PLUGIN_JSON } from '../test/helpers.js';
import { dataDirForKey, pathDataHash } from './lib/data.js';

/** Silences the entry's own console logger (it cannot be injected). */
function silenceConsole(): void {
  for (const method of ['debug', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
}

/** Calls the entry's setup with a stub context. */
async function runSetup(context: ReturnType<typeof stubContext>): Promise<void> {
  await agentPlugins.setup(context.context as unknown as Context);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('agentPlugins plugin definition (V2)', () => {
  it('exposes a default definition with a stable id and setup', () => {
    expect(agentPlugins.id).toBe('opencode-agent-plugins');
    expect(typeof agentPlugins.setup).toBe('function');
    // V2-only: no V1 `server` entrypoint.
    expect('server' in agentPlugins).toBe(false);
  });

  it('registers skills and MCP servers from a valid plugin', async () => {
    silenceConsole();
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Greets the world.'),
      'mcp.json': JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          echo: {
            type: 'stdio',
            command: './bin/serve.js',
            args: ['--ping'],
            env: { DIR: '${PLUGIN_DATA}' },
          },
        },
      }),
    });
    const configHome = await tmpPlugin({ x: 'x' });
    vi.stubEnv('XDG_CONFIG_HOME', configHome.root);
    vi.stubEnv('OPENCODE_CONFIG_DIR', '');
    try {
      const root = await realpath(plugin.root);
      const stub = stubContext({ options: { plugins: [plugin.root] } });
      await runSetup(stub);

      const skill = stub.registeredSkills.get('hello');
      expect(skill?.path).toBe(join(root, 'skills/hello/SKILL.md'));
      expect(skill?.content).toContain('# hello');

      const mcp = stub.registeredMcp.get('echo');
      expect(mcp?.type).toBe('local');
      if (mcp?.type === 'local') {
        expect(mcp.command).toEqual([`${root}/bin/serve.js`, '--ping']);
        expect(mcp.environment?.['PLUGIN_ROOT']).toBe(root);
        expect(mcp.environment?.['PLUGIN_DATA']).toContain('hello-');
        expect(mcp.environment?.['DIR']).toBe(mcp.environment?.['PLUGIN_DATA']);
        // PLUGIN_DATA dir must be created eagerly for stdio servers.
        expect(await stat(mcp.environment!['PLUGIN_DATA']!)).toBeDefined();
      }
    } finally {
      await plugin.cleanup();
      await configHome.cleanup();
    }
  });

  it('does not create PLUGIN_DATA for a plugin without a stdio server', async () => {
    silenceConsole();
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: {
          remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
        },
      }),
    });
    const configHome = await tmpPlugin({ x: 'x' });
    vi.stubEnv('XDG_CONFIG_HOME', configHome.root);
    vi.stubEnv('OPENCODE_CONFIG_DIR', '');
    try {
      const root = await realpath(plugin.root);
      const stub = stubContext({ options: { plugins: [plugin.root] } });
      await runSetup(stub);

      expect(stub.registeredMcp.get('remote')?.type).toBe('remote');
      // No stdio server means no PLUGIN_DATA directory, not even an empty one.
      const dataDir = dataDirForKey(`hello-${pathDataHash(root)}`, {
        XDG_CONFIG_HOME: configHome.root,
      });
      await expect(stat(dataDir)).rejects.toThrow();
    } finally {
      await plugin.cleanup();
      await configHome.cleanup();
    }
  });

  it('logs an error and still resolves when options are invalid', async () => {
    silenceConsole();
    const stub = stubContext({ options: {} });
    await expect(runSetup(stub)).resolves.toBeUndefined();
    const errors = vi
      .mocked(console.error)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(errors).toContain('failed to parse agent plugins options');
  });

  it('never throws when a source fails during registration', async () => {
    silenceConsole();
    const stub = stubContext({ options: { plugins: ['./agent-plugins/missing'] } });
    await expect(runSetup(stub)).resolves.toBeUndefined();
    expect(stub.registeredSkills.size).toBe(0);
    expect(stub.registeredMcp.size).toBe(0);
  });
});
