import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OptionContract } from '@0dtetrader/shared-types';
import { dayString } from '../../core/models/dates';
import { DesktopContractSummary } from './DesktopContractSummary';
import { buildDesktopContractSummary } from './DesktopContractSummaryModel';

const contract: OptionContract = {
  symbol: 'SPY260729C00729000',
  underlying: 'SPY',
  expiration: dayString(),
  strike: 729,
  optionType: 'call',
  bid: 1.48,
  ask: 1.52,
  last: 1.5,
};

describe('DesktopContractSummary', () => {
  it('shows no selected contract state', () => {
    const summary = buildDesktopContractSummary(null, false);

    expect(summary.state).toBe('none');
    expect(summary.contractLine).toBe('No contract selected');
  });

  it('shows quote loading state', () => {
    const summary = buildDesktopContractSummary(null, true);

    expect(summary.state).toBe('loading');
    expect(summary.contractLine).toBe('Loading option chain…');
  });

  it('matches selected-contract details to the highlighted chain row quote', () => {
    const summary = buildDesktopContractSummary(contract, false, 'mid', null, 1);

    expect(summary.state).toBe('quoted');
    expect(summary.contractLine).toBe('SPY 729C · 0DTE');
    expect(summary.quoteLine).toBe('Quote B 1.48 · M 1.50 · A 1.52');
    expect(summary.spreadLine).toBe('Spread · $0.04 / 2.7%');
    expect(summary.sideLabel).toBe('CALL');
    expect(summary.quoteFields).toEqual([
      { key: 'bid', label: 'B', value: '1.48' },
      { key: 'mid', label: 'M', value: '1.50' },
      { key: 'ask', label: 'A', value: '1.52' },
    ]);
    expect(summary.executionLine).toBe('Execution · Mid $1.50');
    expect(summary.breakEvenLine).toBe('Expiry B/E $730.50');
    expect(summary.estimatedDebitLine).toBe('Debit $150.00');
  });

  it('shows quote unavailable without hiding the selected contract', () => {
    const summary = buildDesktopContractSummary(
      { ...contract, bid: 0, ask: 0 },
      false,
      'mid',
      null,
      1,
    );

    expect(summary.state).toBe('unavailable');
    expect(summary.contractLine).toBe('SPY 729C · 0DTE');
    expect(summary.quoteLine).toBe('Quote unavailable');
  });

  it('renders before BUY and SELL when mounted in the desktop rail', () => {
    const markup = renderToStaticMarkup(
      createElement(DesktopContractSummary, {
        selectedContract: contract,
        isLoading: false,
        orderType: 'mid',
        customLimitPrice: null,
        quantity: 1,
        underlyingLast: null,
      }),
    );

    expect(markup).toContain('desktop-contract-summary');
    expect(markup).toContain('SPY 729C · 0DTE');
    expect(markup).toContain('aria-label="Execution · Mid $1.50"');
    expect(markup).toContain('>$1.50<');
    expect(markup).toContain('aria-label="Expiry B/E $730.50"');
    expect(markup).not.toContain('desktop-contract-summary__quote-field');
    expect(markup).not.toContain('desktop-contract-summary__side');
  });

  it('surfaces custom and market execution values without stale quote chips', () => {
    const custom = buildDesktopContractSummary(contract, false, 'custom', 1.41, 1);
    const market = buildDesktopContractSummary(contract, false, 'market', null, 1);
    const unavailableMarket = buildDesktopContractSummary(
      { ...contract, bid: 0, ask: 0 },
      false,
      'market',
      null,
      1,
    );

    expect(custom.executionLine).toBe('Execution · Custom $1.41');
    expect(custom.breakEvenLine).toBe('Expiry B/E $730.41');
    expect(market.executionLine).toBe('Execution · Market est. Mkt $1.52');
    expect(unavailableMarket.executionLine).toBe('Execution · Market est. —');
  });

  it('keeps large spread percentages together as one metric', () => {
    const wide = buildDesktopContractSummary(
      { ...contract, bid: 4.93, ask: 5.54 },
      false,
      'mid',
      null,
      1,
    );
    const markup = renderToStaticMarkup(
      createElement(DesktopContractSummary, {
        selectedContract: { ...contract, bid: 4.93, ask: 5.54 },
        isLoading: false,
        orderType: 'mid',
        customLimitPrice: null,
        quantity: 1,
        underlyingLast: null,
      }),
    );

    expect(wide.spreadValueLine).toBe('Spread · $0.61 / 11.6%');
    expect(wide.spreadValue).toBe('$0.61 / 11.6%');
    expect(markup).toContain('>$0.61 / 11.6%<');
  });

  it('reports moneyness and intrinsic/extrinsic split relative to the underlying', () => {
    const otm = buildDesktopContractSummary(contract, false, 'mid', null, 1, 728);

    expect(otm.moneynessLine).toBe('Spot 728.00 · 1.00 OTM (0.14%)');
    expect(otm.intrinsicExtrinsicLine).toBe('Intrinsic $0.00 · Extrinsic $1.50');
    expect(otm.breakEvenLine).toBe('Expiry B/E $730.50 (+0.34%)');

    const itm = buildDesktopContractSummary(contract, false, 'mid', null, 1, 730);

    expect(itm.moneynessLine).toBe('Spot 730.00 · 1.00 ITM (0.14%)');
    expect(itm.intrinsicExtrinsicLine).toBe('Intrinsic $1.00 · Extrinsic $0.50');
  });

  it('falls back to dashes for moneyness when the underlying price is unknown', () => {
    const summary = buildDesktopContractSummary(contract, false, 'mid', null, 1, null);

    expect(summary.moneynessLine).toBe('Spot —');
    expect(summary.intrinsicExtrinsicLine).toBe('Intrinsic — · Extrinsic —');
  });
});
