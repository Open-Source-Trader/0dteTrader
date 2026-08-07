import { AutoScoringController } from './auto-scoring.controller';

describe('AutoScoringController preferences', () => {
  it('scopes reads and writes to the authenticated user id', async () => {
    const preferences = {
      get: jest.fn().mockResolvedValue({ preset: 'conservative' }),
      create: jest.fn().mockResolvedValue({ preset: 'custom' }),
      update: jest.fn().mockResolvedValue({ preset: 'aggressive' }),
    };
    const candidates = { rank: jest.fn().mockResolvedValue({ selectedSymbol: 'OCC' }) };
    const controller = new AutoScoringController(preferences as never, candidates as never);
    const user = { userId: 'user-1' };
    const create = { preset: 'custom' };
    const update = { preset: 'aggressive', expectedUpdatedAt: '2026-08-05T15:00:00Z' };

    await controller.getPreferences(user);
    await controller.createPreferences(user, create as never);
    await controller.updatePreferences(user, update as never);
    await controller.rank(user, {
      underlying: 'SPX',
      expiration: '2026-08-05',
      optionType: 'call',
    });

    expect(preferences.get).toHaveBeenCalledWith('user-1');
    expect(preferences.create).toHaveBeenCalledWith('user-1', create);
    expect(preferences.update).toHaveBeenCalledWith('user-1', update);
    expect(candidates.rank).toHaveBeenCalledWith('user-1', {
      underlying: 'SPX',
      expiration: '2026-08-05',
      optionType: 'call',
    });
  });
});
