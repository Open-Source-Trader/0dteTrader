import { OptionsAnalyticsController } from './options-analytics.controller';

describe('OptionsAnalyticsController', () => {
  it('returns the canonical snapshot and persists viewed requests without failing the response', async () => {
    const result = {
      snapshot: { scope: { symbol: 'SPY', expiration: '2026-07-20' } },
      input: {},
      scope: 'shared',
    };
    const analytics = {
      getSnapshotResult: jest.fn().mockResolvedValue(result),
    };
    let releasePersistence!: () => void;
    const pendingPersistence = new Promise<boolean>((resolve) => {
      releasePersistence = () => resolve(false);
    });
    const capture = { persist: jest.fn().mockReturnValue(pendingPersistence) };
    const controller = new OptionsAnalyticsController(analytics as never, capture as never);

    let responseSettled = false;
    const response = controller
      .getSnapshot({ userId: 'user-1' } as never, { symbol: 'spy', expiration: '2026-07-20' })
      .then((value) => {
        responseSettled = true;
        return value;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(responseSettled).toBe(true);
    await expect(response).resolves.toBe(result.snapshot);
    releasePersistence();
    expect(analytics.getSnapshotResult).toHaveBeenCalledWith('spy', '2026-07-20', 'user-1');
    expect(capture.persist).toHaveBeenCalledWith(result, 'viewed');
  });

  it('never persists a user-scoped snapshot into the shared capture history', async () => {
    const result = {
      snapshot: { scope: { symbol: 'SPY', expiration: '2026-07-20' } },
      input: {},
      scope: 'u-someone',
    };
    const analytics = { getSnapshotResult: jest.fn().mockResolvedValue(result) };
    const capture = { persist: jest.fn() };
    const controller = new OptionsAnalyticsController(analytics as never, capture as never);

    await expect(
      controller.getSnapshot({ userId: 'user-1' } as never, {
        symbol: 'SPY',
        expiration: '2026-07-20',
      }),
    ).resolves.toBe(result.snapshot);
    expect(capture.persist).not.toHaveBeenCalled();
  });
});
