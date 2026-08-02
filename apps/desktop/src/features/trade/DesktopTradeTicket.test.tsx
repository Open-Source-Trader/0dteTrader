import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OptionType } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { dayString } from '../../core/models/dates';
import { ChainStore } from './ChainStore';
import { DesktopTradeTicket } from './DesktopTradeTicket';
import { TradeStore } from './TradeStore';

// 0DTE only renders when the contract's expiration matches today, so the
// fixture uses today's date rather than a fixed string that would drift out
// of "today" and silently stop exercising that label path.
const EXPIRATION = dayString();
const call = {
  symbol: 'SPY260729C00729000',
  underlying: 'SPY',
  expiration: EXPIRATION,
  strike: 729,
  optionType: 'call' as const,
  bid: 1.48,
  ask: 1.52,
  last: 1.5,
};
const put = {
  ...call,
  symbol: 'SPY260729P00729000',
  optionType: 'put' as const,
  bid: 0.92,
  ask: 1.04,
  last: 0.98,
};
const nextCall = { ...call, symbol: 'SPY260729C00730000', strike: 730, bid: 0.9, ask: 1.0 };
const nextPut = { ...put, symbol: 'SPY260729P00730000', strike: 730, bid: 1.3, ask: 1.4 };

function makeStores({
  optionType = 'call' as OptionType,
  isAutoMode = false,
  quantity = 1,
}: { optionType?: OptionType; isAutoMode?: boolean; quantity?: number } = {}) {
  const apiClient = {
    previewOrder: () => Promise.resolve({ estimatedCost: 150, warnings: [] }),
  } as unknown as ApiClient;
  const chainStore = new ChainStore(apiClient);
  const tradeStore = new TradeStore(apiClient);
  (chainStore as unknown as { state: unknown }).state = {
    underlying: 'SPY',
    chain: {
      underlying: 'SPY',
      underlyingPrice: 728.8,
      expirations: [EXPIRATION],
      contracts: [call, put, nextCall, nextPut],
    },
    isLoading: false,
    errorMessage: null,
    optionType,
    isAutoMode,
    selectedExpiration: EXPIRATION,
    selectedStrike: 729,
    underlyingLast: 728.8,
  };
  tradeStore.setQuantity(quantity);
  return { chainStore, tradeStore };
}

function ticketMarkup(stores = makeStores()) {
  return renderToStaticMarkup(
    createElement(DesktopTradeTicket, {
      chainStore: stores.chainStore,
      tradeStore: stores.tradeStore,
      onArm: () => undefined,
    }),
  );
}

beforeAll(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    setTimeout,
    clearTimeout,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('DesktopTradeTicket right rail order', () => {
  it('renders option chain, then expiration/AUTO/CALL-PUT, then ticket and execution controls', () => {
    const markup = ticketMarkup();

    expect(markup.indexOf('chain-table')).toBeLessThan(markup.indexOf('desktop-ticket-config-row'));
    expect(markup.indexOf('desktop-ticket-config-row')).toBeLessThan(
      markup.indexOf('desktop-contract-summary'),
    );
    expect(markup.indexOf('desktop-contract-summary')).toBeLessThan(
      markup.indexOf('desktop-ticket-qty-row'),
    );
    expect(markup.indexOf('desktop-ticket-risk')).toBeLessThan(
      markup.indexOf('desktop-ticket-action-row'),
    );
    expect((markup.match(/0DTE \/ Expiry|2026-07-29 · 0DTE/g) ?? []).length).toBe(1);
    expect((markup.match(/aria-label="Auto OTM selection"/g) ?? []).length).toBe(1);
    expect((markup.match(/Select call contract/g) ?? []).length).toBe(1);
    expect((markup.match(/Select put contract/g) ?? []).length).toBe(1);
    expect(markup).not.toContain('≈');
  });

  it('removes the placeholder ATM chip from the rendered controls', () => {
    const markup = ticketMarkup();

    expect(markup).not.toContain('>ATM<');
  });

  it('keeps BUY and SELL as the bottom controls and exposes all supported price modes', () => {
    const markup = ticketMarkup();

    for (const mode of ['Bid', 'Mid', 'Ask', 'Market']) {
      expect(markup).toContain(`>${mode}</span>`);
    }
    expect(markup).toContain('aria-label="Custom limit price"');
    expect(markup).toContain('>SELL TO CLOSE<');
    expect(markup).toContain('>BUY TO OPEN<');
  });

  it('orders price modes as Custom, Bid, Mid, Ask, Market to match iOS', () => {
    const markup = ticketMarkup();
    const priceRow = markup.slice(markup.indexOf('desktop-ticket-price-row'));

    expect(priceRow.indexOf('Custom limit price')).toBeLessThan(
      priceRow.indexOf('desktop-ticket-price-mode-label">Bid<'),
    );
    expect(priceRow.indexOf('desktop-ticket-price-mode-label">Bid<')).toBeLessThan(
      priceRow.indexOf('desktop-ticket-price-mode-label">Mid<'),
    );
    expect(priceRow.indexOf('desktop-ticket-price-mode-label">Mid<')).toBeLessThan(
      priceRow.indexOf('desktop-ticket-price-mode-label">Ask<'),
    );
    expect(priceRow.indexOf('desktop-ticket-price-mode-label">Ask<')).toBeLessThan(
      priceRow.indexOf('desktop-ticket-price-mode-value numeric">Market<'),
    );
  });

  it('shows the live bid/mid/ask price on each price-mode button', () => {
    const markup = ticketMarkup();

    expect(markup).toContain('desktop-ticket-price-mode-value numeric">1.48<');
    expect(markup).toContain('desktop-ticket-price-mode-value numeric">1.50<');
    expect(markup).toContain('desktop-ticket-price-mode-value numeric">1.52<');
  });
});

describe('DesktopTradeTicket CALL/PUT selection', () => {
  it('marks only CALL active with green semantic treatment and no redundant side badge', () => {
    const markup = ticketMarkup(makeStores({ optionType: 'call' }));

    expect(markup).toContain('desktop-mode-button--call selected');
    expect(markup).not.toContain('desktop-mode-button--put selected');
    expect(markup).toContain('aria-pressed="true" aria-label="Select call contract"');
    expect(markup).toContain('aria-pressed="false" aria-label="Select put contract"');
    expect(markup).not.toContain('desktop-contract-summary__side');
    expect(markup).not.toContain('data-side="call"');
    expect(markup).toContain('SPY 729C · 0DTE');
    expect(markup).toContain('desktop-ticket-price-mode-value numeric">1.48<');
    expect(markup).toContain('>Mid<');
    expect(markup).toContain('>$1.50<');
    expect(markup).toContain('aria-label="Expiry B/E $730.50 (+0.23%)"');
    expect(markup).not.toContain('✓');
  });

  it('marks only PUT active with red semantic treatment and no redundant side badge', () => {
    const markup = ticketMarkup(makeStores({ optionType: 'put' }));

    expect(markup).toContain('desktop-mode-button--put selected');
    expect(markup).not.toContain('desktop-mode-button--call selected');
    expect(markup).toContain('aria-pressed="true" aria-label="Select put contract"');
    expect(markup).not.toContain('desktop-contract-summary__side');
    expect(markup).not.toContain('data-side="put"');
    expect(markup).toContain('SPY 729P · 0DTE');
    expect(markup).toContain('desktop-ticket-price-mode-value numeric">0.92<');
    expect(markup).toContain('>Mid<');
    expect(markup).toContain('>$0.98<');
    expect(markup).toContain('aria-label="Expiry B/E $728.02 (-0.11%)"');
    expect(markup).not.toContain('✓');
  });

  it('clicking call and put quote behavior selects that side at the clicked strike', () => {
    const { chainStore } = makeStores();

    chainStore.setOptionType('put');
    chainStore.selectStrike(730);
    expect(chainStore.getState()).toMatchObject({ optionType: 'put', selectedStrike: 730 });
    expect(chainStore.selectedContract?.symbol).toBe(nextPut.symbol);

    chainStore.setOptionType('call');
    chainStore.selectStrike(729);
    expect(chainStore.getState()).toMatchObject({ optionType: 'call', selectedStrike: 729 });
    expect(chainStore.selectedContract?.symbol).toBe(call.symbol);
  });

  it('side selector preserves expiration, strike, and quantity for valid side switches', () => {
    const { chainStore, tradeStore } = makeStores({ quantity: 6 });

    chainStore.setOptionType('put');

    expect(chainStore.getState().selectedExpiration).toBe(EXPIRATION);
    expect(chainStore.getState().selectedStrike).toBe(729);
    expect(tradeStore.getState().quantity).toBe(6);
    expect(chainStore.selectedContract?.symbol).toBe(put.symbol);
  });

  it('BUY uses the selected side and strike for manual orders', () => {
    const { chainStore, tradeStore } = makeStores({ optionType: 'put', quantity: 2 });

    tradeStore.arm('buy', 'SPY', chainStore);

    expect(tradeStore.getState().armedTicket?.request).toMatchObject({
      side: 'buy',
      quantity: 2,
      selection: { mode: 'explicit', optionType: 'put', expiration: EXPIRATION, strike: 729 },
    });
  });

  it('SELL remains restricted to matching long positions', () => {
    const { chainStore, tradeStore } = makeStores({ optionType: 'put' });
    (tradeStore as unknown as { state: Record<string, unknown> }).state.positions = [
      {
        symbol: put.symbol,
        assetClass: 'option',
        quantity: 1,
        avgPrice: 0.98,
        markPrice: 1.1,
        unrealizedPnl: 12,
        multiplier: 100,
      },
    ];
    tradeStore.optionContractResolver = (symbol: string) =>
      symbol === put.symbol ? put : undefined;

    tradeStore.arm('sell', 'SPY', chainStore);

    expect(tradeStore.getState().armedTicket?.request).toMatchObject({
      side: 'sell',
      selection: { mode: 'explicit', optionType: 'put', expiration: EXPIRATION, strike: 729 },
    });
  });

  it('missing opposite-side contracts clear selected contract and disable submissions safely', () => {
    const { chainStore, tradeStore } = makeStores();
    (chainStore as unknown as { state: Record<string, unknown> }).state.chain = {
      underlying: 'SPY',
      underlyingPrice: 728.8,
      expirations: [EXPIRATION],
      contracts: [call],
    };

    chainStore.setOptionType('put');
    const markup = ticketMarkup({ chainStore, tradeStore });

    expect(chainStore.selectedContract).toBeNull();
    expect(markup).toContain('No contract selected');
    expect(markup).toContain(
      'desktop-ticket-risk-label">Max loss</span><span class="desktop-ticket-risk-value">—',
    );
    expect(markup).toContain('disabled=""');
  });

  it('loading state clears stale quote and break-even values', () => {
    const { chainStore, tradeStore } = makeStores({ optionType: 'put' });
    (chainStore as unknown as { state: Record<string, unknown> }).state.isLoading = true;
    const markup = ticketMarkup({ chainStore, tradeStore });

    expect(markup).toContain('SPY 729P · 0DTE');
    expect(markup).toContain('Refreshing quotes');
    expect(markup).toContain('Expiry B/E —');
    expect(markup).not.toContain('>$0.98<');
    expect(markup).not.toContain('>$728.02<');
  });

  it('AUTO mode: optionType drives the ATM-walk direction (calls up, puts down)', () => {
    const { chainStore } = makeStores({ isAutoMode: true });
    const prevCall = { ...call, symbol: 'SPY260729C00728000', strike: 728 };
    const prevPut = { ...put, symbol: 'SPY260729P00728000', strike: 728 };
    chainStore.getState().chain!.contracts.push(prevCall, prevPut);
    chainStore.setUnderlyingLast(729.2);

    // ATM anchor 729 → calls step up to 730, puts step down to 728.
    expect(chainStore.autoContract?.symbol).toBe(nextCall.symbol);
    chainStore.setOptionType('put');
    expect(chainStore.getState().selectedStrike).toBe(729);
    expect(chainStore.autoContract?.symbol).toBe(prevPut.symbol);
    expect(chainStore.selectedContract?.symbol).toBe(prevPut.symbol);
  });
});

describe('DesktopTradeTicket semantic styling', () => {
  it('renders semantic class hooks for active side and selected chain cell', () => {
    const callMarkup = ticketMarkup(makeStores({ optionType: 'call' }));
    const putMarkup = ticketMarkup(makeStores({ optionType: 'put' }));

    expect(callMarkup).toContain('desktop-mode-button--call selected');
    expect(callMarkup).toContain('chain-cell chain-cell--call selected');
    expect(putMarkup).toContain('desktop-mode-button--put selected');
    expect(putMarkup).toContain('chain-cell chain-cell--put selected');
  });
});
