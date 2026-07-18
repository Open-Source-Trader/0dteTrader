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
function makeDeferredStore(): { store: ChainStore; pending: Map<string, Deferred> } {
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
    pending.get('SPY')!.resolve(chainDto('SPY', [499, 501, 503], 500));
    await loading;

    // Snapshot price 500 → +1 OTM call is 501.
    expect(store.autoContract?.strike).toBe(501);

    // Live price crosses 501 → AUTO must move to 503.
    store.setUnderlyingLast(502.5);
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
    // +1 OTM call above the 500 underlying price.
    expect(state.selectedStrike).toBe(501);
  });
});
