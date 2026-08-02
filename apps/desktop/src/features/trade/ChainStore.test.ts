import { describe, expect, it } from 'vitest';
import type { OptionContract, OptionsChain } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { ChainStore } from './ChainStore';

const EXPIRATION = '2099-01-15';

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

interface Deferred {
  resolve: (dto: OptionsChain) => void;
}

/** ChainStore with an optionsChain stub that resolves only on command. */
function makeDeferredStore(settings?: { autoOtmOffset: number }): {
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
  return { store: new ChainStore(apiClient, settings), pending };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ChainStore.load', () => {
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

  it('autoContract honors the injected AUTO-offset preference', async () => {
    const { store, pending } = makeDeferredStore({ autoOtmOffset: 2 });
    const loading = store.load('SPY');
    await flushMicrotasks();
    pending.get('SPY')!.resolve(chainDto('SPY', [499, 501, 503, 505], 500));
    await loading;
    store.setUnderlyingLast(500.4);

    // ATM 501 → +2 rungs up the call ladder.
    expect(store.autoOtmOffset).toBe(2);
    expect(store.autoContract?.strike).toBe(505);
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
