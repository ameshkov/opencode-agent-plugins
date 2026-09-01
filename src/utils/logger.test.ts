import { describe, expect, it, vi } from 'vitest';
import { stubClient } from '../../test/stub-client.js';
import { createLogger } from './logger.js';

describe('createLogger', () => {
  it('forwards entries at or above the minimum level', async () => {
    const client = stubClient();
    const logger = createLogger(client, 'warn');

    await logger.debug('dropped');
    await logger.info('dropped');

    await logger.warn('kept');
    await logger.error('kept');

    const log = vi.mocked(client.app.log);
    const messages = log.mock.calls.map((call) => call[0]!.body!.message);
    expect(messages).toEqual(['kept', 'kept']);
  });

  it('forwards everything at the debug level', async () => {
    const client = stubClient();
    const logger = createLogger(client, 'debug');

    await logger.debug('dbg');
    await logger.info('inf');
    await logger.warn('wrn');

    expect(vi.mocked(client.app.log).mock.calls).toHaveLength(3);
  });

  it('swallows submission failures so logging never throws', async () => {
    const client = stubClient();
    vi.mocked(client.app.log).mockRejectedValue(new Error('down'));

    const logger = createLogger(client, 'debug');
    await expect(logger.info('msg')).resolves.toBeUndefined();
  });
});
