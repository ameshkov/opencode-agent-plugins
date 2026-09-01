import { describe, expect, it } from 'vitest';
import { discoverMcp, isValidServerName, sanitizeServerName } from './mcp.js';
import { validateHeaders, validateRemoteUrl } from './remote.js';
import { tmpPlugin, VALID_PLUGIN_JSON } from '../../test/helpers.js';

const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const DATA = '/data/x';

function mcpJson(servers: Record<string, unknown>, schema = MCP_SCHEMA): string {
  return JSON.stringify({ $schema: schema, mcpServers: servers }, undefined, 2);
}

describe('discoverMcp', () => {
  it('treats a missing mcp.json as valid absence', async () => {
    const plugin = await tmpPlugin({ 'plugin.json': VALID_PLUGIN_JSON });
    try {
      const result = await discoverMcp(plugin.root, PLUGIN_SCHEMA, DATA);
      expect(result.status).toBe('absent');
      expect(result.servers).toEqual([]);
    } finally {
      await plugin.cleanup();
    }
  });

  it('translates stdio to local with placeholders expanded and dirs injected', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': mcpJson({
        echo: {
          type: 'stdio',
          command: './bin/serve.js',
          args: ['--ping', '${PLUGIN_DATA}/p'],
          env: { DIR: '${PLUGIN_ROOT}/data' },
          cwd: '${PLUGIN_ROOT}',
        },
      }),
    });
    try {
      const result = await discoverMcp(plugin.root, PLUGIN_SCHEMA, DATA);
      expect(result.status).toBe('ok');
      expect(result.servers).toHaveLength(1);
      const config = result.servers[0]!.config;
      expect(config?.type).toBe('local');
      if (config?.type === 'local') {
        expect(config.command).toEqual([`${plugin.root}/bin/serve.js`, '--ping', `${DATA}/p`]);
        expect(config.environment?.['PLUGIN_ROOT']).toBe(plugin.root);
        expect(config.environment?.['PLUGIN_DATA']).toBe(DATA);
        expect(config.environment?.['DIR']).toBe(`${plugin.root}/data`);
        expect(config.cwd).toBe(plugin.root);
      }
    } finally {
      await plugin.cleanup();
    }
  });

  it('translates streamable-http to remote', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': mcpJson({
        api: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          headers: { Authorization: 'x' },
        },
      }),
    });
    try {
      const result = await discoverMcp(plugin.root, PLUGIN_SCHEMA, DATA);
      expect(result.servers[0]!.config).toEqual({
        type: 'remote',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'x' },
      });
    } finally {
      await plugin.cleanup();
    }
  });

  it('skips sse entries with an unsupported-transport warning', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': mcpJson({ legacy: { type: 'sse', url: 'https://example.com/sse' } }),
    });
    try {
      const result = await discoverMcp(plugin.root, PLUGIN_SCHEMA, DATA);
      expect(result.servers).toEqual([]);
      expect(result.failures.map((f) => f.kind)).toEqual(['server-transport']);
    } finally {
      await plugin.cleanup();
    }
  });

  it('disables MCP on a version mismatch and keeps status', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': mcpJson({ echo: { type: 'stdio', command: './bin/x' } }),
    });
    try {
      // Plugin schema at a newer version than the (supported) 1.0.0 mcp schema.
      const result = await discoverMcp(
        plugin.root,
        'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
        DATA,
      );
      expect(result.status).toBe('disabled');
      expect(result.reason).toContain('version');
    } finally {
      await plugin.cleanup();
    }
  });

  it('disables MCP on an unknown $schema', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': mcpJson(
        { echo: { type: 'stdio', command: './bin/x' } },
        'https://agent-plugins.org/schemas/9.9.9/mcp.schema.json',
      ),
    });
    try {
      const result = await discoverMcp(plugin.root, PLUGIN_SCHEMA, DATA);
      expect(result.status).toBe('disabled');
    } finally {
      await plugin.cleanup();
    }
  });

  it('disables MCP on invalid JSON', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': '{ broken',
    });
    try {
      const result = await discoverMcp(plugin.root, PLUGIN_SCHEMA, DATA);
      expect(result.status).toBe('disabled');
    } finally {
      await plugin.cleanup();
    }
  });

  it('skips invalid individual entries and keeps valid ones', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': mcpJson({
        good: { type: 'stdio', command: './bin/a' },
        missingCommand: { type: 'stdio' },
        badCwd: { type: 'stdio', command: './bin/b', cwd: '/etc' },
        escape: { type: 'stdio', command: '../bin/c' },
        badName: { type: 'stdio', command: './bin/d', url: 'https://x' },
      }),
    });
    try {
      const result = await discoverMcp(plugin.root, PLUGIN_SCHEMA, DATA);
      expect(result.servers.map((s) => s.name)).toEqual(['good']);
      expect(result.failures.filter((f) => f.kind === 'server-invalid')).toHaveLength(4);
    } finally {
      await plugin.cleanup();
    }
  });

  it('skips http remote servers on non-loopback hosts', async () => {
    const plugin = await tmpPlugin({
      'plugin.json': VALID_PLUGIN_JSON,
      'mcp.json': mcpJson({ api: { type: 'streamable-http', url: 'http://example.com/mcp' } }),
    });
    try {
      const result = await discoverMcp(plugin.root, PLUGIN_SCHEMA, DATA);
      expect(result.servers).toEqual([]);
      expect(result.failures.map((f) => f.kind)).toEqual(['server-invalid']);
    } finally {
      await plugin.cleanup();
    }
  });
});

describe('validateRemoteUrl', () => {
  it('accepts https and loopback http', () => {
    expect(validateRemoteUrl('https://example.com/mcp')).toBeNull();
    expect(validateRemoteUrl('http://localhost:8080/mcp')).toBeNull();
    expect(validateRemoteUrl('http://127.0.0.1/mcp')).toBeNull();
  });

  it('rejects relative, user-info, fragment and non-https', () => {
    expect(validateRemoteUrl('example.com/mcp')).not.toBeNull();
    expect(validateRemoteUrl('https://user:pass@example.com/mcp')).not.toBeNull();
    expect(validateRemoteUrl('https://example.com/mcp#frag')).not.toBeNull();
    expect(validateRemoteUrl('http://example.com/mcp')).not.toBeNull();
    expect(validateRemoteUrl('ftp://example.com/mcp')).not.toBeNull();
  });
});

describe('validateHeaders', () => {
  it('accepts well-formed unique field names', () => {
    expect(validateHeaders({ Authorization: 'x', 'X-Custom-1': 'y' })).toBeNull();
  });

  it('rejects duplicates under case-insensitive comparison', () => {
    expect(validateHeaders({ Authorization: 'a', authorization: 'b' })).not.toBeNull();
  });

  it('rejects invalid field names', () => {
    expect(validateHeaders({ 'bad name': 'x' })).not.toBeNull();
  });
});

describe('server names', () => {
  it('validates and sanitizes names', () => {
    expect(isValidServerName('echo')).toBe(true);
    expect(isValidServerName('echo.tool')).toBe(false);
    expect(sanitizeServerName('echo.tool')).toBe('echo-tool');
    expect(sanitizeServerName('a/b c')).toBe('a-b-c');
  });

  it('rejects empty or overlong sanitized names', () => {
    expect(sanitizeServerName('!!!')).toBe('---');
    expect(isValidServerName(sanitizeServerName('!!!'))).toBe(true);
  });
});
