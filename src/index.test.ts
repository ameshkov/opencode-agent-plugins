import { realpath, stat } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import agentPlugins from './index.js';
import { stubClient } from '../test/stub-client.js';
import { skillMd, tmpPlugin, VALID_PLUGIN_JSON } from '../test/helpers.js';

type RuntimeConfig = Config & {
  skills?: { paths: string[] };
  mcp?: Record<
    string,
    {
      type: string;
      command?: string[];
      environment?: Record<string, string>;
      cwd?: string;
      url?: string;
    }
  >;
};

/** Creates the minimal plugin input with a stub client. */
function pluginInput(): PluginInput {
  return { client: stubClient(), directory: process.cwd() } as unknown as PluginInput;
}

describe('agentPlugins plugin', () => {
  it('registers skills and MCP servers from a valid plugin', async () => {
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
    const dataHome = await tmpPlugin({ x: 'x' });
    process.env['XDG_DATA_HOME'] = dataHome.root;
    try {
      const root = await realpath(plugin.root);
      const input = pluginInput();
      const hooks = await agentPlugins(input, { plugins: [plugin.root] });
      const config = {} as RuntimeConfig;
      await hooks.config!(config);

      expect(config.skills?.paths).toContain(`${root}/skills`);
      const mcp = config.mcp!;
      expect(Object.keys(mcp)).toEqual(['echo']);
      expect(mcp['echo']!.type).toBe('local');
      expect(mcp['echo']!.command).toEqual([`${root}/bin/serve.js`, '--ping']);
      expect(mcp['echo']!.environment?.['PLUGIN_ROOT']).toBe(root);
      expect(mcp['echo']!.environment?.['PLUGIN_DATA']).toContain('hello-');
      expect(mcp['echo']!.environment?.['DIR']).toBe(mcp['echo']!.environment?.['PLUGIN_DATA']);

      // PLUGIN_DATA dir must be created eagerly for stdio servers.
      expect(await stat(mcp['echo']!.environment!['PLUGIN_DATA']!)).toBeDefined();

      const messages = vi.mocked(input.client.app.log).mock.calls.map((c) => c[0]!.body!.message);
      expect(messages).toContain('plugin loading');
    } finally {
      await plugin.cleanup();
    }
  });

  it('registers remote servers under a prefixed name and skips collisions', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { api: { type: 'streamable-http', url: 'https://example.com/mcp' } },
      }),
    });
    try {
      const input = pluginInput();
      const hooks = await agentPlugins(input, { plugins: [plugin.root], prefix: true });
      const config = {} as RuntimeConfig;
      await hooks.config!(config);
      expect(Object.keys(config.mcp ?? {})).toEqual(['hello-api']);
      expect(config.mcp!['hello-api']!.type).toBe('remote');
    } finally {
      await plugin.cleanup();
    }
  });

  it('lets user config win on name collisions', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { echo: { type: 'stdio', command: './bin/serve.js' } },
      }),
    });
    try {
      const input = pluginInput();
      const hooks = await agentPlugins(input, { plugins: [plugin.root] });
      const config = {
        mcp: { echo: { type: 'local', command: ['user-cmd'], enabled: false } },
      } as unknown as RuntimeConfig;
      await hooks.config!(config);
      // The user's entry stays untouched.
      expect(config.mcp!['echo']!.command).toEqual(['user-cmd']);
      const messages = vi.mocked(input.client.app.log).mock.calls.map((c) => c[0]!.body!.message);
      expect(messages.some((m) => m.includes('user config wins'))).toBe(true);
    } finally {
      await plugin.cleanup();
    }
  });

  it('skips a plugin with an invalid manifest and continues with others', async () => {
    const bad = await tmpPlugin({
      'plugin.json': JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
        name: 'bad..name',
      }),
    });
    const good = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
    });
    try {
      const input = pluginInput();
      const hooks = await agentPlugins(input, { plugins: [bad.root, good.root] });
      const config = {} as RuntimeConfig;
      await hooks.config!(config);
      expect(config.skills?.paths).toEqual([`${await realpath(good.root)}/skills`]);
      const messages = vi.mocked(input.client.app.log).mock.calls.map((c) => c[0]!.body!.message);
      expect(messages.some((m) => m.includes('invalid plugin.json'))).toBe(true);
    } finally {
      await bad.cleanup();
      await good.cleanup();
    }
  });

  it('warns for git sources that are not installed (no network at startup)', async () => {
    const input = pluginInput();
    const hooks = await agentPlugins(input, {
      plugins: ['git+https://github.com/org/absent.git#v1.0.0'],
    });
    const config = {} as RuntimeConfig;
    await hooks.config!(config);
    const messages = vi.mocked(input.client.app.log).mock.calls.map((c) => c[0]!.body!.message);
    expect(messages.some((m) => m.includes('not installed in the client store'))).toBe(true);
    expect(config.skills?.paths ?? []).toEqual([]);
  });

  it('does not throw on a malformed ref and continues with other plugins', async () => {
    const good = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'skills/hello/SKILL.md': skillMd('hello', 'Hi'),
    });
    try {
      const input = pluginInput();
      const hooks = await agentPlugins(input, {
        plugins: ['git+https://github.com/org/absent.git#bad ref', good.root],
      });
      const config = {} as RuntimeConfig;
      await expect(hooks.config!(config)).resolves.toBeUndefined();
      expect(config.skills?.paths).toEqual([`${await realpath(good.root)}/skills`]);
      const messages = vi.mocked(input.client.app.log).mock.calls.map((c) => c[0]!.body!.message);
      expect(messages.some((m) => m.includes('invalid git ref'))).toBe(true);
    } finally {
      await good.cleanup();
    }
  });

  it('logs an error and still returns hooks when options are invalid', async () => {
    const input = pluginInput();
    const hooks = await agentPlugins(input, {});
    expect(hooks.config).toBeDefined();
    const config = {} as RuntimeConfig;
    await hooks.config!(config);
    const messages = vi.mocked(input.client.app.log).mock.calls.map((c) => c[0]!.body!.message);
    expect(messages).toContain('failed to parse agent plugins options');
  });
});

describe('agentPlugins scaffold behavior', () => {
  it('normalizes config.skills and logs configured sources', async () => {
    const input = pluginInput();
    const hooks = await agentPlugins(input, { plugins: ['./agent-plugins/my-plugin'] });
    const config = { skills: { paths: ['/pre/existing'] } } as unknown as RuntimeConfig;
    await hooks.config!(config);
    expect(config.skills!.paths).toEqual(['/pre/existing']);
    const messages = vi.mocked(input.client.app.log).mock.calls.map((c) => c[0]!.body!.message);
    expect(messages).toContain('agent plugins configured');
  });
});
