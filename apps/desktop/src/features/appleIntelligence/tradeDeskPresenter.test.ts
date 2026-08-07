import { describe, expect, it } from 'vitest';
import {
  buildFlatTradeDeskAnalysis,
  buildTradeDeskViewState,
  buildUnavailableTradeDeskAnalysis,
} from './tradeDeskPresenter';
import type {
  AIAvailability,
  AnalysisContextIdentity,
  AnalysisDiscard,
  AnalysisResult,
} from './types';
import type { OptionContract } from '@0dtetrader/shared-types';

const availability: AIAvailability = { state: 'ready' };
const contract: OptionContract = {
  symbol: 'SPY260731C00746000',
  underlying: 'SPY',
  expiration: '2026-07-31',
  strike: 746,
  optionType: 'call',
  bid: 1.8,
  ask: 1.9,
  last: 1.85,
};
const context: AnalysisContextIdentity = {
  snapshotId: 'snap-1',
  symbol: 'SPY',
  timeframe: '1m',
  snapshotSequence: 7,
  positionVersion: 0,
  selectedContractSymbol: contract.symbol,
};

function result(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    resultSchemaVersion: 1,
    analysisId: 'result-1',
    context,
    generatedAt: '2026-07-31T14:30:00.000Z',
    recommendation: 'wait',
    setupState: 'forming',
    bias: 'bullish',
    levels: {},
    confidence: 0.72,
    reasons: [],
    warnings: ['Spread is widening', 'Volume light', 'Ignored third warning'],
    assumptions: [],
    observedOmissions: [],
    summary: 'Momentum intact; current premium is above preferred entry and needs a pullback.',
    tradeDeskPlan: {
      action: 'wait',
      setupLifecycle: 'developing',
      setupLabel: 'Bullish pullback wait-for-entry continuation setup label that is very long',
      summary:
        'Momentum intact; current premium is above preferred entry. This sentence is intentionally long enough to verify presentation clamping by deterministic presenter.',
      entry: {
        underlying: {
          low: 746.55,
          high: 746.65,
          priceDomain: 'underlying',
          evidenceId: 'e-underlying-entry',
          snapshotId: 'snap-1',
        },
        contract: {
          low: 1.82,
          high: 1.88,
          priceDomain: 'contract-premium',
          evidenceId: 'e-contract-entry',
          snapshotId: 'snap-1',
        },
        preferredContractPrice: {
          value: 1.85,
          priceDomain: 'contract-premium',
          evidenceId: 'e-preferred',
          snapshotId: 'snap-1',
        },
      },
      invalidation: {
        underlying: {
          operator: 'below',
          price: {
            value: 746.28,
            priceDomain: 'underlying',
            evidenceId: 'e-underlying-invalid',
            snapshotId: 'snap-1',
          },
        },
        contract: {
          operator: 'below',
          price: {
            value: 1.66,
            priceDomain: 'contract-premium',
            evidenceId: 'e-contract-invalid',
            snapshotId: 'snap-1',
          },
        },
      },
      targets: {
        contract: [
          {
            role: 'first',
            price: {
              value: 2.15,
              priceDomain: 'contract-premium',
              evidenceId: 'e-t1',
              snapshotId: 'snap-1',
            },
          },
          {
            role: 'runner',
            price: {
              value: 2.38,
              priceDomain: 'contract-premium',
              evidenceId: 'e-t2',
              snapshotId: 'snap-1',
            },
          },
          {
            role: 'final',
            price: {
              value: 2.6,
              priceDomain: 'contract-premium',
              evidenceId: 'e-t3',
              snapshotId: 'snap-1',
            },
          },
          {
            role: 'final',
            price: {
              value: 2.9,
              priceDomain: 'contract-premium',
              evidenceId: 'e-t4',
              snapshotId: 'snap-1',
            },
          },
        ],
        underlying: [
          {
            role: 'first',
            price: {
              value: 747.1,
              priceDomain: 'underlying',
              evidenceId: 'e-u1',
              snapshotId: 'snap-1',
            },
          },
          {
            role: 'runner',
            price: {
              value: 747.8,
              priceDomain: 'underlying',
              evidenceId: 'e-u2',
              snapshotId: 'snap-1',
            },
          },
        ],
      },
      management: {
        holdConditions: ['Hold above VWAP', 'Hold while bid stays firm', 'Ignored hold'],
        scaleConditions: ['Scale only on reclaim', 'Scale out into target'],
        exitConditions: ['Cut on failed reclaim'],
      },
      warnings: ['Spread is widening', 'Volume light', 'Ignored warning'],
      confidence: 'high',
    },
    ...overrides,
  };
}

function discard(overrides: Partial<AnalysisDiscard> = {}): AnalysisDiscard {
  return {
    code: 'runtime-failed',
    message: 'boom',
    requestId: 'req-1',
    fingerprint: null,
    symbol: context.symbol,
    timeframe: context.timeframe,
    selectedContractSymbol: context.selectedContractSymbol,
    positionVersion: context.positionVersion,
    occurredAt: '2026-07-31T14:30:00.000Z',
    ...overrides,
  };
}

function current(overrides = {}) {
  return buildTradeDeskViewState({
    availability,
    isAnalyzing: false,
    latestResult: result(),
    lastDiscard: null,
    currentContext: context,
    selectedContract: contract,
    currentPositionVersion: 0,
    ...overrides,
  });
}

describe('buildTradeDeskViewState', () => {
  it('produces stable output for identical input', () => {
    expect(current()).toEqual(current());
  });

  it('maps primary actions and normalizes scale direction', () => {
    expect(
      current({
        latestResult: result({ tradeDeskPlan: { ...result().tradeDeskPlan!, action: 'enter' } }),
      }).presentation?.actionLabel,
    ).toBe('ENTER');
    expect(
      current({
        latestResult: result({
          tradeDeskPlan: {
            ...result().tradeDeskPlan!,
            action: 'scale',
            scaleAdvice: { direction: 'in', condition: 'Only above high' },
          },
        }),
      }).presentation?.actionLabel,
    ).toBe('SCALE IN');
    expect(
      current({
        latestResult: result({
          tradeDeskPlan: {
            ...result().tradeDeskPlan!,
            action: 'scale',
            scaleAdvice: { direction: 'out', condition: 'Into first target' },
          },
        }),
      }).presentation?.actionLabel,
    ).toBe('SCALE OUT');
  });

  it('defaults an unsatisfied scale action (no scaleAdvice) to WAIT, never SCALE OUT', () => {
    // enforceTradeDeskInvariants normally downgrades this before the
    // presenter sees it, but normalizeAction itself must not assume 'out'
    // just because scaleAdvice is missing — that would silently surface the
    // opposite of a scale-in recommendation if this path is ever reached
    // through validation being bypassed or a different code path.
    const { tradeDeskPlan, ...rest } = result();
    expect(
      current({
        latestResult: {
          ...rest,
          tradeDeskPlan: { ...tradeDeskPlan!, action: 'scale', scaleAdvice: undefined },
        },
      }).presentation?.actionLabel,
    ).toBe('WAIT');
  });

  it('keeps underlying and contract price domains separated', () => {
    const presentation = current().presentation!;
    expect(presentation.entry?.underlying?.value).toBe('SPY 746.55–746.65');
    expect(presentation.entry?.contract?.value).toBe('$1.82–$1.88');
    expect(presentation.invalidation?.contract?.value).toBe('Contract below $1.66');
  });

  it('preserves explicit target roles and clamps targets, management, and warnings', () => {
    const presentation = current().presentation!;
    expect(presentation.contractTargets.map((target) => target.label)).toEqual([
      'First',
      'Runner',
      'Final',
    ]);
    expect(presentation.underlyingTargets).toHaveLength(2);
    expect(presentation.management.holdConditions).toEqual([
      'Hold above VWAP',
      'Hold while bid stays firm',
    ]);
    expect(presentation.warnings).toEqual(['Spread is widening', 'Volume light']);
    expect(presentation.setupLabel.length).toBeLessThanOrEqual(48);
    expect(presentation.summary.length).toBeLessThanOrEqual(140);
  });

  it('handles missing optional trade desk fields via legacy structured result fields', () => {
    const legacy = result({ tradeDeskPlan: undefined, recommendation: 'hold', confidence: 0.4 });
    const view = current({ latestResult: legacy });
    expect(view.presentation?.actionLabel).toBe('HOLD');
    expect(view.presentation?.confidence).toBe('medium');
    expect(view.presentation?.applicablePriceSuggestion).toBeUndefined();
  });

  it('reports generating, stale, failed, unavailable, and disabled states', () => {
    expect(current({ isAnalyzing: true }).status).toBe('generating');
    expect(
      current({ currentContext: { ...context, selectedContractSymbol: 'OTHER' } }).status,
    ).toBe('stale');
    expect(current({ lastDiscard: discard() }).status).toBe('failed');
    expect(
      current({ availability: { state: 'unavailable', reason: 'off' }, latestResult: null }).status,
    ).toBe('unavailable');
    expect(current({ disabled: true }).status).toBe('disabled');
  });

  it('creates applicable price suggestions only when safe', () => {
    const suggestion = current().presentation?.applicablePriceSuggestion;
    expect(suggestion).toMatchObject({
      price: 1.85,
      priceDomain: 'contract-premium',
      contractIdentity: contract.symbol,
    });
    expect(
      current({ selectedContract: { ...contract, symbol: 'OTHER' } }).presentation
        ?.applicablePriceSuggestion,
    ).toBeUndefined();
    expect(
      current({
        latestResult: result({
          tradeDeskPlan: {
            ...result().tradeDeskPlan!,
            entry: {
              ...result().tradeDeskPlan!.entry!,
              preferredContractPrice: {
                value: 746.55,
                priceDomain: 'underlying',
                evidenceId: 'bad',
                snapshotId: 'snap-1',
              },
            },
          },
        }),
      }).presentation?.applicablePriceSuggestion,
    ).toBeUndefined();
  });

  it('defaults marketSessionState to live when the caller does not supply one', () => {
    expect(current().marketSessionState).toBe('live');
  });

  it('threads a supplied marketSessionState through', () => {
    expect(current({ marketSessionState: 'market-closed' }).marketSessionState).toBe(
      'market-closed',
    );
  });

  it('disables the applicable price suggestion when the market is closed, even for a current result', () => {
    const state = current({ marketSessionState: 'market-closed' });
    expect(state.status).toBe('current');
    expect(state.presentation?.applicablePriceSuggestion).toBeDefined();
    expect(state.canApplySuggestedPrice).toBe(false);
  });

  it('allows the applicable price suggestion when the market is live', () => {
    const state = current({ marketSessionState: 'live' });
    expect(state.canApplySuggestedPrice).toBe(true);
  });

  it('agrees the action badge and the applicable price suggestion when a plan is present (the ENTER/NO ENTRY PRICE repro)', () => {
    const state = current({
      latestResult: result({
        tradeDeskPlan: { ...result().tradeDeskPlan!, action: 'enter' },
      }),
    });
    expect(state.presentation?.action).toBe('enter');
    expect(state.presentation?.applicablePriceSuggestion).toBeDefined();
    expect(state.canApplySuggestedPrice).toBe(true);
  });

  it('does not backfill a missing plan sub-field from legacy top-level levels when a plan is present', () => {
    const withoutEntry = current({
      latestResult: result({
        tradeDeskPlan: { ...result().tradeDeskPlan!, entry: undefined },
        levels: { support: { levelId: 'lvl-1', price: 400 } },
      }),
    });
    expect(withoutEntry.presentation?.entry).toBeUndefined();
  });

  it('falls back to legacy fields together when no plan is present at all', () => {
    const legacyOnly = current({
      latestResult: result({
        tradeDeskPlan: undefined,
        recommendation: 'enter',
        levels: {
          support: { levelId: 'lvl-1', price: 746.55 },
          cutBelow: { levelId: 'lvl-2', price: 746.28 },
        },
      }),
    });
    expect(legacyOnly.presentation?.action).toBe('enter');
    expect(legacyOnly.presentation?.entry?.underlying).toBeDefined();
    expect(legacyOnly.presentation?.invalidation?.underlying).toBeDefined();
    // Legacy path never has a preferredContractPrice source, so no
    // applicable suggestion — action and suggestion still agree (both
    // absent), never split.
    expect(legacyOnly.presentation?.applicablePriceSuggestion).toBeUndefined();
  });

  it('has no pendingActionChange when nothing is pending', () => {
    expect(current().pendingActionChange).toBeUndefined();
  });

  it('surfaces a pendingActionChange without altering the primary action badge', () => {
    const state = current({ pendingActionChange: { action: 'exit' } });
    expect(state.pendingActionChange).toEqual({ action: 'exit', label: 'EXIT' });
    // The badge itself still reflects the held/confirmed result's action,
    // not the pending candidate.
    expect(state.presentation?.action).toBe(result().tradeDeskPlan!.action);
  });

  it('reports unavailable with a mapped reason when the last request was ineligible and there is no prior result', () => {
    const state = current({
      latestResult: null,
      ineligibility: { reason: 'invalid-underlying-quote', userMessage: 'Bad quote.' },
    });
    expect(state.status).toBe('unavailable');
    expect(state.unavailableReason).toBe('invalid-underlying-quote');
  });

  it('maps invalid-selected-contract-quote to the invalid-options-analytics UI reason', () => {
    const state = current({
      latestResult: null,
      ineligibility: {
        reason: 'invalid-selected-contract-quote',
        userMessage: 'Bad contract quote.',
      },
    });
    expect(state.unavailableReason).toBe('invalid-options-analytics');
  });

  it('prefers a still-valid prior presentation over a fresh ineligibility rejection', () => {
    const state = current({
      ineligibility: { reason: 'invalid-underlying-quote', userMessage: 'Bad quote.' },
    });
    expect(state.status).toBe('current');
    expect(state.presentation).toBeDefined();
  });

  it('no prior valid analysis renders the specific discard reason, not a generic unavailable', () => {
    const state = current({
      latestResult: null,
      lastDiscard: discard({
        code: 'ungrounded-plan',
        message: 'Plan referenced an unknown level.',
      }),
    });
    expect(state.status).toBe('unavailable');
    expect(state.unavailableReason).toBe('analysis-incomplete');
    expect(state.staleReason).toBe('Plan referenced an unknown level.');
  });

  it('a matching failed result preserves the prior valid presentation and exposes a compact warning', () => {
    const state = current({ lastDiscard: discard() });
    expect(state.status).toBe('failed');
    expect(state.presentation).toBeDefined();
    expect(state.staleReason).toBe('boom');
  });

  it('an unrelated (different-instrument) discard does not downgrade a current valid presentation', () => {
    const state = current({ lastDiscard: discard({ symbol: 'AAPL' }) });
    expect(state.status).toBe('current');
    expect(state.presentation).toBeDefined();
  });
});

describe('buildFlatTradeDeskAnalysis contract-cell gating', () => {
  it('renders the CONTRACT cell when the plan carries contract-premium guidance', () => {
    const presentation = current().presentation!;
    const analysis = buildFlatTradeDeskAnalysis(presentation, contract);
    expect(analysis.contract.value).toBe('SPY 746C');
  });

  it('renders — for CONTRACT when a contract is selected but the plan has no contract guidance', () => {
    const legacy = result({ tradeDeskPlan: undefined, recommendation: 'wait' });
    const presentation = current({ latestResult: legacy }).presentation!;
    // A contract is selected (module-level `contract` fixture), but the
    // legacy-fallback presentation never populates entry.contract/
    // preferredContractPrice — the CONTRACT cell must not fall back to the
    // selected contract's label, since that's the exact "selected contract
    // rendered as if it were AI guidance" bug this gating exists to prevent.
    const analysis = buildFlatTradeDeskAnalysis(presentation, contract);
    expect(analysis.contract.value).toBe('—');
  });
});

describe('buildUnavailableTradeDeskAnalysis', () => {
  it('renders all eight cells bounded, with a curated EXECUTION reason and no raw diagnostics', () => {
    const analysis = buildUnavailableTradeDeskAnalysis('invalid-options-analytics');
    expect(analysis.execution.value).toBe('Invalid option data');
    expect(analysis.entry.value).toBe('—');
    expect(analysis.invalidation.value).toBe('—');
    expect(analysis.targets.value).toBe('—');
    expect(analysis.contract.value).toBe('—');
    expect(analysis.premiumLimit.value).toBe('—');
    expect(analysis.runner.value).toBe('—');
  });

  it('maps each unavailable reason to a distinct short EXECUTION line', () => {
    expect(buildUnavailableTradeDeskAnalysis('invalid-underlying-quote').execution.value).toBe(
      'Invalid underlying quote',
    );
    expect(buildUnavailableTradeDeskAnalysis('insufficient-data').execution.value).toBe(
      'Insufficient data',
    );
    expect(buildUnavailableTradeDeskAnalysis(undefined).execution.value).toBe('Data unavailable');
  });
});

describe('setup-lifecycle-aware execution line and SETUP cell', () => {
  function waitResultWithLifecycle(
    setupLifecycle: NonNullable<AnalysisResult['tradeDeskPlan']>['setupLifecycle'],
    setupLabel = 'Bullish reversal',
  ): AnalysisResult {
    return result({
      tradeDeskPlan: {
        action: 'wait',
        setupLifecycle,
        setupLabel,
        summary: 'Setup evolving.',
        targets: { contract: [] },
        management: { holdConditions: [], scaleConditions: [], exitConditions: [] },
      },
    });
  }

  it('renders EXECUTION "Wait" for a plain no-setup wait', () => {
    const presentation = current({
      latestResult: waitResultWithLifecycle('none', 'No confirmed setup'),
    }).presentation!;
    const analysis = buildFlatTradeDeskAnalysis(presentation, contract);
    expect(analysis.execution.value).toBe('Wait');
    expect(analysis.setup.secondary).toBeUndefined();
  });

  it('renders EXECUTION "Wait for setup" for a developing setup', () => {
    const presentation = current({
      latestResult: waitResultWithLifecycle('developing'),
    }).presentation!;
    const analysis = buildFlatTradeDeskAnalysis(presentation, contract);
    expect(analysis.execution.value).toBe('Wait for setup');
    expect(analysis.setup.value).toBe('Bullish reversal');
    expect(analysis.setup.secondary).toBe('DEVELOPING');
  });

  it('renders EXECUTION "Do not chase" for an extended setup — the reported regression', () => {
    const presentation = current({
      latestResult: waitResultWithLifecycle('extended'),
    }).presentation!;
    const analysis = buildFlatTradeDeskAnalysis(presentation, contract);
    expect(analysis.setup.value).toBe('Bullish reversal');
    expect(analysis.setup.secondary).toBe('EXTENDED');
    expect(analysis.execution.value).toBe('Do not chase');
  });

  it('renders EXECUTION "Setup invalidated" for an invalidated setup', () => {
    const presentation = current({
      latestResult: waitResultWithLifecycle('invalidated'),
    }).presentation!;
    const analysis = buildFlatTradeDeskAnalysis(presentation, contract);
    expect(analysis.execution.value).toBe('Setup invalidated');
    expect(analysis.setup.secondary).toBe('INVALIDATED');
  });

  it('renders EXECUTION "Setup complete" for a completed setup', () => {
    const presentation = current({
      latestResult: waitResultWithLifecycle('completed'),
    }).presentation!;
    const analysis = buildFlatTradeDeskAnalysis(presentation, contract);
    expect(analysis.execution.value).toBe('Setup complete');
  });

  it('never claims "Confirm and enter" for triggered/confirmed with no entry data — defense in depth for the second reported regression', () => {
    // validation.ts's hasValidSetupLifecycleEvidence should already prevent
    // this shape from reaching the presenter, but the presenter stays
    // defensive rather than assuming that upstream guarantee always holds.
    for (const lifecycle of ['triggered', 'confirmed'] as const) {
      const presentation = current({
        latestResult: waitResultWithLifecycle(lifecycle),
      }).presentation!;
      const analysis = buildFlatTradeDeskAnalysis(presentation, contract);
      expect(analysis.execution.value).not.toBe('Confirm and enter');
      expect(analysis.execution.value).toBe('Wait for setup');
    }
  });

  it('renders EXECUTION "Confirm and enter" for triggered with real entry data', () => {
    const base = waitResultWithLifecycle('triggered');
    const withEntry: AnalysisResult = {
      ...base,
      tradeDeskPlan: {
        ...base.tradeDeskPlan!,
        entry: {
          preferredContractPrice: {
            value: 1.85,
            priceDomain: 'contract-premium',
            evidenceId: 'e1',
            snapshotId: 'snap-1',
          },
        },
      },
    };
    const presentation = current({ latestResult: withEntry }).presentation!;
    const analysis = buildFlatTradeDeskAnalysis(presentation, contract);
    expect(analysis.execution.value).toBe('Confirm and enter');
  });
});
