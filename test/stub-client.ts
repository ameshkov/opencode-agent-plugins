import { vi } from 'vitest';
import type { PluginInput } from '@opencode-ai/plugin';

/**
 * Minimal stub of the opencode SDK client for tests.
 *
 * Only `app.log` is implemented, as a vitest mock that resolves immediately.
 * Everything else is omitted. Useful for exercising plugin code that logs via
 * `client.app.log` without a running opencode server.
 *
 * @returns A stub client whose `app.log` is a vitest mock.
 */
export function stubClient(): PluginInput['client'] {
  return {
    app: {
      log: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as PluginInput['client'];
}
