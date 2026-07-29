import { Logger } from '@nestjs/common';
import { timed } from './timing';

describe('timed', () => {
  it('returns the wrapped function result', async () => {
    const logger = { debug: jest.fn() } as unknown as Logger;
    const result = await timed(logger, 'op', async () => 42);
    expect(result).toBe(42);
  });

  it('logs a duration for the label on success', async () => {
    const logger = { debug: jest.fn() } as unknown as Logger;
    await timed(logger, 'my-op', async () => 'ok');
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/^my-op took \d+ms$/));
  });

  it('logs a duration and rethrows on failure', async () => {
    const logger = { debug: jest.fn() } as unknown as Logger;
    const err = new Error('boom');
    await expect(
      timed(logger, 'failing-op', async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringMatching(/^failing-op took \d+ms$/));
  });
});
