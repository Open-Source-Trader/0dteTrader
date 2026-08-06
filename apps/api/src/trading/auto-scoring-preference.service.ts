import type {
  AutoScoringPreferenceCreate,
  AutoScoringPreferenceRecord,
  AutoScoringPreferenceUpdate,
  AutoScoringPreferences,
} from '@0dtetrader/shared-types';
import { Injectable } from '@nestjs/common';
import type { AutoScoringPreference } from '@prisma/client';
import { errors, isUniqueViolation } from '../common/api-exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  CONSERVATIVE_AUTO_SCORING_PRESET,
  validateAutoScoringPreferences,
} from './auto-contract-scorer';

const DEFAULT_CREATE: AutoScoringPreferenceCreate = {
  schemaVersion: 1,
  preset: CONSERVATIVE_AUTO_SCORING_PRESET.preset,
  targetAbsDelta: CONSERVATIVE_AUTO_SCORING_PRESET.targetAbsDelta,
  strikeRungs: CONSERVATIVE_AUTO_SCORING_PRESET.strikeRungs,
  maxSpreadBps: CONSERVATIVE_AUTO_SCORING_PRESET.maxSpreadBps,
  maxPremiumDollars: CONSERVATIVE_AUTO_SCORING_PRESET.maxPremiumDollars,
  minOpenInterest: CONSERVATIVE_AUTO_SCORING_PRESET.minOpenInterest,
  gammaMode: CONSERVATIVE_AUTO_SCORING_PRESET.gammaMode,
  deltaWeight: CONSERVATIVE_AUTO_SCORING_PRESET.weights.delta,
  spreadWeight: CONSERVATIVE_AUTO_SCORING_PRESET.weights.spread,
  openInterestWeight: CONSERVATIVE_AUTO_SCORING_PRESET.weights.openInterest,
  gammaWeight: CONSERVATIVE_AUTO_SCORING_PRESET.weights.gamma,
  ivWeight: CONSERVATIVE_AUTO_SCORING_PRESET.weights.iv,
};

@Injectable()
export class AutoScoringPreferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<AutoScoringPreferenceRecord> {
    const existing = await this.prisma.autoScoringPreference.findUnique({ where: { userId } });
    if (existing) return record(existing);
    try {
      return record(
        await this.prisma.autoScoringPreference.create({
          data: { userId, ...DEFAULT_CREATE },
        }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.autoScoringPreference.findUnique({ where: { userId } });
      if (!raced) throw error;
      return record(raced);
    }
  }

  async create(
    userId: string,
    input: AutoScoringPreferenceCreate,
  ): Promise<AutoScoringPreferenceRecord> {
    validateCreate(input);
    try {
      return record(await this.prisma.autoScoringPreference.create({ data: { userId, ...input } }));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw errors.conflict(
          'AUTO_PREFERENCE_EXISTS',
          'Auto scoring preferences already exist for this user.',
        );
      }
      throw error;
    }
  }

  async update(
    userId: string,
    input: AutoScoringPreferenceUpdate,
  ): Promise<AutoScoringPreferenceRecord> {
    const expectedUpdatedAt = new Date(input.expectedUpdatedAt);
    if (!Number.isFinite(expectedUpdatedAt.getTime())) {
      throw errors.validation('expectedUpdatedAt must be an ISO-8601 timestamp.');
    }
    const { expectedUpdatedAt: _expectedUpdatedAt, ...next } = input;
    validateCreate(next);
    const updatedAt = new Date(Math.max(Date.now(), expectedUpdatedAt.getTime() + 1));
    const changed = await this.prisma.autoScoringPreference.updateMany({
      where: { userId, updatedAt: expectedUpdatedAt },
      data: { ...next, updatedAt },
    });
    if (changed.count !== 1) {
      throw errors.conflict(
        'AUTO_PREFERENCE_CONFLICT',
        'Auto scoring preferences changed; reload before saving again.',
      );
    }
    const row = await this.prisma.autoScoringPreference.findUnique({ where: { userId } });
    if (!row) throw new Error('Updated Auto scoring preference is missing.');
    return record(row);
  }
}

function validateCreate(input: AutoScoringPreferenceCreate): void {
  try {
    validateAutoScoringPreferences(toNested(input));
  } catch (error) {
    throw errors.validation(error instanceof Error ? error.message : 'Invalid Auto preferences.');
  }
}

function toNested(input: AutoScoringPreferenceCreate): AutoScoringPreferences {
  return {
    schemaVersion: input.schemaVersion,
    preset: input.preset,
    targetAbsDelta: input.targetAbsDelta,
    strikeRungs: input.strikeRungs,
    maxSpreadBps: input.maxSpreadBps,
    maxPremiumDollars: input.maxPremiumDollars,
    minOpenInterest: input.minOpenInterest,
    gammaMode: input.gammaMode,
    weights: {
      delta: input.deltaWeight,
      spread: input.spreadWeight,
      openInterest: input.openInterestWeight,
      gamma: input.gammaWeight,
      iv: input.ivWeight,
    },
  };
}

function record(row: AutoScoringPreference): AutoScoringPreferenceRecord {
  if (row.schemaVersion !== 1) {
    throw errors.conflict(
      'AUTO_PREFERENCE_VERSION_UNSUPPORTED',
      `Unsupported Auto scoring preference version ${row.schemaVersion}.`,
    );
  }
  const value: AutoScoringPreferenceRecord = {
    schemaVersion: 1,
    preset: row.preset as AutoScoringPreferenceRecord['preset'],
    targetAbsDelta: row.targetAbsDelta,
    strikeRungs: row.strikeRungs,
    maxSpreadBps: row.maxSpreadBps,
    maxPremiumDollars: row.maxPremiumDollars,
    minOpenInterest: row.minOpenInterest,
    gammaMode: row.gammaMode as AutoScoringPreferenceRecord['gammaMode'],
    deltaWeight: row.deltaWeight,
    spreadWeight: row.spreadWeight,
    openInterestWeight: row.openInterestWeight,
    gammaWeight: row.gammaWeight,
    ivWeight: row.ivWeight,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  validateCreate(value);
  return value;
}
