import { ServiceUnavailableException } from '@nestjs/common';
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
    const controller = new OptionsAnalyticsController(
      analytics as never,
      capture as never,
      {} as never,
    );

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
    const controller = new OptionsAnalyticsController(
      analytics as never,
      capture as never,
      {} as never,
    );

    await expect(
      controller.getSnapshot({ userId: 'user-1' } as never, {
        symbol: 'SPY',
        expiration: '2026-07-20',
      }),
    ).resolves.toBe(result.snapshot);
    expect(capture.persist).not.toHaveBeenCalled();
  });

  it('gex-heatmap reuses getSnapshotResult (no duplicate ingestion) and awaits the viewed capture before querying history', async () => {
    const result = {
      snapshot: { scope: { symbol: 'SPY', expiration: '2026-07-20' } },
      input: {},
      scope: 'shared',
    };
    const analytics = { getSnapshotResult: jest.fn().mockResolvedValue(result) };
    const events: string[] = [];
    const capture = {
      persist: jest.fn().mockImplementation(async () => {
        events.push('persist');
        return true;
      }),
    };
    const heatmapSnapshot = {
      underlyingSymbol: 'SPY',
      expiration: '2026-07-20',
      spotSeries: [],
      timestamps: [],
      strikes: [],
      cells: [],
    };
    const gexHeatmap = {
      getHeatmap: jest.fn().mockImplementation(async () => {
        events.push('getHeatmap');
        return heatmapSnapshot;
      }),
    };
    const controller = new OptionsAnalyticsController(
      analytics as never,
      capture as never,
      gexHeatmap as never,
    );

    const response = await controller.getGexHeatmap(
      { userId: 'user-1' } as never,
      {
        symbol: 'spy',
      } as never,
    );

    expect(analytics.getSnapshotResult).toHaveBeenCalledTimes(1);
    expect(analytics.getSnapshotResult).toHaveBeenCalledWith('spy', undefined, 'user-1');
    // The viewed capture write must complete before history is queried, or a
    // fresh symbol's first request would read back a window missing the
    // point it just triggered.
    expect(events).toEqual(['persist', 'getHeatmap']);
    expect(gexHeatmap.getHeatmap).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'SPY', expiration: '2026-07-20' }),
    );
    expect(response).toBe(heatmapSnapshot);
  });

  it('gex-heatmap never persists a user-scoped snapshot into the shared capture history', async () => {
    const result = {
      snapshot: { scope: { symbol: 'SPY', expiration: '2026-07-20' } },
      input: {},
      scope: 'u-someone',
    };
    const analytics = { getSnapshotResult: jest.fn().mockResolvedValue(result) };
    const capture = { persist: jest.fn() };
    const gexHeatmap = { getHeatmap: jest.fn().mockResolvedValue({}) };
    const controller = new OptionsAnalyticsController(
      analytics as never,
      capture as never,
      gexHeatmap as never,
    );

    await controller.getGexHeatmap({ userId: 'user-1' } as never, { symbol: 'SPY' } as never);
    expect(capture.persist).not.toHaveBeenCalled();
  });

  it('gex-term-structure reuses getSnapshotResult for one expiration and awaits the viewed capture before querying', async () => {
    const result = {
      snapshot: { scope: { symbol: 'SPY', expiration: '2026-07-20' } },
      input: {},
      scope: 'shared',
    };
    const analytics = { getSnapshotResult: jest.fn().mockResolvedValue(result) };
    const events: string[] = [];
    const capture = {
      persist: jest.fn().mockImplementation(async () => {
        events.push('persist');
        return true;
      }),
    };
    const termStructureSnapshot = {
      underlyingSymbol: 'SPY',
      expirations: [],
      strikes: [],
      cells: [],
    };
    const gexHeatmap = {
      getTermStructure: jest.fn().mockImplementation(async () => {
        events.push('getTermStructure');
        return termStructureSnapshot;
      }),
    };
    const controller = new OptionsAnalyticsController(
      analytics as never,
      capture as never,
      gexHeatmap as never,
    );

    const response = await controller.getGexTermStructure(
      { userId: 'user-1' } as never,
      { symbol: 'spy' } as never,
    );

    expect(analytics.getSnapshotResult).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['persist', 'getTermStructure']);
    expect(gexHeatmap.getTermStructure).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'SPY' }),
    );
    expect(response).toBe(termStructureSnapshot);
  });

  it('gex-term-structure never persists a user-scoped snapshot into the shared capture history', async () => {
    const result = {
      snapshot: { scope: { symbol: 'SPY', expiration: '2026-07-20' } },
      input: {},
      scope: 'u-someone',
    };
    const analytics = { getSnapshotResult: jest.fn().mockResolvedValue(result) };
    const capture = { persist: jest.fn() };
    const gexHeatmap = { getTermStructure: jest.fn().mockResolvedValue({}) };
    const controller = new OptionsAnalyticsController(
      analytics as never,
      capture as never,
      gexHeatmap as never,
    );

    await controller.getGexTermStructure(
      { userId: 'user-1' } as never,
      {
        symbol: 'SPY',
      } as never,
    );
    expect(capture.persist).not.toHaveBeenCalled();
  });

  it('gex-heatmap falls back to the default expiration when the requested one has settled', async () => {
    const freshResult = {
      snapshot: { scope: { symbol: 'SPY', expiration: '2026-08-07' } },
      input: {},
      scope: 'shared',
    };
    const analytics = {
      getSnapshotResult: jest
        .fn()
        .mockImplementationOnce(() => {
          throw new ServiceUnavailableException({
            code: 'OPTIONS_ANALYTICS_UNAVAILABLE',
            message: 'Options analytics are unavailable for SPY 2026-08-06',
          });
        })
        .mockResolvedValueOnce(freshResult),
    };
    const capture = { persist: jest.fn().mockResolvedValue(true) };
    const gexHeatmap = { getHeatmap: jest.fn().mockResolvedValue({}) };
    const controller = new OptionsAnalyticsController(
      analytics as never,
      capture as never,
      gexHeatmap as never,
    );

    await controller.getGexHeatmap(
      { userId: 'user-1' } as never,
      {
        symbol: 'SPY',
        expiration: '2026-08-06',
      } as never,
    );

    expect(analytics.getSnapshotResult).toHaveBeenCalledTimes(2);
    expect(analytics.getSnapshotResult).toHaveBeenNthCalledWith(1, 'SPY', '2026-08-06', 'user-1');
    expect(analytics.getSnapshotResult).toHaveBeenNthCalledWith(2, 'SPY', undefined, 'user-1');
    expect(gexHeatmap.getHeatmap).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'SPY', expiration: '2026-08-07' }),
    );
  });

  it('gex-heatmap does not retry when no expiration was requested (nothing stale to fall back from)', async () => {
    const analytics = {
      getSnapshotResult: jest.fn().mockImplementation(() => {
        throw new ServiceUnavailableException({
          code: 'OPTIONS_ANALYTICS_UNAVAILABLE',
          message: 'Options analytics are unavailable for SPY',
        });
      }),
    };
    const capture = { persist: jest.fn() };
    const gexHeatmap = { getHeatmap: jest.fn() };
    const controller = new OptionsAnalyticsController(
      analytics as never,
      capture as never,
      gexHeatmap as never,
    );

    await expect(
      controller.getGexHeatmap({ userId: 'user-1' } as never, { symbol: 'SPY' } as never),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(analytics.getSnapshotResult).toHaveBeenCalledTimes(1);
  });

  it('gex-heatmap does not retry other error types (e.g. symbol not found)', async () => {
    const analytics = {
      getSnapshotResult: jest.fn().mockRejectedValue(new Error('boom')),
    };
    const capture = { persist: jest.fn() };
    const gexHeatmap = { getHeatmap: jest.fn() };
    const controller = new OptionsAnalyticsController(
      analytics as never,
      capture as never,
      gexHeatmap as never,
    );

    await expect(
      controller.getGexHeatmap(
        { userId: 'user-1' } as never,
        {
          symbol: 'SPY',
          expiration: '2026-08-06',
        } as never,
      ),
    ).rejects.toThrow('boom');
    expect(analytics.getSnapshotResult).toHaveBeenCalledTimes(1);
  });
});
