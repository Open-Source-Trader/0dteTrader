import { describe, expect, it } from 'vitest';
import type {
  AutoScoringPreferenceRecord,
  AutoScoringResult,
  OptionContract,
  OptionsChain,
  Position,
} from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { ChainStore } from './ChainStore';

const EXPIRATION = '2099-01-15';
const FAR_EXPIRATION = '2099-01-22';

function contract(underlying: string, strike: number): OptionContract {
  return {
    symbol: `${underlying}${EXPIRATION.slice(2).replace(/-/g, '')}C${strike}`,
    underlying,
    expiration: EXPIRATION,
    strike,
    optionType: 'call',
    bid: 1.2,
    ask: 1.28,
    last: 1.25,
  };
}

function chainDto(underlying: string, strikes: number[], underlyingPrice = 500): OptionsChain {
  return {
    underlying,
    underlyingPrice,
    expirations: [EXPIRATION],
    contracts: strikes.map((strike) => contract(underlying, strike)),
  };
}

function contractAt(
  underlying: string,
  expiration: string,
  optionType: 'call' | 'put',
  strike: number,
): OptionContract {
  return {
    ...contract(underlying, strike),
    symbol: `${underlying}-${expiration}-${optionType}-${strike}`,
    expiration,
    optionType,
  };
}

const autoPreference: AutoScoringPreferenceRecord = {
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
  createdAt: '2026-08-05T14:00:00.000Z',
  updatedAt: '2026-08-05T14:00:00.000Z',
};

function scoredResult(winner: OptionContract): AutoScoringResult {
  return {
    selectedSymbol: winner.symbol,
    noPass: false,
    requiresConfirmation: true,
    rankedAt: '2026-08-05T14:30:00.000Z',
    exclusions: [],
    rankings: [
      {
        rank: 1,
        candidate: {
          ...winner,
          delta: 0.25,
          gamma: 0.02,
          impliedVolatility: 0.3,
          openInterest: 500,
          quoteProvider: 'webull',
          quoteTimestamp: '2026-08-05T14:29:59.000Z',
          analyticsTimestamp: '2026-08-05T14:29:30.000Z',
        },
        score: 0.9,
        rationale: {
          summary: 'winner',
          mid: 1.24,
          spreadBps: 645,
          premiumDollars: 124,
          atmDistance: 1,
          normalized: { delta: 1, spread: 1, openInterest: 1, gamma: 1, iv: 1 },
          weighted: { delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15 },
        },
      },
    ],
  };
}

interface Deferred {
  resolve: (dto: OptionsChain) => void;
}

/** ChainStore with an optionsChain stub that resolves only on command. */
function makeDeferredStore(): {
  store: ChainStore;
  pending: Map<string, Deferred>;
} {
  const pending = new Map<string, Deferred>();
  const apiClient = {
    optionsChain: (underlying: string) =>
      new Promise<OptionsChain>((resolve) => {
        pending.set(underlying, { resolve });
      }),
  } as unknown as ApiClient;
  return { store: new ChainStore(apiClient), pending };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ChainStore.load', () => {
  it('invalidates a scored winner immediately when expiration changes and hides winners while loading', async () => {
    const nearCall = contractAt('SPY', EXPIRATION, 'call', 501);
    const farCall = contractAt('SPY', FAR_EXPIRATION, 'call', 502);
    const dto: OptionsChain = {
      underlying: 'SPY',
      underlyingPrice: 500,
      expirations: [EXPIRATION, FAR_EXPIRATION],
      contracts: [nearCall, farCall],
    };
    let nextResult = scoredResult(nearCall);
    let resolvePreference: ((value: AutoScoringPreferenceRecord) => void) | null = null;
    let holdPreference = false;
    const apiClient = {
      optionsChain: async () => dto,
      autoScoringPreferences: () =>
        holdPreference
          ? new Promise<AutoScoringPreferenceRecord>((resolve) => {
              resolvePreference = resolve;
            })
          : Promise.resolve(autoPreference),
      rankAutoContracts: async () => nextResult,
    } as unknown as ApiClient;
    const store = new ChainStore(apiClient);
    await store.load('SPY');
    store.setAutoSelectionStrategy('scored');
    await store.refreshAutoScoring();
    expect(store.autoContract?.symbol).toBe(nearCall.symbol);

    holdPreference = true;
    const refreshing = store.refreshAutoScoring();
    expect(store.getState().isAutoScoringLoading).toBe(true);
    expect(store.getState().autoScoringResult).toBeNull();
    expect(store.getState().autoScoringPreferences).toBeNull();
    expect(store.autoContract).toBeNull();
    resolvePreference!(autoPreference);
    await refreshing;

    nextResult = scoredResult(farCall);
    store.selectExpiration(FAR_EXPIRATION);
    expect(store.getState().autoScoringResult).toBeNull();
    expect(store.autoContract).toBeNull();
  });

  it('never exposes a scored winner with the wrong selected option right', async () => {
    const call = contractAt('SPY', EXPIRATION, 'call', 501);
    const put = contractAt('SPY', EXPIRATION, 'put', 499);
    const dto: OptionsChain = {
      underlying: 'SPY',
      underlyingPrice: 500,
      expirations: [EXPIRATION],
      contracts: [call, put],
    };
    const apiClient = {
      optionsChain: async () => dto,
      autoScoringPreferences: async () => autoPreference,
      rankAutoContracts: async () => scoredResult(call),
    } as unknown as ApiClient;
    const store = new ChainStore(apiClient);
    await store.load('SPY');
    store.setAutoSelectionStrategy('scored');
    await store.refreshAutoScoring();

    store.setOptionType('put');
    await store.refreshAutoScoring();

    expect(store.getState().optionType).toBe('put');
    expect(store.autoContract).toBeNull();
  });

  it('invalidates an in-flight scored request immediately when the underlying changes', async () => {
    const spyWinner = contractAt('SPY', EXPIRATION, 'call', 501);
    const qqqWinner = contractAt('QQQ', EXPIRATION, 'call', 401);
    const spyDto: OptionsChain = {
      underlying: 'SPY',
      underlyingPrice: 500,
      expirations: [EXPIRATION],
      contracts: [spyWinner],
    };
    const qqqDto: OptionsChain = {
      underlying: 'QQQ',
      underlyingPrice: 400,
      expirations: [EXPIRATION],
      contracts: [qqqWinner],
    };
    let holdRank = false;
    let resolveRank: ((value: AutoScoringResult) => void) | null = null;
    let resolveQqq: ((value: OptionsChain) => void) | null = null;
    const apiClient = {
      optionsChain: (underlying: string) =>
        underlying === 'QQQ'
          ? new Promise<OptionsChain>((resolve) => {
              resolveQqq = resolve;
            })
          : Promise.resolve(spyDto),
      autoScoringPreferences: async () => autoPreference,
      rankAutoContracts: () =>
        holdRank
          ? new Promise<AutoScoringResult>((resolve) => {
              resolveRank = resolve;
            })
          : Promise.resolve(scoredResult(spyWinner)),
    } as unknown as ApiClient;
    const store = new ChainStore(apiClient);
    await store.load('SPY');
    store.setAutoSelectionStrategy('scored');
    await store.refreshAutoScoring();

    holdRank = true;
    const staleRefresh = store.refreshAutoScoring();
    await Promise.resolve();
    const qqqLoad = store.load('QQQ');
    expect(store.getState().autoScoringResult).toBeNull();
    expect(store.autoContract).toBeNull();

    resolveRank!(scoredResult(spyWinner));
    await staleRefresh;
    expect(store.getState().autoScoringResult).toBeNull();

    holdRank = false;
    resolveQqq!(qqqDto);
    await qqqLoad;
  });

  it('uses the authenticated server winner and exposes explicit no-pass fallback state', async () => {
    const dto = chainDto('SPY', [499, 501, 503], 500);
    const preference: AutoScoringPreferenceRecord = {
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
      createdAt: '2026-08-05T14:00:00.000Z',
      updatedAt: '2026-08-05T14:00:00.000Z',
    };
    const winner = dto.contracts[0];
    const result: AutoScoringResult = {
      selectedSymbol: winner.symbol,
      noPass: false,
      requiresConfirmation: true,
      rankedAt: '2026-08-05T14:30:00.000Z',
      exclusions: [],
      rankings: [
        {
          rank: 1,
          candidate: {
            ...winner,
            delta: 0.25,
            gamma: 0.02,
            impliedVolatility: 0.3,
            openInterest: 500,
            quoteProvider: 'webull',
            quoteTimestamp: '2026-08-05T14:29:59.000Z',
            analyticsTimestamp: '2026-08-05T14:29:30.000Z',
          },
          score: 0.9,
          rationale: {
            summary: 'winner',
            mid: 1.24,
            spreadBps: 645,
            premiumDollars: 124,
            atmDistance: 1,
            normalized: { delta: 1, spread: 1, openInterest: 1, gamma: 1, iv: 1 },
            weighted: { delta: 0.3, spread: 0.25, openInterest: 0.2, gamma: 0.1, iv: 0.15 },
          },
        },
      ],
    };
    let nextResult: AutoScoringResult = result;
    const apiClient = {
      optionsChain: async () => dto,
      autoScoringPreferences: async () => preference,
      rankAutoContracts: async () => nextResult,
    } as unknown as ApiClient;
    const store = new ChainStore(apiClient);
    await store.load('SPY');
    store.setAutoSelectionStrategy('scored');
    await store.refreshAutoScoring();

    expect(store.autoContract?.symbol).toBe(winner.symbol);
    expect(store.getState().autoScoringPreferences?.weights.delta).toBe(0.3);

    nextResult = {
      selectedSymbol: null,
      rankings: [],
      exclusions: [],
      noPass: true,
      requiresConfirmation: true,
      rankedAt: result.rankedAt,
    };
    await store.refreshAutoScoring();
    expect(store.autoContract).toBeNull();
    store.acknowledgeClassicFallback();
    expect(store.autoContract?.strike).toBe(503);
  });

  it('a slow earlier load cannot clobber a newer symbol change', async () => {
    const { store, pending } = makeDeferredStore();

    const first = store.load('SPY');
    const second = store.load('QQQ');
    await flushMicrotasks();

    // Resolve out of order: the newer QQQ load first, then the stale SPY one.
    pending.get('QQQ')!.resolve(chainDto('QQQ', [499, 501, 503]));
    await flushMicrotasks();
    pending.get('SPY')!.resolve(chainDto('SPY', [498, 502]));
    await Promise.all([first, second]);

    const state = store.getState();
    expect(state.underlying).toBe('QQQ');
    expect(state.chain?.underlying).toBe('QQQ');
    expect(state.isLoading).toBe(false);
  });

  it('auto strike follows the live underlying price, not the chain snapshot', async () => {
    const { store, pending } = makeDeferredStore();
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(chainDto('SPY', [499, 501, 503, 505], 500));
    await loading;

    // Snapshot price 500 → ATM 501 (equidistant tie toward OTM) → +1 is 503.
    expect(store.autoContract?.strike).toBe(503);

    // Live price crosses 502 → ATM 503 → AUTO must move to 505.
    store.setUnderlyingLast(502.5);
    expect(store.autoContract?.strike).toBe(505);
  });

  it('autoContract always uses the fixed Classic +1 rung', async () => {
    const { store, pending } = makeDeferredStore();
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(chainDto('SPY', [499, 501, 503, 505], 500));
    await loading;
    store.setUnderlyingLast(500.4);

    // ATM 501 → fixed +1 rung up the call ladder.
    expect(store.autoContract?.strike).toBe(503);
  });

  it('refresh() updates quotes and underlying price without touching selections', async () => {
    const { store, pending } = makeDeferredStore();
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(chainDto('SPY', [499, 501, 503], 500));
    await loading;
    store.setAutoMode(false);
    store.selectStrike(503);

    const refreshing = store.refresh();
    await flushMicrotasks();
    const freshDto = chainDto('SPY', [499, 501, 503], 500.4);
    freshDto.contracts = freshDto.contracts.map((contract: OptionContract) => ({
      ...contract,
      bid: 2.4,
      ask: 2.5,
    }));
    pending.get('SPY')!.resolve(freshDto);
    await refreshing;

    const state = store.getState();
    expect(state.chain?.underlyingPrice).toBe(500.4);
    expect(state.selectedExpiration).toBe(EXPIRATION);
    expect(state.selectedStrike).toBe(503);
    expect(store.selectedContract?.bid).toBe(2.4);
  });

  it('loads a chain and selects the nearest expiration and auto strike', async () => {
    const { store, pending } = makeDeferredStore();
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(chainDto('SPY', [499, 501, 503]));
    await loading;

    const state = store.getState();
    expect(state.chain?.underlying).toBe('SPY');
    expect(state.selectedExpiration).toBe(EXPIRATION);
    // ATM 501 (tie toward OTM at the 500 underlying price) → +1 OTM is 503.
    expect(state.selectedStrike).toBe(503);
  });
});

describe('ChainStore CURR mode', () => {
  const EXP2 = '2099-01-22';
  const FAR_CALL_SYMBOL = 'SPY990122C505';

  /** Near expiration calls at 499/501/503 plus one call on a far expiration. */
  function currChainDto(): OptionsChain {
    const dto = chainDto('SPY', [499, 501, 503], 500);
    dto.expirations = [EXPIRATION, EXP2];
    dto.contracts.push({
      ...contract('SPY', 505),
      symbol: FAR_CALL_SYMBOL,
      expiration: EXP2,
    });
    return dto;
  }

  function long(symbol: string, quantity: number, openedAt?: string): Position {
    return {
      symbol,
      assetClass: 'option',
      quantity,
      avgPrice: 1,
      markPrice: 1.2,
      unrealizedPnl: 10,
      multiplier: 100,
      openedAt,
    };
  }

  async function loadedCurrStore(positions: Position[]): Promise<ChainStore> {
    const { store, pending } = makeDeferredStore();
    store.positionsProvider = () => positions;
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(currChainDto());
    await loading;
    return store;
  }

  it('menus list only owned longs, and the most recent position is preselected', async () => {
    const store = await loadedCurrStore([
      long(contract('SPY', 499).symbol, 1, '2026-08-01T10:00:00Z'),
      long(FAR_CALL_SYMBOL, 1, '2026-08-01T11:00:00Z'),
      long(contract('SPY', 503).symbol, -2), // short: never CURR-selectable
      long('QQQ990115C400', 5), // not resolvable in this chain
    ]);

    store.setCurrMode(true);

    // Most recent (by openedAt) is the far call → its leg is preselected.
    expect(store.getState().selectedExpiration).toBe(EXP2);
    expect(store.getState().selectedStrike).toBe(505);
    expect(store.expirations).toEqual([EXPIRATION, EXP2]);
    expect(store.strikes).toEqual([505]);

    // Switching to the near expiration lists (and lands on) the owned 499
    // only — not the full 499/501/503 ladder.
    store.selectExpiration(EXPIRATION);
    expect(store.strikes).toEqual([499]);
    expect(store.getState().selectedStrike).toBe(499);

    // CURR off: the full chain menus come back.
    store.setCurrMode(false);
    expect(store.expirations).toEqual([EXPIRATION, EXP2]);
    expect(store.strikes).toEqual([499, 501, 503]);
  });

  it('preselect falls back to the first position when openedAt is unknown', async () => {
    const store = await loadedCurrStore([
      long(contract('SPY', 501).symbol, 1),
      long(contract('SPY', 499).symbol, 2),
    ]);

    store.setCurrMode(true);

    expect(store.getState().selectedExpiration).toBe(EXPIRATION);
    expect(store.getState().selectedStrike).toBe(501);
  });

  it('CURR and AUTO are mutually exclusive', async () => {
    const store = await loadedCurrStore([long(contract('SPY', 499).symbol, 1)]);
    expect(store.getState().isAutoMode).toBe(true);

    store.setCurrMode(true);
    expect(store.getState()).toMatchObject({ isAutoMode: false, isCurrMode: true });

    store.setAutoMode(true);
    expect(store.getState()).toMatchObject({ isAutoMode: true, isCurrMode: false });
  });

  it('hasCurrPositions requires an open long resolvable on this underlying', async () => {
    const none = await loadedCurrStore([]);
    expect(none.hasCurrPositions).toBe(false);

    const shortOnly = await loadedCurrStore([long(contract('SPY', 499).symbol, -1)]);
    expect(shortOnly.hasCurrPositions).toBe(false);

    const held = await loadedCurrStore([long(contract('SPY', 499).symbol, 1)]);
    expect(held.hasCurrPositions).toBe(true);
  });

  const PUT_SYMBOL = 'SPY990115P501';

  function currChainWithPut(): OptionsChain {
    const dto = currChainDto();
    dto.contracts.push({ ...contract('SPY', 501), symbol: PUT_SYMBOL, optionType: 'put' });
    return dto;
  }

  async function loadedMixedStore(positions: Position[]): Promise<ChainStore> {
    const { store, pending } = makeDeferredStore();
    store.positionsProvider = () => positions;
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(currChainWithPut());
    await loading;
    return store;
  }

  it('the CALL/PUT toggle picks which side CURR operates on', async () => {
    const store = await loadedMixedStore([
      long(contract('SPY', 499).symbol, 1, '2026-08-01T10:00:00Z'),
      long(PUT_SYMBOL, 2, '2026-08-01T11:00:00Z'),
    ]);

    // CALL selected: enabling CURR stays on calls even though the put is the
    // more recent position — the toggle is the user's, never overridden.
    store.setCurrMode(true);
    expect(store.getState().optionType).toBe('call');
    expect(store.strikes).toEqual([499]);
    expect(store.getState().selectedStrike).toBe(499);

    // Flip to PUT: menus and preselection move to the owned put.
    store.setOptionType('put');
    expect(store.strikes).toEqual([501]);
    expect(store.getState().selectedStrike).toBe(501);
    expect(store.selectedContract?.symbol).toBe(PUT_SYMBOL);
  });

  it('flipping to a side with nothing held clears the selection and resolves no contract', async () => {
    const store = await loadedMixedStore([long(contract('SPY', 499).symbol, 1)]);
    store.setCurrMode(true);

    store.setOptionType('put');

    expect(store.expirations).toEqual([]);
    expect(store.strikes).toEqual([]);
    expect(store.getState().selectedStrike).toBeNull();
    expect(store.selectedContract).toBeNull();
  });

  it('enabling CURR flips the side only when the toggled side has nothing held', async () => {
    const store = await loadedMixedStore([long(PUT_SYMBOL, 1)]);
    expect(store.getState().optionType).toBe('call');

    store.setCurrMode(true);

    expect(store.getState().optionType).toBe('put');
    expect(store.getState().selectedStrike).toBe(501);
  });

  it('detects holdings on expirations whose contracts are not loaded yet (OCC parse)', async () => {
    // A held leg on 2099-01-22 while only 2099-01-15's contracts are loaded:
    // the OCC symbol alone must be enough to list and preselect it.
    const occ = 'SPY990122C00510000';
    const { store, pending } = makeDeferredStore();
    store.positionsProvider = () => [long(occ, 1)];
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(chainDto('SPY', [499, 501, 503], 500));
    await loading;

    expect(store.hasCurrPositions).toBe(true);
    store.setCurrMode(true);

    expect(store.expirations).toEqual(['2099-01-22']);
    expect(store.getState().selectedExpiration).toBe('2099-01-22');
    expect(store.getState().selectedStrike).toBe(510);
    expect(store.strikes).toEqual([510]);
    expect(store.selectedContract?.symbol).toBe(occ);
  });

  it('CURR never resolves a contract that is not held, even with a stale selection', async () => {
    const store = await loadedMixedStore([long(PUT_SYMBOL, 1)]);
    // Manual (non-CURR) selection of the un-owned 499 call…
    store.setAutoMode(false);
    store.selectExpiration(EXPIRATION);
    store.selectStrike(499);
    expect(store.selectedContract?.strike).toBe(499);

    // …must not survive into CURR as a tradeable pick.
    store.setCurrMode(true);
    store.setOptionType('call');
    expect(store.selectedContract).toBeNull();
  });
});

describe('ChainStore.applyContractQuote', () => {
  it('updates only the matching contract, leaving other contract objects untouched', async () => {
    const { store, pending } = makeDeferredStore();
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(chainDto('SPY', [499, 501, 503]));
    await loading;

    const before = store.getState().chain!.contracts;
    const target = before[1];
    store.applyContractQuote({
      symbol: target.symbol,
      bid: 2.1,
      ask: 2.2,
      last: 2.15,
      bidSize: 1,
      askSize: 1,
      volume: 1,
      timestamp: new Date().toISOString(),
    });

    const after = store.getState().chain!.contracts;
    expect(after[1]).toMatchObject({ bid: 2.1, ask: 2.2, last: 2.15 });
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  it('is a no-op when the quote matches the contract already stored', async () => {
    const { store, pending } = makeDeferredStore();
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(chainDto('SPY', [499, 501, 503]));
    await loading;

    const before = store.getState().chain!;
    const target = before.contracts[1];
    store.applyContractQuote({
      symbol: target.symbol,
      bid: target.bid,
      ask: target.ask,
      last: target.last,
      bidSize: 1,
      askSize: 1,
      volume: 1,
      timestamp: new Date().toISOString(),
    });

    expect(store.getState().chain).toBe(before);
  });
});
