import { describe, expect, it } from 'vitest';
import type { ApiClient } from '../../core/api/ApiClient';
import type { OrderRequest } from '@0dtetrader/shared-types';
import { ChainStore } from './ChainStore';
import { TradeStore } from './TradeStore';
import type { ApplicablePriceSuggestion } from '../appleIntelligence/tradeDeskPresenter';

const contract = {
  symbol: 'SPY260731C00746000',
  underlying: 'SPY',
  expiration: '2026-07-31',
  strike: 746,
  optionType: 'call' as const,
  bid: 1.8,
  ask: 1.9,
  last: 1.85,
};

function stores() {
  const apiClient = {} as ApiClient;
  const chainStore = new ChainStore(apiClient);
  (chainStore as unknown as { state: unknown }).state = {
    underlying: 'SPY',
    chain: {
      underlying: 'SPY',
      underlyingPrice: 746.7,
      expirations: ['2026-07-31'],
      contracts: [contract],
    },
    isLoading: false,
    errorMessage: null,
    optionType: 'call',
    isAutoMode: false,
    selectedExpiration: '2026-07-31',
    selectedStrike: 746,
    underlyingLast: 746.7,
  };
  const tradeStore = new TradeStore(apiClient);
  return { tradeStore, chainStore };
}

function suggestion(overrides: Partial<ApplicablePriceSuggestion> = {}): ApplicablePriceSuggestion {
  return {
    price: 1.85,
    priceDomain: 'contract-premium',
    evidenceId: 'e1',
    snapshotId: 'snap-1',
    positionVersion: 0,
    contractIdentity: contract.symbol,
    ...overrides,
  };
}

describe('TradeStore.applyTradeDeskPrice', () => {
  it('valid suggestion selects Custom and updates custom price without changing quantity', () => {
    const { tradeStore, chainStore } = stores();
    tradeStore.setQuantity(3);
    const result = tradeStore.applyTradeDeskPrice(
      { type: 'apply-trade-desk-price', suggestion: suggestion() },
      chainStore,
    );
    expect(result).toEqual({ ok: true });
    expect(tradeStore.getState()).toMatchObject({
      orderType: 'custom',
      customLimitPrice: 1.85,
      quantity: 3,
    });
  });

  it('rejects wrong contract, invalid tick, and submitting ticket without partial update', () => {
    const { tradeStore, chainStore } = stores();
    expect(
      tradeStore.applyTradeDeskPrice(
        { type: 'apply-trade-desk-price', suggestion: suggestion({ contractIdentity: 'OTHER' }) },
        chainStore,
      ),
    ).toMatchObject({ ok: false, reason: 'contract' });
    expect(
      tradeStore.applyTradeDeskPrice(
        { type: 'apply-trade-desk-price', suggestion: suggestion({ price: 1.855 }) },
        chainStore,
      ),
    ).toMatchObject({ ok: false, reason: 'price' });
    (tradeStore as unknown as { state: { isSubmitting: boolean } }).state.isSubmitting = true;
    expect(
      tradeStore.applyTradeDeskPrice(
        { type: 'apply-trade-desk-price', suggestion: suggestion() },
        chainStore,
      ),
    ).toMatchObject({ ok: false, reason: 'submitting' });
    expect(tradeStore.getState()).toMatchObject({ orderType: 'mid', customLimitPrice: null });
  });

  it('rejects applying a suggested price while a ticket is armed, without updating the frozen ticket', () => {
    // ArmedOrderTicket.request is a frozen snapshot captured at arm time —
    // confirmArmedOrder submits ticket.request, not live store state. If
    // applyTradeDeskPrice updated orderType/customLimitPrice here, the
    // confirm popup would show the new price while still submitting the old
    // frozen one.
    const { tradeStore, chainStore } = stores();
    const armedTicket = {
      id: 1,
      request: { symbol: contract.symbol } as unknown as OrderRequest,
      idempotencyKey: 'key-1',
      side: 'buy' as const,
      summary: 'Buy 1 SPY 746C @ 1.80',
    };
    (tradeStore as unknown as { state: { armedTicket: typeof armedTicket } }).state.armedTicket =
      armedTicket;

    const result = tradeStore.applyTradeDeskPrice(
      { type: 'apply-trade-desk-price', suggestion: suggestion({ price: 1.9 }) },
      chainStore,
    );

    expect(result).toMatchObject({ ok: false, reason: 'armed' });
    expect(tradeStore.getState()).toMatchObject({ orderType: 'mid', customLimitPrice: null });
    expect(tradeStore.getState().armedTicket).toBe(armedTicket);
  });
});
