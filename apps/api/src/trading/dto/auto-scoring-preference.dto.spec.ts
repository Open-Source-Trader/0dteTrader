import { ValidationPipe } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import {
  AutoScoringPreferenceCreateDto,
  AutoScoringPreferenceUpdateDto,
  AUTO_PREFERENCE_VALIDATION_PIPE,
} from './auto-scoring-preference.dto';

const valid = {
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

const metadata = (metatype: typeof AutoScoringPreferenceCreateDto): ArgumentMetadata => ({
  type: 'body',
  metatype,
  data: undefined,
});

describe('Auto scoring preference DTOs', () => {
  it('accepts exact valid create and update payloads', async () => {
    const pipe = AUTO_PREFERENCE_VALIDATION_PIPE as ValidationPipe;
    await expect(pipe.transform(valid, metadata(AutoScoringPreferenceCreateDto))).resolves.toEqual(
      expect.objectContaining(valid),
    );
    await expect(
      pipe.transform(
        { ...valid, expectedUpdatedAt: '2026-08-05T15:00:00.000Z' },
        metadata(AutoScoringPreferenceUpdateDto),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        ...valid,
        expectedUpdatedAt: '2026-08-05T15:00:00.000Z',
      }),
    );
  });

  it('rejects unknown fields instead of silently stripping them', async () => {
    const pipe = AUTO_PREFERENCE_VALIDATION_PIPE as ValidationPipe;
    await expect(
      pipe.transform({ ...valid, hiddenBypass: true }, metadata(AutoScoringPreferenceCreateDto)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    { ...valid, schemaVersion: 2 },
    { ...valid, preset: 'fast' },
    { ...valid, targetAbsDelta: Number.NaN },
    { ...valid, strikeRungs: 1.5 },
    { ...valid, maxPremiumDollars: 0 },
    { ...valid, minOpenInterest: -1 },
    { ...valid, gammaMode: 'neutral' },
    { ...valid, deltaWeight: 2 },
  ])('rejects invalid create DTO %#', async (value) => {
    const pipe = AUTO_PREFERENCE_VALIDATION_PIPE as ValidationPipe;
    await expect(
      pipe.transform(value, metadata(AutoScoringPreferenceCreateDto)),
    ).rejects.toBeDefined();
  });
});
