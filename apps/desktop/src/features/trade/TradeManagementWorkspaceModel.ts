import type {
  ChartOrder,
  ChartOrderKind,
  ChartOrderStatus,
  ChartOrderType,
  OptionType,
  OrderSide,
  Position,
  TradeHistoryEntry,
} from '@0dtetrader/shared-types';
import { positionProfitDirection } from '@0dtetrader/shared-types';
import { parseDateTime } from '../../core/models/dates';
import { parsePriceInput, roundToTick } from '../../core/models/priceInput';
import { Store } from '../../core/observable';
import { isWorking, type ChartOrdersStore } from '../chart/chartOrders';
import { Format } from '../../design/format';

/** What "Move stop to entry" would do: move `stop` to the position's
 *  underlying entry. Null when there is no stop line, no entry anchor, no
 *  live price, no known option type — or when the entry is NOT on the loss
 *  side of the live price: a "stop" moved to the profit side of the market
 *  arms as a break-even recovery exit, firing when the position comes BACK,
 *  which is the opposite of what the button's label promises. Null is exactly
 *  when the button disables, so gate and action agree. */
export function moveStopToEntryRequest(
  position: Position,
  stop: ChartOrder | null,
  underlyingPrice: number | null,
  optionType: OptionType | null,
): { order: ChartOrder; triggerPrice: number } | null {
  if (!stop || position.underlyingEntryPrice === undefined) return null;
  if (underlyingPrice === null || optionType === null) return null;
  const direction = positionProfitDirection(optionType, position.quantity);
  if ((underlyingPrice - position.underlyingEntryPrice) * direction <= 0) return null;
  return { order: stop, triggerPrice: position.underlyingEntryPrice };
}

export function signedCurrency(value: number): string {
  if (value === 0) return `$${Format.price(0)}`;
  return value < 0 ? `-$${Format.price(Math.abs(value))}` : `+$${Format.price(value)}`;
}

/** `4m` / `1h 12m` since the position run opened; an em dash when unknown. */
export function timeInTrade(position: Position, now = Date.now()): string {
  if (!position.openedAt) return '—';
  const opened = parseDateTime(position.openedAt);
  if (opened === null) return '—';
  const minutes = Math.max(0, Math.floor((now - opened) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function pnlPercent(position: Position): number {
  const basis = Math.abs(position.avgPrice * position.quantity * position.multiplier);
  return basis > 0 ? (position.unrealizedPnl / basis) * 100 : 0;
}

/**
 * Day P&L = unrealized P&L on currently-open positions + realized P&L from
 * fills that closed a position earlier today. `history.totalRealizedPnl` is
 * all-time, so today's closing fills are picked out by `timestamp` here
 * instead — a position closed and reopened (or closed for good) earlier
 * today must still count, even though it no longer appears in `positions`.
 */
export function dayPnl(positions: Position[], history: TradeHistoryEntry[] = []): number {
  const unrealized = positions.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const realizedToday = history.reduce((sum, entry) => {
    if (entry.realizedPnl === null) return sum;
    const filledAt = new Date(entry.timestamp);
    if (Number.isNaN(filledAt.getTime()) || filledAt < startOfDay) return sum;
    return sum + entry.realizedPnl;
  }, 0);
  return unrealized + realizedToday;
}

/** The docked stop/target editor row's fixed height (see the matching
 *  `.trade-leg-editor` min-height). The workspace footer is a fixed-pixel
 *  flex row with nothing elastic in the collapsed case — 124 is exactly
 *  strip (88) + status bar (36) — so an unbudgeted row pushes the status
 *  bar below the viewport. */
export const EDITOR_ROW_HEIGHT = 44;

export function desktopTradeWorkspaceHeight({
  expanded,
  hasActivity,
  editorOpen = false,
}: {
  expanded: boolean;
  hasActivity: boolean;
  /** The docked editor OR its stale notice is showing (they share the row
   *  and are mutually exclusive). */
  editorOpen?: boolean;
}): number {
  const editorExtra = editorOpen ? EDITOR_ROW_HEIGHT : 0;
  if (expanded) return 220 + editorExtra;
  return (hasActivity ? 124 : 36) + editorExtra;
}

/** Snapshot taken when Edit was chosen — display and change detection only;
 *  the save re-reads the live row from the store by id. */
export interface StopTargetDraft {
  id: string;
  kind: ChartOrderKind;
  side: OrderSide;
  orderType: ChartOrderType;
  underlying: string;
  contractSymbol: string;
  triggerPrice: number;
  quantity: number;
}

interface StopTargetEditorState {
  draft: StopTargetDraft | null;
  /** The price field's raw text (see priceInput.ts for why text, not number). */
  priceText: string;
  /** Quantity as edited. */
  quantity: number;
  saving: boolean;
  /** The store's error from the last failed save, shown inside the editor. */
  saveError: string | null;
  /** The edited order left the working set; shown until dismissed. */
  staleNotice: string | null;
}

/**
 * Workspace-owned editing session for one stop/target leg — the docked editor
 * in TradeManagementWorkspace, so a line outside the chart's visible domain is
 * still editable. Holds only the order's id plus edit buffers: every read goes
 * back through the chart-orders store by id, so a refresh replacing row
 * instances cannot orphan the session, and a save patches the live row rather
 * than a stale snapshot. The chart line stays the drag surface; this is the
 * type-a-number one.
 */
export class StopTargetEditorStore extends Store<StopTargetEditorState> {
  constructor(private readonly chartOrders: ChartOrdersStore) {
    super({
      draft: null,
      priceText: '',
      quantity: 1,
      saving: false,
      saveError: null,
      staleNotice: null,
    });
    // The order can fill or be cancelled while the editor is open; watching
    // the store is what closes the session instead of letting it save into a
    // leg that no longer exists.
    chartOrders.subscribe(() => this.reconcile());
  }

  /** Opens the editor for a working line. No-op when the id no longer names
   *  one — the caller's row was stale, and the watcher already said so. */
  begin(id: string): void {
    const order = this.chartOrders.byId(id);
    if (!order || !isWorking(order)) return;
    // Same selection the drag path sets, so the chart line stays highlighted
    // while it is in view.
    this.chartOrders.select(id);
    this.set({
      draft: {
        id: order.id,
        kind: order.kind,
        side: order.side,
        orderType: order.orderType,
        underlying: order.underlying,
        contractSymbol: order.contractSymbol,
        triggerPrice: order.triggerPrice,
        quantity: order.quantity,
      },
      priceText: String(order.triggerPrice),
      quantity: order.quantity,
      saveError: null,
      staleNotice: null,
    });
  }

  setPriceText(text: string): void {
    if (this.getState().draft === null) return;
    this.set({ priceText: text, saveError: null });
  }

  setQuantity(quantity: number): void {
    if (this.getState().draft === null) return;
    this.set({ quantity, saveError: null });
  }

  /** Discards the draft without touching the order. */
  cancel(): void {
    this.close();
  }

  dismissStaleNotice(): void {
    this.set({ staleNotice: null });
  }

  /**
   * Submits changed fields as one patch against the live row — re-read by id
   * now, not the Edit-time snapshot, since the server may have re-armed it or
   * a drag may have moved it. Success closes the editor; failure keeps the
   * draft up and copies the store's error into it.
   */
  async save(): Promise<void> {
    const { draft, priceText, quantity, saving } = this.getState();
    if (!draft || saving) return;
    const price = parsePriceInput(priceText);
    if (price === null) return;
    const live = this.chartOrders.byId(draft.id);
    if (!live || !isWorking(live)) {
      this.closeStale(live ?? null, draft.kind);
      return;
    }
    const patch: { triggerPrice?: number; quantity?: number } = {};
    const rounded = roundToTick(price);
    if (rounded !== live.triggerPrice) patch.triggerPrice = rounded;
    if (quantity !== live.quantity) patch.quantity = quantity;
    if (patch.triggerPrice === undefined && patch.quantity === undefined) {
      this.close();
      return;
    }
    this.set({ saving: true, saveError: null });
    const failure = await this.chartOrders.update(draft.id, patch);
    // The watcher may have closed the session mid-flight (the line fired
    // while the patch was out); its stale notice must not be overwritten.
    if (this.getState().draft?.id !== draft.id) return;
    if (failure === null) this.close();
    else this.set({ saving: false, saveError: failure });
  }

  private reconcile(): void {
    const { draft } = this.getState();
    if (!draft) return;
    const live = this.chartOrders.byId(draft.id);
    if (live && isWorking(live)) return;
    this.closeStale(live ?? null, draft.kind);
  }

  private close(): void {
    const id = this.getState().draft?.id ?? null;
    this.set({ draft: null, saving: false, saveError: null });
    // Release only the highlight the editor itself put there.
    if (id !== null && this.chartOrders.getState().selectedId === id) {
      this.chartOrders.select(null);
    }
  }

  private closeStale(live: ChartOrder | null, kind: ChartOrderKind): void {
    this.close();
    this.set({ staleNotice: staleOrderNotice(kind, live?.status ?? null) });
  }
}

/** Why an open editor closed under the user. A removed row's fate is unknown
 *  here (fills and cancels both remove it), so the copy only claims what is. */
export function staleOrderNotice(kind: ChartOrderKind, status: ChartOrderStatus | null): string {
  const leg = kind === 'target' ? 'target' : 'stop';
  if (status === 'triggered') {
    return `This ${leg} fired while you were editing — nothing was saved.`;
  }
  return `This ${leg} is no longer working — it filled, was cancelled, or expired. Nothing was saved.`;
}
