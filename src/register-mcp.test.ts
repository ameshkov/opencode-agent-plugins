import { describe, expect, it, vi } from 'vitest';
import { logsWithBoundary, runRegistration, stubContext } from '../test/stub-context.js';
import { tempDir, tmpPlugin, VALID_PLUGIN_JSON } from '../test/helpers.js';

/** A plugin tree with one remote MCP server. */
async function remotePlugin(serverName: string): Promise<Awaited<ReturnType<typeof tmpPlugin>>> {
  return tmpPlugin({
    'plugin.json': VALID_PLUGIN_JSON,
    'mcp.json': JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { [serverName]: { type: 'streamable-http', url: 'https://example.com/mcp' } },
    }),
  });
}

describe('MCP registration', () => {
  it('registers remote servers under a prefixed name', async () => {
    const plugin = await remotePlugin('api');
    try {
      const stub = stubContext();
      await runRegistration(stub, { plugins: [plugin.root], prefix: true });
      expect([...stub.registeredMcp.keys()]).toEqual(['hello-api']);
      expect(stub.registeredMcp.get('hello-api')?.type).toBe('remote');
    } finally {
      await plugin.cleanup();
    }
  });

  it('lets user config win on name collisions', async () => {
    const configHome = await tempDir('oap-config-');
    vi.stubEnv('XDG_CONFIG_HOME', configHome.root);
    vi.stubEnv('OPENCODE_CONFIG_DIR', '');
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
        mcpServers: { echo: { type: 'stdio', command: './bin/serve.js' } },
      }),
    });
    try {
      const userEntry = { type: 'local' as const, command: ['user-cmd'] };
      const stub = stubContext({ mcp: [['echo', userEntry]] });
      await runRegistration(stub, { plugins: [plugin.root] });

      expect(stub.registeredMcp.size).toBe(0);
      // The user's entry is untouched.
      expect(userEntry.command).toEqual(['user-cmd']);
      const collision = logsWithBoundary(stub, 'server-collision');
      expect(collision).toHaveLength(1);
      expect(collision[0]!.message).toContain('user config wins');
      expect(collision[0]!.level).toBe('warn');
    } finally {
      vi.unstubAllEnvs();
      await plugin.cleanup();
      await configHome.cleanup();
    }
  });

  it('skips the later plugin server on a plugin-plugin collision', async () => {
    const first = await remotePlugin('api');
    const second = await remotePlugin('api');
    try {
      const stub = stubContext();
      await runRegistration(stub, { plugins: [first.root, second.root] });

      expect([...stub.registeredMcp.keys()]).toEqual(['api']);
      const collision = logsWithBoundary(stub, 'server-collision');
      expect(collision).toHaveLength(1);
      expect(collision[0]!.message).toContain('already used by another plugin in this run');
      expect(collision[0]!.level).toBe('error');
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});
