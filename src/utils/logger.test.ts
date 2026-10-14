import { describe, expect, it, vi } from 'vitest';
import { recordingLogger } from '../../test/stub-context.js';
import { createLogger, type LogSink } from './logger.js';

describe('createLogger', () => {
  it('forwards entries at or above the minimum level', async () => {
    const { logger, entries } = recordingLogger('warn');

    await logger.debug('dropped');
    await logger.info('dropped');

    await logger.warn('kept');
    await logger.error('kept');

    expect(entries.map((entry) => entry.message)).toEqual(['kept', 'kept']);
    expect(entries.map((entry) => entry.level)).toEqual(['warn', 'error']);
  });

  it('forwards everything at the debug level', async () => {
    const { logger, entries } = recordingLogger('debug');

    await logger.debug('dbg');
    await logger.info('inf');
    await logger.warn('wrn');

    expect(entries).toHaveLength(3);
  });

  it('writes one console line with the level and trailing metadata (§5.10)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await createLogger('debug').info('plugin "hello" registered', { skills: 1 });

      expect(info).toHaveBeenCalledWith(
        '[opencode-agent-plugins] info plugin "hello" registered {"skills":1}',
      );
    } finally {
      info.mockRestore();
    }
  });

  it('swallows sink failures so logging never throws', async () => {
    const sink: LogSink = {
      debug: () => {},
      info: () => {
        throw new Error('down');
      },
      warn: () => {},
      error: () => {},
    };
    const logger = createLogger('debug', sink);

    await expect(logger.info('msg')).resolves.toBeUndefined();
  });
});
