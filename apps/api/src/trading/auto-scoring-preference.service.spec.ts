import type {
  AutoScoringPreferenceCreate,
  AutoScoringPreferenceUpdate,
} from '@0dtetrader/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { InMemoryPrismaService } from '../../test/in-memory-prisma.service';
import { AutoScoringPreferenceService } from './auto-scoring-preference.service';

const conservative: AutoScoringPreferenceCreate = {
  schemaVersion: 1,
  preset: 'conservative',
  targetAbsDelta: 0.25,
  strikeRungs: 5,
  maxSpreadBps: 500,
  maxPremiumDollars: 250,
  minOpenInterest: 100,
  gammaMode: 'avoid',
  deltaWeight: 0.3,
  spreadWeight: 0.25,
  openInterestWeight: 0.2,
  gammaWeight: 0.1,
  ivWeight: 0.15,
};

async function user(prisma: InMemoryPrismaService, email: string): Promise<string> {
  return (await prisma.user.create({ data: { email, passwordHash: 'hash' } })).id;
}

function service(prisma: InMemoryPrismaService): AutoScoringPreferenceService {
  return new AutoScoringPreferenceService(prisma as unknown as PrismaService);
}

describe('AutoScoringPreferenceService', () => {
  it('materializes the Conservative v1 default on first authenticated read', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = await user(prisma, 'default-auto@example.com');
    const preferences = service(prisma);

    const first = await preferences.get(userId);
    const second = await preferences.get(userId);

    expect(first).toMatchObject(conservative);
    expect(second).toEqual(first);
    expect(prisma.autoScoringPreferences).toHaveLength(1);
  });

  it('creates custom state for one user without crossing into another', async () => {
    const prisma = new InMemoryPrismaService();
    const firstUser = await user(prisma, 'first-auto@example.com');
    const secondUser = await user(prisma, 'second-auto@example.com');
    const preferences = service(prisma);
    const custom: AutoScoringPreferenceCreate = {
      ...conservative,
      preset: 'custom',
      strikeRungs: 7,
    };

    expect(await preferences.create(firstUser, custom)).toMatchObject(custom);
    await expect(preferences.create(firstUser, custom)).rejects.toMatchObject({ status: 409 });
    expect(await preferences.get(secondUser)).toMatchObject(conservative);
    expect(prisma.autoScoringPreferences.map((row) => row.userId).sort()).toEqual(
      [firstUser, secondUser].sort(),
    );
  });

  it('updates only when expectedUpdatedAt matches and rejects a stale writer with 409', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = await user(prisma, 'conflict-auto@example.com');
    const preferences = service(prisma);
    const initial = await preferences.get(userId);
    const update: AutoScoringPreferenceUpdate = {
      ...conservative,
      preset: 'custom',
      strikeRungs: 6,
      expectedUpdatedAt: initial.updatedAt,
    };

    const changed = await preferences.update(userId, update);
    expect(changed.strikeRungs).toBe(6);
    expect(changed.updatedAt).not.toBe(initial.updatedAt);
    await expect(preferences.update(userId, { ...update, strikeRungs: 8 })).rejects.toMatchObject({
      status: 409,
      code: 'AUTO_PREFERENCE_CONFLICT',
    });
    expect((await preferences.get(userId)).strikeRungs).toBe(6);
  });

  it.each([
    { ...conservative, schemaVersion: 2 },
    { ...conservative, targetAbsDelta: 0 },
    { ...conservative, strikeRungs: 21 },
    { ...conservative, maxSpreadBps: Number.NaN },
    { ...conservative, maxPremiumDollars: 0 },
    { ...conservative, minOpenInterest: 1.5 },
    { ...conservative, gammaMode: 'neutral' },
    {
      ...conservative,
      deltaWeight: 0,
      spreadWeight: 0,
      openInterestWeight: 0,
      gammaWeight: 0,
      ivWeight: 0,
    },
  ])('rejects invalid preference persistence %#', async (candidate) => {
    const prisma = new InMemoryPrismaService();
    const userId = await user(prisma, `invalid-${Math.random()}@example.com`);
    await expect(
      service(prisma).create(userId, candidate as AutoScoringPreferenceCreate),
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.autoScoringPreferences).toHaveLength(0);
  });

  it('surfaces an unsupported stored schema version instead of interpreting it', async () => {
    const prisma = new InMemoryPrismaService();
    const userId = await user(prisma, 'version-auto@example.com');
    prisma.autoScoringPreferences.push({
      id: 'bad-version',
      userId,
      ...conservative,
      schemaVersion: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(service(prisma).get(userId)).rejects.toMatchObject({
      status: 409,
      code: 'AUTO_PREFERENCE_VERSION_UNSUPPORTED',
    });
  });
});
