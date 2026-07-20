import { OptionsAnalyticsController } from './options-analytics.controller';

describe('OptionsAnalyticsController', () => {
  it('returns the canonical snapshot and persists viewed requests without failing the response', async () => {
    const result = {
      snapshot: { scope: { symbol: 'SPY', expiration: '2026-07-20' } },
      input: {},
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
      .getSnapshot({ symbol: 'spy', expiration: '2026-07-20' })
      .then((value) => {
        responseSettled = true;
        return value;
      });
    await Promise.resolve();
    await Promise.resolve();
    expect(responseSettled).toBe(true);
    await expect(response).resolves.toBe(result.snapshot);
    releasePersistence();
    expect(analytics.getSnapshotResult).toHaveBeenCalledWith('spy', '2026-07-20');
    expect(capture.persist).toHaveBeenCalledWith(result, 'viewed');
  });
});
