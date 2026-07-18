import { describe, expect, it } from 'vitest';
import type { FuturesContract } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import type { ChainStore } from './ChainStore';
import { TradeStore } from './TradeStore';

const MES_CONTRACTS: FuturesContract[] = [
  {
    symbol: 'MESU26',
    root: 'MES',
    expiration: '2026-09-18',
    frontMonth: true,
    bid: 6010.25,
    ask: 6010.75,
    last: 6010.5,
  },
];

function makeStore(): TradeStore {
  const apiClient = {
    futures: async () => MES_CONTRACTS,
    previewOrder: async () => {
      throw new Error('preview unavailable in test');
    },
  } as unknown as ApiClient;
  return new TradeStore(apiClient);
}

describe('TradeStore.setQuantity', () => {
  it('clamps to the server-accepted range [1, 1000]', () => {
    const store = makeStore();
    store.setQuantity(0);
    expect(store.getState().quantity).toBe(1);
    store.setQuantity(5000);
    expect(store.getState().quantity).toBe(1000);
  });
});

describe('TradeStore.arm', () => {
  it('sends the futures root as the order underlying even when charting a contract symbol', async () => {
    const store = makeStore();
    store.setAssetClass('future');
    await store.loadFuturesContracts();
    expect(store.getState().selectedFutureSymbol).toBe('MESU26');

    store.arm('buy', 'MESU26', {} as ChainStore);

    const ticket = store.getState().armedTicket;
    expect(ticket).not.toBeNull();
    expect(ticket!.request.underlying).toBe('MES');
    expect(ticket!.request.selection).toEqual({ mode: 'explicit', contractSymbol: 'MESU26' });
  });
});
