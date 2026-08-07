import type {
  AutoScoringCandidate,
  AutoScoringExclusionReason,
  AutoScoringPreferenceRecord,
  AutoScoringPreferences,
  AutoScoringResult,
  BrokerProvider,
  OptionType,
  OptionContract,
  OptionsAnalyticsStrikeLeg,
} from '@0dtetrader/shared-types';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { BROKER_GATEWAY, type BrokerGateway } from '../broker/broker-gateway.interface';
import { OptionsAnalyticsService } from '../options-analytics/options-analytics.service';
import { AutoScoringPreferenceService } from './auto-scoring-preference.service';
import { scoreAutoContracts } from './auto-contract-scorer';

export interface AutoCandidatesRequest {
  underlying: string;
  expiration: string;
  optionType: OptionType;
}

export interface AutoCandidateRankingContext {
  result: AutoScoringResult;
  selectedContract: OptionContract | null;
  underlyingPrice: number;
}

export interface AutoCandidatesMetrics {
  requests: number;
  candidates: number;
  eligible: number;
  excluded: number;
  noPass: number;
  exclusionCounts: Partial<Record<AutoScoringExclusionReason, number>>;
}

@Injectable()
export class AutoCandidatesService {
  private readonly logger = new Logger(AutoCandidatesService.name);
  readonly metrics: AutoCandidatesMetrics = {
    requests: 0,
    candidates: 0,
    eligible: 0,
    excluded: 0,
    noPass: 0,
    exclusionCounts: {},
  };

  constructor(
    @Inject(BROKER_GATEWAY) private readonly broker: BrokerGateway,
    private readonly analytics: OptionsAnalyticsService,
    private readonly preferenceService: AutoScoringPreferenceService,
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  async rank(
    userId: string,
    request: AutoCandidatesRequest,
    overridePreferences?: AutoScoringPreferences,
  ): Promise<AutoScoringResult> {
    return (await this.rankResolved(userId, request, overridePreferences)).result;
  }

  async rankResolved(
    userId: string,
    request: AutoCandidatesRequest,
    overridePreferences?: AutoScoringPreferences,
  ): Promise<AutoCandidateRankingContext> {
    this.metrics.requests += 1;
    const underlying = request.underlying.trim().toUpperCase();
    const [chain, snapshot, executionScope, stored] = await Promise.all([
      this.broker.getOptionsChain(userId, underlying, request.expiration),
      this.analytics.getSnapshot(underlying, request.expiration, userId),
      this.broker.executionScope?.(userId),
      overridePreferences ? Promise.resolve(null) : this.preferenceService.get(userId),
    ]);
    if (
      chain.underlying.trim().toUpperCase() !== underlying ||
      chain.contractsExpiration !== request.expiration ||
      snapshot.scope.symbol.trim().toUpperCase() !== underlying ||
      snapshot.scope.expiration !== request.expiration
    ) {
      throw new Error('Active-broker chain or analytics scope does not match the Auto request.');
    }
    const quoteProvider = executionScope?.provider;
    if (!quoteProvider) throw new Error('Active broker provider is unavailable.');
    const preferences = overridePreferences ?? fromRecord(stored!);
    const legs = new Map<
      string,
      { call: OptionsAnalyticsStrikeLeg | null; put: OptionsAnalyticsStrikeLeg | null }
    >(
      snapshot.strikes.map((strike) => [
        strike.strike.toString(),
        { call: strike.call, put: strike.put },
      ]),
    );
    const candidates: AutoScoringCandidate[] = chain.contracts.map((contract) => {
      const byType = legs.get(contract.strike.toString());
      const leg = contract.optionType === 'call' ? byType?.call : byType?.put;
      return {
        symbol: contract.symbol,
        underlying: contract.underlying,
        expiration: contract.expiration,
        optionType: contract.optionType,
        strike: contract.strike,
        bid: contract.bid,
        ask: contract.ask,
        delta: leg?.delta ?? null,
        gamma: leg?.gamma ?? null,
        impliedVolatility: leg?.impliedVolatility ?? null,
        openInterest: leg?.openInterest ?? null,
        quoteProvider: quoteProvider as BrokerProvider,
        quoteTimestamp: contract.quoteTimestamp ?? null,
        analyticsTimestamp: snapshot.scope.observedAt,
      };
    });
    const result = scoreAutoContracts(
      {
        underlying,
        expiration: request.expiration,
        optionType: request.optionType,
        spot: chain.underlyingPrice,
      },
      preferences,
      candidates,
      this.now(),
    );
    const exclusionCounts: Partial<Record<AutoScoringExclusionReason, number>> = {};
    for (const exclusion of result.exclusions) {
      exclusionCounts[exclusion.reason] = (exclusionCounts[exclusion.reason] ?? 0) + 1;
      this.metrics.exclusionCounts[exclusion.reason] =
        (this.metrics.exclusionCounts[exclusion.reason] ?? 0) + 1;
    }
    this.metrics.candidates += candidates.length;
    this.metrics.eligible += result.rankings.length;
    this.metrics.excluded += result.exclusions.length;
    if (result.noPass) this.metrics.noPass += 1;
    this.logger.log(
      JSON.stringify({
        event: 'auto_candidates_ranked',
        userId,
        underlying,
        expiration: request.expiration,
        optionType: request.optionType,
        candidateCount: candidates.length,
        eligibleCount: result.rankings.length,
        excludedCount: result.exclusions.length,
        exclusionCounts,
        noPass: result.noPass,
        selectedSymbol: result.selectedSymbol,
      }),
    );
    return {
      result,
      selectedContract:
        result.selectedSymbol === null
          ? null
          : (chain.contracts.find((contract) => contract.symbol === result.selectedSymbol) ?? null),
      underlyingPrice: chain.underlyingPrice,
    };
  }
}

function fromRecord(record: AutoScoringPreferenceRecord): AutoScoringPreferences {
  return {
    schemaVersion: record.schemaVersion,
    preset: record.preset,
    targetAbsDelta: record.targetAbsDelta,
    strikeRungs: record.strikeRungs,
    maxSpreadBps: record.maxSpreadBps,
    maxPremiumDollars: record.maxPremiumDollars,
    minOpenInterest: record.minOpenInterest,
    gammaMode: record.gammaMode,
    weights: {
      delta: record.deltaWeight,
      spread: record.spreadWeight,
      openInterest: record.openInterestWeight,
      gamma: record.gammaWeight,
      iv: record.ivWeight,
    },
  };
}
