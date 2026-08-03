import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChartOrder, OptionContract, OrderResult, Position } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { ChartOrdersStore } from '../chart/chartOrders';
import { TradeManagementWorkspace } from './TradeManagementWorkspace';
import {
  dayPnl,
  desktopTradeWorkspaceHeight,
  EDITOR_ROW_HEIGHT,
  moveStopToEntryRequest,
  pnlPercent,
  signedCurrency,
  StopTargetEditorStore,
  timeInTrade,
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

const target: ChartOrder = { ...stop, id: 'target-1', kind: 'target', triggerPrice: 2.75 };

/** ChartOrdersStore over a mocked ApiClient, same shape as chartOrders.test.ts. */
function makeChartOrdersStore(orders: ChartOrder[] = []) {
  const api = {
    chartOrders: vi.fn(async () => orders),
    updateChartOrder: vi.fn(async (id: string, patch: Record<string, unknown>) => ({
      ...(orders.find((order) => order.id === id) ?? stop),
      ...patch,
    })),
    cancelChartOrder: vi.fn(async () => undefined),
  };
  return { api, store: new ChartOrdersStore(api as unknown as ApiClient) };
}

/** A loaded store plus an editor session over it. */
async function seededEditor(orders: ChartOrder[]) {
  const { api, store } = makeChartOrdersStore(orders);
  await store.load();
  return { api, store, editor: new StopTargetEditorStore(store) };
}

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
      onMoveChartOrder: () => undefined,
      onSelectChartOrder: () => undefined,
      onCreateChartOrder: () => undefined,
      defaultOrderType: 'mid',
      underlyingPrice: 640,
      resolveContract: () => null,
      editor: new StopTargetEditorStore(makeChartOrdersStore().store),
      chartSymbol: 'SPY',
      visiblePriceRange: null,
      onRevealPrice: () => undefined,
      ...overrides,
    }),
  );
}

/** The rendered tag for the action button whose visible label is `label`. */
function buttonTag(markup: string, label: string): string {
  return markup.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? '';
}

describe('timeInTrade', () => {
  const NOW = Date.parse('2026-07-29T15:00:00Z');

  it('formats minutes and hours since the run opened', () => {
    expect(timeInTrade({ ...position, openedAt: '2026-07-29T14:56:00Z' }, NOW)).toBe('4m');
    expect(timeInTrade({ ...position, openedAt: '2026-07-29T13:48:00Z' }, NOW)).toBe('1h 12m');
  });

  it('dashes when openedAt is missing or unparseable', () => {
    expect(timeInTrade(position, NOW)).toBe('—');
    expect(timeInTrade({ ...position, openedAt: 'not-a-time' }, NOW)).toBe('—');
  });
});

describe('moveStopToEntryRequest', () => {
  const anchored: Position = { ...position, underlyingEntryPrice: 636.4 };

  it('moves the stop line to the underlying entry price while the position is past it', () => {
    expect(moveStopToEntryRequest(anchored, stop, 640, 'call')).toEqual({
      order: stop,
      triggerPrice: 636.4,
    });
    // A long put profits downward: past entry means the market BELOW it.
    expect(moveStopToEntryRequest(anchored, stop, 630, 'put')).toEqual({
      order: stop,
      triggerPrice: 636.4,
    });
  });

  it('is unavailable without a stop line, entry anchor, live price, or option type', () => {
    expect(moveStopToEntryRequest(anchored, null, 640, 'call')).toBeNull();
    expect(moveStopToEntryRequest(position, stop, 640, 'call')).toBeNull();
    expect(moveStopToEntryRequest(anchored, stop, null, 'call')).toBeNull();
    expect(moveStopToEntryRequest(anchored, stop, 640, null)).toBeNull();
  });

  it('refuses while the entry sits on the profit side of the market — that would arm a recovery exit', () => {
    // Long call under water: entry 636.4 with the market at 630. Moving the
    // "stop" there would fire on the way back UP — a break-even exit, not a
    // stop — so the request is unavailable.
    expect(moveStopToEntryRequest(anchored, stop, 630, 'call')).toBeNull();
    expect(moveStopToEntryRequest(anchored, stop, 636.4, 'call')).toBeNull();
    expect(moveStopToEntryRequest(anchored, stop, 640, 'put')).toBeNull();
  });
});

describe('TradeManagementWorkspace helpers', () => {
  it('collapses while flat and expands to resize the chart area', () => {
    expect(desktopTradeWorkspaceHeight({ expanded: false, hasActivity: false })).toBe(36);
    expect(desktopTradeWorkspaceHeight({ expanded: false, hasActivity: true })).toBe(124);
    expect(desktopTradeWorkspaceHeight({ expanded: true, hasActivity: false })).toBe(220);
  });

  it('budgets the docked editor row — the footer is fixed-pixel with nothing elastic', () => {
    // 124 is exactly strip (88) + status bar (36); an unbudgeted editor row
    // pushes the status bar below the viewport.
    expect(
      desktopTradeWorkspaceHeight({ expanded: false, hasActivity: true, editorOpen: true }),
    ).toBe(124 + EDITOR_ROW_HEIGHT);
    expect(
      desktopTradeWorkspaceHeight({ expanded: true, hasActivity: true, editorOpen: true }),
    ).toBe(220 + EDITOR_ROW_HEIGHT);
    // The function does not encode the editor-requires-activity coupling.
    expect(
      desktopTradeWorkspaceHeight({ expanded: false, hasActivity: false, editorOpen: true }),
    ).toBe(36 + EDITOR_ROW_HEIGHT);
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

  it('enables stop/target actions once a stop line and entry anchor exist', () => {
    const markup = renderWorkspace({
      positions: [{ ...position, underlyingEntryPrice: 636.4 }],
      chartOrders: [stop],
      resolveContract: () => contract,
    });

    expect(buttonTag(markup, 'Move stop to entry')).not.toContain('disabled');
    expect(buttonTag(markup, 'Edit stop')).not.toContain('disabled');
    // No target line yet → Set target, creatable from the entry anchor.
    expect(buttonTag(markup, 'Set target')).not.toContain('disabled');
    expect(markup).not.toContain('Set stop');
    expect(markup).not.toContain('Edit target');
  });

  it('disables Move stop to entry without a stop line or entry anchor', () => {
    // No stop line (entry anchor present): move disabled, Set stop enabled.
    const noStop = renderWorkspace({
      positions: [{ ...position, underlyingEntryPrice: 636.4 }],
      resolveContract: () => contract,
    });
    expect(buttonTag(noStop, 'Move stop to entry')).toContain('disabled');
    expect(buttonTag(noStop, 'Move stop to entry')).toContain('Set a stop line on the chart');
    expect(buttonTag(noStop, 'Set stop')).not.toContain('disabled');

    // No entry anchor: nothing to move a stop TO — but Set legs anchor on the
    // live price, so they stay available, as does editing an existing line.
    const noAnchor = renderWorkspace({
      positions: [position],
      chartOrders: [stop],
      resolveContract: () => contract,
    });
    expect(buttonTag(noAnchor, 'Move stop to entry')).toContain('disabled');
    expect(buttonTag(noAnchor, 'Move stop to entry')).toContain('Entry price unknown');
    expect(buttonTag(noAnchor, 'Set target')).not.toContain('disabled');
    expect(buttonTag(noAnchor, 'Edit stop')).not.toContain('disabled');
  });

  it('disables Move stop to entry while the position is not past its entry', () => {
    const markup = renderWorkspace({
      positions: [{ ...position, underlyingEntryPrice: 636.4 }],
      chartOrders: [stop],
      resolveContract: () => contract,
      underlyingPrice: 630, // long call under water
    });

    expect(buttonTag(markup, 'Move stop to entry')).toContain('disabled');
    expect(buttonTag(markup, 'Move stop to entry')).toContain('recovery exit');
    // Set/Edit legs stay available — only the entry move is direction-gated.
    expect(buttonTag(markup, 'Edit stop')).not.toContain('disabled');
  });

  it('disables Set legs while there is no live underlying price to anchor on', () => {
    const markup = renderWorkspace({
      positions: [{ ...position, underlyingEntryPrice: 636.4 }],
      resolveContract: () => contract,
      underlyingPrice: null,
    });

    expect(buttonTag(markup, 'Set stop')).toContain('disabled');
    expect(buttonTag(markup, 'Set stop')).toContain('Live price unavailable');
    expect(buttonTag(markup, 'Set target')).toContain('disabled');
  });

  it('locks every stop/target action alongside the rest of the workspace', () => {
    const markup = renderWorkspace({
      positions: [{ ...position, underlyingEntryPrice: 636.4 }],
      chartOrders: [stop],
      resolveContract: () => contract,
      locked: true,
    });

    for (const label of ['Move stop to entry', 'Edit stop', 'Set target']) {
      expect(buttonTag(markup, label)).toContain('disabled');
    }
  });

  it('keeps Edit usable with Chart Trading off; only chart-side actions disable', () => {
    const markup = renderWorkspace({
      positions: [{ ...position, underlyingEntryPrice: 636.4 }],
      chartOrders: [stop],
      resolveContract: () => contract,
      chartTradingEnabled: false,
    });

    // Creating a line or handing off to the line layer needs the layer;
    // editing an EXISTING leg goes through the docked editor and must not —
    // the chart being off (or the line off-domain) cannot strand the order.
    for (const label of ['Move stop to entry', 'Set target']) {
      expect(buttonTag(markup, label)).toContain('disabled');
      expect(buttonTag(markup, label)).toContain('Enable Chart Trading in chart settings first');
    }
    expect(buttonTag(markup, 'Edit stop')).not.toContain('disabled');
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

describe('workspace stop/target editor', () => {
  it('enables Edit for an existing leg instead of pointing at the chart', () => {
    const markup = renderWorkspace({
      positions: [position],
      chartOrders: [stop, target],
      resolveContract: () => contract,
    });

    expect(markup).toContain('desktop-positions-action">Edit stop');
    expect(markup).toContain('desktop-positions-action">Edit target');
    expect(markup).not.toContain('Use chart order lines');
  });

  it('opens a docked editor for a visible stop, keeping the chart-line selection', async () => {
    const { store, editor } = await seededEditor([stop]);

    editor.begin('stop-1');

    expect(store.getState().selectedId).toBe('stop-1');
    expect(editor.getState().draft).toMatchObject({
      id: 'stop-1',
      kind: 'stop',
      side: 'sell',
      orderType: 'market',
      triggerPrice: 1.5,
      quantity: 1,
    });
    const markup = renderWorkspace({
      positions: [position],
      chartOrders: [stop],
      resolveContract: () => contract,
      editor,
    });
    expect(markup).toContain('stop-target-editor');
    expect(markup).toContain('Edit stop · SPY 729C');
    expect(markup).toContain('value="1.5"');
  });

  it('opens the same editor for a visible target', async () => {
    const { editor } = await seededEditor([target]);

    editor.begin('target-1');

    const markup = renderWorkspace({
      positions: [position],
      chartOrders: [target],
      resolveContract: () => contract,
      editor,
    });
    expect(markup).toContain('Edit target · SPY 729C');
    expect(markup).toContain('value="2.75"');
  });

  it('still opens for a stop below the visible domain, and offers Show on chart', async () => {
    const { editor } = await seededEditor([stop]);
    editor.begin('stop-1');

    const markup = renderWorkspace({
      positions: [position],
      chartOrders: [stop],
      resolveContract: () => contract,
      editor,
      visiblePriceRange: { min: 400, max: 500 },
    });

    expect(markup).toContain('stop-target-editor');
    expect(markup).toContain('Show on chart');
  });

  it('offers Show on chart only off-domain and only for the charted underlying', async () => {
    const { editor } = await seededEditor([stop]);
    editor.begin('stop-1');
    const base = {
      positions: [position],
      chartOrders: [stop],
      resolveContract: () => contract,
      editor,
    };

    const inDomain = renderWorkspace({ ...base, visiblePriceRange: { min: 1, max: 2 } });
    expect(inDomain).not.toContain('Show on chart');

    const otherChart = renderWorkspace({
      ...base,
      chartSymbol: 'QQQ',
      visiblePriceRange: { min: 400, max: 500 },
    });
    expect(otherChart).not.toContain('Show on chart');
  });

  it('saves by id with the edited trigger price (line visibility is irrelevant)', async () => {
    const { api, editor } = await seededEditor([stop]);
    editor.begin('stop-1');

    editor.setPriceText('2.25');
    await editor.save();

    expect(api.updateChartOrder).toHaveBeenCalledWith('stop-1', { triggerPrice: 2.25 });
    expect(editor.getState().draft).toBeNull();
  });

  it('patches quantity too — the update API supports it', async () => {
    const { api, editor } = await seededEditor([stop]);
    editor.begin('stop-1');

    editor.setQuantity(3);
    await editor.save();

    expect(api.updateChartOrder).toHaveBeenCalledWith('stop-1', { quantity: 3 });
  });

  it('cancel discards the draft without touching the order', async () => {
    const { api, store, editor } = await seededEditor([stop]);
    editor.begin('stop-1');
    editor.setPriceText('9.99');

    editor.cancel();

    expect(api.updateChartOrder).not.toHaveBeenCalled();
    expect(editor.getState().draft).toBeNull();
    expect(store.getState().selectedId).toBeNull();
    expect(store.byId('stop-1')?.triggerPrice).toBe(1.5);
  });

  it('closes with a stale notice when the leg fires mid-edit', async () => {
    const { editor, store } = await seededEditor([stop]);
    editor.begin('stop-1');

    store.applyServerUpdate({ ...stop, status: 'triggered', brokerOrderId: 'B-1' });

    expect(editor.getState().draft).toBeNull();
    expect(editor.getState().staleNotice).toContain('This stop fired while you were editing');
    const markup = renderWorkspace({ editor });
    expect(markup).toContain('role="status"');
    expect(markup).toContain('This stop fired while you were editing');
  });

  it('closes with a stale notice when the leg is cancelled mid-edit', async () => {
    const { editor, store } = await seededEditor([target]);
    editor.begin('target-1');

    store.applyServerUpdate({ ...target, status: 'cancelled' });

    expect(editor.getState().draft).toBeNull();
    expect(editor.getState().staleNotice).toContain('This target is no longer working');
  });

  it('survives a refresh replacing row instances — the session is keyed by id', async () => {
    const { api, store, editor } = await seededEditor([stop]);
    editor.begin('stop-1');

    api.chartOrders.mockResolvedValueOnce([{ ...stop }]); // fresh instances, same id
    await store.load();

    expect(editor.getState().draft?.id).toBe('stop-1');
    editor.setPriceText('2.25');
    await editor.save();
    expect(api.updateChartOrder).toHaveBeenCalledWith('stop-1', { triggerPrice: 2.25 });
  });

  it('keeps the draft up and surfaces the store error on a failed save', async () => {
    const { api, editor } = await seededEditor([stop]);
    editor.begin('stop-1');
    api.updateChartOrder.mockRejectedValueOnce(new Error('level already crossed'));

    editor.setPriceText('2.25');
    await editor.save();

    expect(editor.getState().draft?.id).toBe('stop-1');
    expect(editor.getState().saveError).toBe('level already crossed');
    const markup = renderWorkspace({ chartOrders: [stop], editor });
    expect(markup).toContain('level already crossed');
  });

  it('refuses to begin for a missing or non-working id', async () => {
    const { editor } = await seededEditor([{ ...stop, status: 'triggered' }]);

    editor.begin('nope');
    editor.begin('stop-1');

    expect(editor.getState().draft).toBeNull();
  });
});
