import type {
  ChartOrder,
  ChartOrderDraft,
  ChartOrderKind,
  ChartOrderType,
  OptionContract,
  Position,
} from '@0dtetrader/shared-types';
import { chartOrderCrossed } from '@0dtetrader/shared-types';
import type { ApiClient } from '../../core/api/ApiClient';
import { Store } from '../../core/observable';

interface ChartOrdersState {
  /** Chart symbol currently displayed; lines for other underlyings stay loaded
   *  but are not rendered (the store is the whole account's working set). */
  symbol: string;
  orders: ChartOrder[];
  selectedId: string | null;
  error: string | null;
}

/** Lines that can still fire, and are therefore drawn solid and draggable. */
export function isWorking(order: ChartOrder): boolean {
  return order.status === 'working';
}

/** Lines worth drawing at all — working, plus recently terminal ones so a
 *  failed fire stays on the chart instead of silently vanishing. */
export function isVisible(order: ChartOrder): boolean {
  return order.status === 'working' || order.status === 'triggered' || order.status === 'failed';
}

/**
 * Chart order lines (ChartOrders.swift analog). The server is the source of
 * truth — every mutation is a request, and the response replaces the local row.
 *
 * Triggering is deliberately *not* a local order submission: when the quote
 * stream crosses a level the store asks the server to fire that line, so the
 * client and the server-side watcher take the identical path and one crossing
 * can only ever produce one broker order.
 */
export class ChartOrdersStore extends Store<ChartOrdersState> {
  /** Lines with a trigger request in flight, so a burst of ticks fires once. */
  private readonly firing = new Set<string>();
  /** Bumped per load so a superseded snapshot cannot land after a newer one. */
  private loadSeq = 0;
  /** Ids the socket updated while a load was in flight. The push is strictly
   *  newer than the read that produced the snapshot, so it must win. */
  private readonly pushedDuringLoad = new Set<string>();
  /** Last price seen per underlying, the left end of the crossing segment. */
  private readonly lastPrices = new Map<string, number>();

  constructor(private readonly apiClient: ApiClient) {
    super({ symbol: '', orders: [], selectedId: null, error: null });
  }

  /** Lines drawn on the current chart. */
  get visibleOrders(): ChartOrder[] {
    const { symbol, orders } = this.getState();
    return orders.filter((order) => order.underlying === symbol && isVisible(order));
  }

  byId(id: string): ChartOrder | undefined {
    return this.getState().orders.find((order) => order.id === id);
  }

  setSymbol(symbol: string): void {
    if (symbol === this.getState().symbol) return;
    this.set({ symbol, selectedId: null });
  }

  select(id: string | null): void {
    this.set({ selectedId: id });
  }

  /**
   * Re-reads the account's lines. Called on mount and on every socket
   * reconnect, because pushes that landed while the stream was down are gone
   * for good.
   *
   * Merges rather than replaces. A snapshot is a read from some instant before
   * it arrived, so a push that overtook it in flight is newer — replacing
   * wholesale would resurrect a line the watcher just fired or cancelled.
   */
  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.pushedDuringLoad.clear();
    try {
      const snapshot = await this.apiClient.chartOrders();
      if (seq !== this.loadSeq) return; // a newer load superseded this one
      const current = this.getState().orders;
      const orders = snapshot.filter((order) => !this.pushedDuringLoad.has(order.id));
      // Re-apply what the socket told us mid-flight. A pushed line that is no
      // longer in local state was retired — it must stay gone, not come back.
      for (const id of this.pushedDuringLoad) {
        const pushed = current.find((order) => order.id === id);
        if (pushed) orders.push(pushed);
      }
      this.pushedDuringLoad.clear();
      this.set({ orders, error: null });
    } catch (error) {
      if (seq !== this.loadSeq) return;
      this.set({ error: messageOf(error) });
    }
  }

  /** Clears everything — used when the trading mode changes, since practice and
   *  live lines are separate sets and must never be shown together. */
  reset(): void {
    this.firing.clear();
    this.lastPrices.clear();
    this.pushedDuringLoad.clear();
    this.loadSeq += 1; // discard any snapshot still in flight for the old account
    this.set({ orders: [], selectedId: null, error: null });
  }

  async create(draft: ChartOrderDraft): Promise<ChartOrder | null> {
    try {
      const order = await this.apiClient.createChartOrder(draft);
      this.upsert(order);
      this.set({ error: null, selectedId: order.id });
      return order;
    } catch (error) {
      this.set({ error: messageOf(error) });
      return null;
    }
  }

  /** Commits a drag. The server re-arms from the live quote, so the returned
   *  row (not the dragged-to price) is what gets stored. */
  async move(id: string, triggerPrice: number): Promise<void> {
    await this.patch(id, { triggerPrice });
  }

  async setQuantity(id: string, quantity: number): Promise<void> {
    await this.patch(id, { quantity });
  }

  /** Flips MID ↔ MKT for one line, optimistically so the pill responds instantly. */
  async toggleOrderType(id: string): Promise<void> {
    const current = this.byId(id);
    if (!current || !isWorking(current)) return;
    const orderType: ChartOrderType = current.orderType === 'mid' ? 'market' : 'mid';
    this.upsert({ ...current, orderType });
    try {
      this.upsert(await this.apiClient.updateChartOrder(id, { orderType }));
      this.set({ error: null });
    } catch (error) {
      this.upsert(current); // revert
      this.set({ error: messageOf(error) });
    }
  }

  /**
   * The ✕ on a line. A working line is cancelled server-side; a terminal one
   * (a failed fire, or one the watcher already sent) has nothing to cancel, so
   * ✕ simply dismisses it from the chart — otherwise a failed line would sit
   * there un-clearable, telling the user nothing they can act on.
   */
  async cancel(id: string): Promise<void> {
    const current = this.byId(id);
    if (current && !isWorking(current)) {
      this.remove(id);
      return;
    }
    try {
      await this.apiClient.cancelChartOrder(id);
      this.remove(id);
      this.set({ error: null });
    } catch (error) {
      // A line the watcher fired between the render and this click is no longer
      // cancellable; reload so the chart shows what actually happened.
      if (current) void this.load();
      this.set({ error: messageOf(error) });
    }
  }

  /** Server-side watcher pushed a state change over the socket. */
  applyServerUpdate(order: ChartOrder): void {
    this.firing.delete(order.id);
    this.pushedDuringLoad.add(order.id);
    if (isVisible(order)) this.upsert(order);
    else this.remove(order.id);
  }

  /**
   * Feeds a live tick in. Lines whose level the move crossed are fired through
   * the server immediately rather than waiting on the watcher's poll.
   *
   * The segment tested starts at the last price this client actually saw — or
   * the line's own `armPrice` when it has not seen one yet — so a reconnect or
   * a backgrounded tab cannot step over a level unnoticed.
   */
  applyQuote(underlying: string, last: number): void {
    if (!Number.isFinite(last) || last <= 0) return;
    const previous = this.lastPrices.get(underlying);
    this.lastPrices.set(underlying, last);

    for (const order of this.getState().orders) {
      if (order.underlying !== underlying || !isWorking(order)) continue;
      if (this.firing.has(order.id)) continue;
      const from = previous ?? order.armPrice;
      if (!chartOrderCrossed(order, from, last)) continue;
      void this.trigger(order.id);
    }
  }

  private async trigger(id: string): Promise<void> {
    this.firing.add(id);
    try {
      this.upsert(await this.apiClient.triggerChartOrder(id));
      this.set({ error: null });
    } catch (error) {
      // The watcher is still armed on this line, so a failed nudge is not the
      // end of the road — surface it and let the server path carry it.
      this.set({ error: messageOf(error) });
    } finally {
      this.firing.delete(id);
    }
  }

  private upsert(order: ChartOrder): void {
    const orders = this.getState().orders;
    const index = orders.findIndex((existing) => existing.id === order.id);
    this.set({
      orders:
        index === -1 ? [...orders, order] : orders.map((e) => (e.id === order.id ? order : e)),
    });
  }

  private remove(id: string): void {
    const { orders, selectedId } = this.getState();
    this.set({
      orders: orders.filter((order) => order.id !== id),
      selectedId: selectedId === id ? null : selectedId,
    });
  }

  private async patch(
    id: string,
    body: { triggerPrice?: number; quantity?: number },
  ): Promise<void> {
    try {
      this.upsert(await this.apiClient.updateChartOrder(id, body));
      this.set({ error: null });
    } catch (error) {
      void this.load(); // snap back to the server's view of the line
      this.set({ error: messageOf(error) });
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Working lines already protecting `contractSymbol` inside an OCO group. */
export function workingBracketSiblings(orders: ChartOrder[], contractSymbol: string): ChartOrder[] {
  return orders.filter(
    (order) =>
      order.contractSymbol === contractSymbol && order.ocoGroupId !== null && isWorking(order),
  );
}

/**
 * Draft for a new bracket leg (target/stop) protecting an existing position:
 * the opposite side, sized to the full position. Both legs of one position
 * share an OCO group, so filling either retires the other — the draft reuses
 * the group an existing working sibling already established, else mints a new
 * one. Shared by the chart's bracket drag and the trade-management
 * workspace's Set stop / Set target actions, so the group-reuse rule lives in
 * exactly one place.
 */
export function bracketLegDraft(input: {
  contract: OptionContract;
  position: Position;
  triggerPrice: number;
  kind: ChartOrderKind;
  orderType: ChartOrderType;
  /** All known lines; the sibling scan filters them itself. */
  orders: ChartOrder[];
}): ChartOrderDraft {
  const siblings = workingBracketSiblings(input.orders, input.position.symbol);
  return {
    underlying: input.contract.underlying,
    triggerPrice: input.triggerPrice,
    side: input.position.quantity > 0 ? 'sell' : 'buy',
    quantity: Math.abs(input.position.quantity),
    orderType: input.orderType,
    kind: input.kind,
    optionType: input.contract.optionType,
    expiration: input.contract.expiration,
    strike: input.contract.strike,
    ocoGroupId: siblings[0]?.ocoGroupId ?? crypto.randomUUID(),
  };
}

/** Short label for the kind pill: the line's colour already carries most of this. */
export function kindLabel(kind: ChartOrderKind): string {
  if (kind === 'target') return 'TP';
  if (kind === 'stop') return 'STP';
  return 'LMT';
}

/** The tappable execution pill. `MKT` is deliberately abbreviated so the pill
 *  stays the same width in both states and the row does not jump on toggle. */
export function orderTypeLabel(orderType: ChartOrderType): string {
  return orderType === 'market' ? 'MKT' : 'MID';
}
