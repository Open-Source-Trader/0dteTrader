import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChartOrder, OptionContract, OrderResult, Position } from '@0dtetrader/shared-types';
import { TradeManagementWorkspace } from './TradeManagementWorkspace';
import {
  dayPnl,
  desktopTradeWorkspaceHeight,
  pnlPercent,
  signedCurrency,
} from './TradeManagementWorkspaceModel';

const contract: OptionContract = {
  symbol: 'SPY260729C00729000',
  underlying: 'SPY',
  expiration: '2026-07-29',
  strike: 729,
  optionType: 'call',
  bid: 1.48,
  ask: 1.52,
  last: 1.5,
};

const position: Position = {
  symbol: contract.symbol,
  assetClass: 'option',
  quantity: 1,
  avgPrice: 1.5,
  markPrice: 2.34,
  unrealizedPnl: 84,
  multiplier: 100,
};

const order: OrderResult = {
  orderId: 'order-1',
  status: 'submitted',
  contractSymbol: contract.symbol,
  side: 'sell',
  quantity: 1,
  orderType: 'mid',
  limitPrice: 2.75,
  timestamp: '2026-07-29T14:31:00Z',
};

beforeAll(() => {
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const stop: ChartOrder = {
  id: 'stop-1',
  underlying: 'SPY',
  triggerPrice: 1.5,
  armPrice: 2,
  side: 'sell',
  quantity: 1,
  orderType: 'market',
  kind: 'stop',
  optionType: 'call',
  expiration: contract.expiration,
  strike: contract.strike,
  contractSymbol: contract.symbol,
  ocoGroupId: null,
  status: 'working',
  createdAt: '2026-07-29T14:30:00Z',
  expiresAt: '2026-07-29T21:00:00Z',
  triggeredAt: null,
  brokerOrderId: null,
  lastError: null,
};

function renderWorkspace(overrides: Partial<Parameters<typeof TradeManagementWorkspace>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(TradeManagementWorkspace, {
      positions: [],
      openOrders: [],
      chartOrders: [],
      workingSymbols: [],
      expanded: false,
      onExpandedChange: () => undefined,
      onClosePosition: () => undefined,
      onTrimPosition: () => undefined,
      onCancelOrder: () => undefined,
      onCancelChartOrder: () => undefined,
      resolveContract: () => null,
      ...overrides,
    }),
  );
}

describe('TradeManagementWorkspace helpers', () => {
  it('collapses while flat and expands to resize the chart area', () => {
    expect(desktopTradeWorkspaceHeight({ expanded: false, hasActivity: false })).toBe(36);
    expect(desktopTradeWorkspaceHeight({ expanded: false, hasActivity: true })).toBe(124);
    expect(desktopTradeWorkspaceHeight({ expanded: true, hasActivity: false })).toBe(220);
  });

  it('keeps P&L signed using more than color alone', () => {
    expect(signedCurrency(84)).toBe('+$84.00');
    expect(signedCurrency(-12)).toBe('-$12.00');
    expect(pnlPercent(position)).toBeCloseTo(56);
    expect(
      dayPnl([position, { ...position, symbol: 'SPY260729P00729000', unrealizedPnl: -20 }]),
    ).toBe(64);
  });
});

describe('TradeManagementWorkspace rendering', () => {
  it('renders only the compact status bar when flat', () => {
    const markup = renderWorkspace();

    expect(markup).toContain('Positions 0');
    expect(markup).toContain('Open Orders 0');
    expect(markup).toContain('Day P&amp;L $0.00');
    expect(markup).not.toContain('active-position-strip');
  });

  it('auto-shows the compact position strip without auto-expanding the full table', () => {
    const markup = renderWorkspace({
      positions: [position],
      chartOrders: [stop],
      resolveContract: () => contract,
      expanded: false,
    });

    expect(markup).toContain('active-position-strip');
    expect(markup).toContain('SPY 729C · Qty 1');
    expect(markup).toContain('+$84.00 · +56%');
    expect(markup).toContain('Expiry B/E $730.50');
    expect(markup).toContain('Stop $1.50');
    expect(markup).not.toContain('<th style="text-align:left">Expiration</th>');
  });

  it('renders the expanded positions and open orders workspace states', () => {
    const markup = renderWorkspace({
      positions: [position],
      openOrders: [order],
      chartOrders: [stop],
      resolveContract: () => contract,
      expanded: true,
    });

    expect(markup).toContain('Positions<span class="desktop-positions-tab-count">1</span>');
    expect(markup).toContain('Open Orders<span class="desktop-positions-tab-count">1</span>');
    expect(markup).toContain('Recent Trades');
    expect(markup).toContain('Expiration');
    expect(markup).toContain('Expiry B/E');
    expect(markup).toContain('Target');
  });

  it('marks position no stop and no target states as explicit dashes', () => {
    const markup = renderWorkspace({
      positions: [position],
      resolveContract: () => contract,
      expanded: false,
    });

    expect(markup).toContain('Stop —');
    expect(markup).toContain('Target —');
  });

  it('disables exit buttons while the position has a pending request', () => {
    const close = vi.fn();
    const markup = renderWorkspace({
      positions: [position],
      workingSymbols: [position.symbol],
      resolveContract: () => contract,
      onClosePosition: close,
    });

    expect(markup).toContain('disabled=""');
    expect(close).not.toHaveBeenCalled();
  });
});
