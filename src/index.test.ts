import { describe, expect, it, vi } from 'vitest';
import type { Config, PluginInput } from '@opencode-ai/plugin';
import agentPlugins from './index.js';
import { stubClient } from '../test/stub-client.js';

type RuntimeConfig = Config & { skills?: { paths: string[] } };

/** Creates the minimal plugin input with a stub client. */
function pluginInput(): PluginInput {
  return { client: stubClient() } as unknown as PluginInput;
}

describe('agentPlugins plugin', () => {
  it('normalizes config.skills and logs configured sources', async () => {
    const input = pluginInput();
    const hooks = await agentPlugins(input, { plugins: ['./agent-plugins/my-plugin'] });
    expect(hooks.config).toBeDefined();

    const config = {} as RuntimeConfig;
    await hooks.config!(config);

    expect(config.skills).toEqual({ paths: [] });

    const messages = vi
      .mocked(input.client.app.log)
      .mock.calls.map((call) => call[0]!.body!.message);
    expect(messages).toContain('will register agent plugin source');
    expect(messages).toContain('agent plugins configured');
  });

  it('logs an error and still returns hooks when options are invalid', async () => {
    const input = pluginInput();
    const hooks = await agentPlugins(input, {});
    expect(hooks.config).toBeDefined();

    const config = {} as RuntimeConfig;
    await hooks.config!(config);

    const messages = vi
      .mocked(input.client.app.log)
      .mock.calls.map((call) => call[0]!.body!.message);
    expect(messages).toContain('failed to parse agent plugins options');
  });
});
