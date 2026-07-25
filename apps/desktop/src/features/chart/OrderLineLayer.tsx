import { useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { ChartOrder, OptionContract, Position } from '@0dtetrader/shared-types';
import { bracketKindFor } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { Format } from '../../design/format';
import { chartPalette } from './chartColors';
import type { ChartCandle } from './ChartStore';
import type { ChartOrdersStore } from './chartOrders';
import { kindLabel, orderTypeLabel } from './chartOrders';
import type { ChartTradingSettings } from './chartTradingSettings';
import { OrderPlacementPopover } from './OrderPlacementPopover';
import {
  hitRows,
  layoutRow,
  LINE_HIT_DISTANCE,
  type LineRow,
  type PillKey,
  ROW_HEIGHT,
  ROW_RIGHT_MARGIN,
} from './orderLineGeometry';

const FONT = '11px ui-monospace, "SF Mono", Menlo, monospace';
/** How far a drag off the entry line must travel before it becomes a bracket. */
const BRACKET_DRAG_THRESHOLD = 12;

interface OrderLineLayerProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  store: ChartOrdersStore;
  settings: ChartTradingSettings;
  /** Chart symbol; only lines and positions on this underlying are drawn. */
  symbol: string;
  positions: Position[];
  /** Resolves a position's OCC symbol to chain data (TradeScreen wires this to
   *  the loaded chain, same as TradeStore's flatten resolver). */
  resolveContract: (contractSymbol: string) => OptionContract | null;
  /** Contract a newly placed line trades — the trade panel's current selection. */
  selectedContract: OptionContract | null;
  /** Execution type a new line inherits from the panel. */
  defaultOrderType: 'mid' | 'market';
  onFlatten: (position: Position) => void;
  /** Live candles: repainting is event-driven, and data moves price→y. */
  candles: ChartCandle[];
  /** Keeps rows clear of the options-analytics rail when it is on. */
  rightInset: number;
}

interface EntryLine {
  position: Position;
  contract: OptionContract;
  price: number;
}

interface DragState {
  kind: 'move' | 'bracket';
  id: string;
  startY: number;
  /** For a bracket drag: the entry line it was pulled from. */
  entry?: EntryLine;
  price: number;
}

/**
 * TradingView-style order lines drawn above the candles: a live entry line per
 * open position (quantity, P/L, and a one-click close), and every working
 * order line with its quantity, kind, execution type, and cancel.
 *
 * Sits above DrawingLayer — an order line must win the pointer, because
 * mis-grabbing a trend line when you meant to move a stop is the expensive
 * mistake. Geometry and hit-testing live in orderLineGeometry.ts.
 */
export function OrderLineLayer({
  chart,
  series,
  store,
  settings,
  symbol,
  positions,
  resolveContract,
  selectedContract,
  defaultOrderType,
  onFlatten,
  candles,
  rightInset,
}: OrderLineLayerProps) {
  const state = useStore(store);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scheduleRef = useRef<() => void>(() => {});
  /** Rows as last painted — hit-testing reads these so it can never disagree
   *  with what the user actually sees. */
  const rowsRef = useRef<LineRow[]>([]);
  const dragRef = useRef<DragState | null>(null);
  const hoverRef = useRef<{ id: string; pill: PillKey | null } | null>(null);
  /** Price row the pointer is on, which is where the `+` affordance appears. */
  const [plusPrice, setPlusPrice] = useState<number | null>(null);
  const [placementPrice, setPlacementPrice] = useState<number | null>(null);
  const [placementY, setPlacementY] = useState(0);

  // Latest props for the event handlers, which are bound once.
  const latest = useRef({
    settings,
    symbol,
    positions,
    resolveContract,
    selectedContract,
    defaultOrderType,
    onFlatten,
    rightInset,
  });
  latest.current = {
    settings,
    symbol,
    positions,
    resolveContract,
    selectedContract,
    defaultOrderType,
    onFlatten,
    rightInset,
  };

  /** Open positions on this underlying that have an anchor to draw at. */
  const entryLines = (): EntryLine[] => {
    const { positions: current, resolveContract: resolve, symbol: sym } = latest.current;
    const lines: EntryLine[] = [];
    for (const position of current) {
      if (position.quantity === 0 || position.underlyingEntryPrice === undefined) continue;
      const contract = resolve(position.symbol);
      if (!contract || contract.underlying !== sym) continue;
      lines.push({ position, contract, price: position.underlyingEntryPrice });
    }
    return lines;
  };

  const canvasXY = (event: PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) * canvas.clientWidth) / rect.width,
      y: ((event.clientY - rect.top) * canvas.clientHeight) / rect.height,
    };
  };

  // MARK: - Rendering

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const colors = chartPalette();
    let raf = 0;

    const pill = (
      ctx: CanvasRenderingContext2D,
      x: number,
      y: number,
      width: number,
      label: string,
      fill: string,
      text: string,
      emphasised: boolean,
    ) => {
      ctx.fillStyle = fill;
      roundRect(ctx, x, y - ROW_HEIGHT / 2, width, ROW_HEIGHT, 3);
      ctx.fill();
      if (emphasised) {
        ctx.strokeStyle = text;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + width / 2, y + 0.5);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    };

    const draw = () => {
      const pane = chart.paneSize();
      const axisWidth = chart.priceScale('left').width();
      const dpr = window.devicePixelRatio || 1;
      canvas.style.left = `${axisWidth}px`;
      canvas.style.width = `${pane.width}px`;
      canvas.style.height = `${pane.height}px`;
      if (canvas.width !== pane.width * dpr || canvas.height !== pane.height * dpr) {
        canvas.width = pane.width * dpr;
        canvas.height = pane.height * dpr;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, pane.width, pane.height);
      ctx.font = FONT;

      const rows: LineRow[] = [];
      const rightEdge = pane.width - ROW_RIGHT_MARGIN - latest.current.rightInset;
      const measure = (label: string) => ctx.measureText(label).width;
      const hovered = hoverRef.current;

      // Entry lines first, so a target or stop sitting on top of one wins the
      // pointer — the bracket legs are what you actually adjust.
      for (const entry of entryLines()) {
        const y = series.priceToCoordinate(entry.price);
        if (y === null) continue;
        const profitable = entry.position.unrealizedPnl >= 0;
        const color = profitable ? colors.pnlPositive : colors.pnlNegative;
        const pills = layoutRow(
          [
            { key: 'quantity', label: Format.signedQuantity(entry.position.quantity) },
            {
              key: 'pnl',
              label: `${Format.signedPrice(entry.position.unrealizedPnl)} USD`,
            },
            { key: 'close', label: '✕' },
          ],
          measure,
          rightEdge,
        );
        const row: LineRow = { id: `entry:${entry.position.symbol}`, y, pills, left: pills[0].x };
        rows.push(row);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(row.left - 4, y);
        ctx.stroke();

        for (const p of pills) {
          const isQuantity = p.key === 'quantity';
          pill(
            ctx,
            p.x,
            y,
            p.width,
            p.label,
            isQuantity || p.key === 'close' ? color : colors.tagText,
            isQuantity || p.key === 'close' ? colors.tagText : color,
            hovered?.id === row.id && hovered.pill === p.key,
          );
        }
      }

      // Order lines.
      for (const order of store.visibleOrders) {
        const y = series.priceToCoordinate(order.triggerPrice);
        if (y === null) continue;
        const color =
          order.status === 'failed'
            ? colors.pnlNegative
            : order.kind === 'target'
              ? colors.pnlPositive
              : order.kind === 'stop'
                ? colors.pnlNegative
                : colors.orderLimit;
        const working = order.status === 'working';
        const labels: Array<{ key: PillKey; label: string }> = [
          { key: 'quantity', label: String(order.quantity) },
          { key: 'kind', label: statusLabel(order) },
        ];
        if (working) labels.push({ key: 'orderType', label: orderTypeLabel(order.orderType) });
        labels.push({ key: 'close', label: '✕' });
        const pills = layoutRow(labels, measure, rightEdge);
        const row: LineRow = { id: order.id, y, pills, left: pills[0].x };
        rows.push(row);

        ctx.globalAlpha = working ? 1 : 0.6;
        ctx.strokeStyle = color;
        // Read the live store, not the `state` snapshot: this closure is built
        // once in the mount effect, so a captured `state` would pin selectedId
        // at its mount-time value and the selection highlight would never draw.
        ctx.lineWidth = store.getState().selectedId === order.id ? 2 : 1.25;
        ctx.setLineDash(order.kind === 'stop' ? [6, 4] : []);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(row.left - 4, y);
        ctx.stroke();
        ctx.setLineDash([]);

        for (const p of pills) {
          // The execution pill is the one that changes what happens when this
          // line fires, so it is filled — the eye should land on it.
          const filled = p.key === 'quantity' || p.key === 'close' || p.key === 'orderType';
          pill(
            ctx,
            p.x,
            y,
            p.width,
            p.label,
            filled ? color : colors.tagText,
            filled ? colors.tagText : color,
            hovered?.id === row.id && hovered.pill === p.key,
          );
        }
        ctx.globalAlpha = 1;
      }

      // Bracket drag preview.
      const drag = dragRef.current;
      if (drag?.kind === 'bracket' && drag.entry) {
        const y = series.priceToCoordinate(drag.price);
        if (y !== null) {
          const kind = bracketKindFor(
            drag.entry.contract.optionType,
            drag.entry.position.quantity,
            drag.entry.price,
            drag.price,
          );
          ctx.strokeStyle = kind === 'target' ? colors.pnlPositive : colors.pnlNegative;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([6, 4]);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(pane.width, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = kind === 'target' ? colors.pnlPositive : colors.pnlNegative;
          ctx.fillText(
            `${kind === 'target' ? 'TARGET' : 'STOP'} ${Format.price(drag.price)}`,
            8,
            y - 6,
          );
        }
      }

      rowsRef.current = rows;
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
      });
    };
    scheduleRef.current = schedule;

    const unsubStore = store.subscribe(schedule);
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    chart.subscribeCrosshairMove(schedule);
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(canvas.parentElement as Element);
    schedule();

    return () => {
      scheduleRef.current = () => {};
      unsubStore();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      chart.unsubscribeCrosshairMove(schedule);
      resizeObserver.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [chart, series, store]);

  // Positions, P/L and the selection all change what is painted.
  useEffect(() => {
    scheduleRef.current();
  }, [candles, positions, state, symbol, rightInset]);

  // MARK: - Pointer handling

  useEffect(() => {
    const canvas = canvasRef.current;
    const containerEl = canvas?.parentElement;
    if (!canvas || !containerEl) return;

    const onPointerDown = (event: PointerEvent) => {
      const xy = canvasXY(event);
      if (!xy) return;
      const hit = hitRows(rowsRef.current, xy.x, xy.y);
      if (!hit) return;
      // Claim the gesture before lightweight-charts (and DrawingLayer) can pan.
      event.preventDefault();
      event.stopPropagation();

      const entryId = hit.row.id.startsWith('entry:') ? hit.row.id.slice(6) : null;

      if (hit.pill === 'close') {
        if (entryId) {
          const entry = entryLines().find((e) => e.position.symbol === entryId);
          if (entry) latest.current.onFlatten(entry.position);
        } else {
          void store.cancel(hit.row.id);
        }
        return;
      }
      if (hit.pill === 'orderType') {
        void store.toggleOrderType(hit.row.id);
        return;
      }
      if (hit.pill === 'quantity' || hit.pill === 'pnl') return; // labels, not controls

      // Line body: drag it.
      if (entryId) {
        if (!latest.current.settings.bracketDrag) return;
        const entry = entryLines().find((e) => e.position.symbol === entryId);
        if (!entry) return;
        dragRef.current = {
          kind: 'bracket',
          id: entryId,
          startY: xy.y,
          entry,
          price: entry.price,
        };
      } else {
        const order = store.byId(hit.row.id);
        if (!order || order.status !== 'working') return;
        store.select(order.id);
        dragRef.current = { kind: 'move', id: order.id, startY: xy.y, price: order.triggerPrice };
      }

      const onMove = (moveEvent: PointerEvent) => {
        const drag = dragRef.current;
        const moveXY = canvasXY(moveEvent);
        if (!drag || !moveXY) return;
        const price = series.coordinateToPrice(moveXY.y);
        if (price === null) return;
        // A bracket only materialises once the pointer has actually travelled,
        // so a click on the entry line does not drop a stop on top of it.
        if (drag.kind === 'bracket' && Math.abs(moveXY.y - drag.startY) < BRACKET_DRAG_THRESHOLD) {
          return;
        }
        drag.price = price;
        scheduleRef.current();
      };

      const onUp = () => {
        const drag = dragRef.current;
        dragRef.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (!drag) return;
        if (drag.kind === 'move') {
          if (drag.price !== store.byId(drag.id)?.triggerPrice)
            void store.move(drag.id, drag.price);
        } else if (drag.entry && drag.price !== drag.entry.price) {
          void placeBracket(drag.entry, drag.price);
        }
        scheduleRef.current();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    const onHover = (event: PointerEvent) => {
      const xy = canvasXY(event);
      if (!xy) {
        setPlusPrice(null);
        return;
      }
      const hit = hitRows(rowsRef.current, xy.x, xy.y);
      const next = hit ? { id: hit.row.id, pill: hit.pill } : null;
      if (next?.id !== hoverRef.current?.id || next?.pill !== hoverRef.current?.pill) {
        hoverRef.current = next;
        scheduleRef.current();
      }
      containerEl.style.cursor = hit ? (hit.pill ? 'pointer' : 'ns-resize') : '';

      // TradingView's price-axis `+`: hovering an empty row offers to place a
      // line right there. Suppressed over an existing row so it never covers
      // the controls the pointer is already aimed at.
      if (hit || dragRef.current) {
        setPlusPrice(null);
        return;
      }
      const price = series.coordinateToPrice(xy.y);
      setPlusPrice(price);
      setPlacementY(xy.y);
    };

    const onLeave = () => {
      setPlusPrice(null);
      if (hoverRef.current) {
        hoverRef.current = null;
        scheduleRef.current();
      }
    };

    containerEl.addEventListener('pointerdown', onPointerDown, true);
    containerEl.addEventListener('pointermove', onHover);
    containerEl.addEventListener('pointerleave', onLeave);
    return () => {
      containerEl.removeEventListener('pointerdown', onPointerDown, true);
      containerEl.removeEventListener('pointermove', onHover);
      containerEl.removeEventListener('pointerleave', onLeave);
      containerEl.style.cursor = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, store]);

  /** Commits a bracket leg dragged off an entry line into the position's OCO group. */
  const placeBracket = async (entry: EntryLine, price: number) => {
    const kind = bracketKindFor(
      entry.contract.optionType,
      entry.position.quantity,
      entry.price,
      price,
    );
    // Both legs of one position share a group, so filling either retires the
    // other. Reuse the group an existing leg already established.
    const existing = store
      .getState()
      .orders.find(
        (order) =>
          order.contractSymbol === entry.position.symbol &&
          order.ocoGroupId !== null &&
          order.status === 'working',
      );
    await store.create({
      underlying: entry.contract.underlying,
      triggerPrice: round2(price),
      // Closing an existing position: the opposite side, sized to it.
      side: entry.position.quantity > 0 ? 'sell' : 'buy',
      quantity: Math.abs(entry.position.quantity),
      orderType: latest.current.defaultOrderType,
      kind,
      optionType: entry.contract.optionType,
      expiration: entry.contract.expiration,
      strike: entry.contract.strike,
      ocoGroupId: existing?.ocoGroupId ?? crypto.randomUUID(),
    });
  };

  const plusVisible = plusPrice !== null && settings.enabled && selectedContract !== null;

  return (
    <>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`Chart order lines: ${store.visibleOrders.length} working orders.`}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          zIndex: 4,
          pointerEvents: 'none',
        }}
      />
      {plusVisible ? (
        <button
          type="button"
          aria-label={`Place an order at ${Format.price(plusPrice)}`}
          onClick={() => {
            setPlacementPrice(plusPrice);
            setPlusPrice(null);
          }}
          style={{
            position: 'absolute',
            right: 4 + rightInset,
            top: placementY - 11,
            zIndex: 5,
            width: 22,
            height: 22,
            borderRadius: 11,
            border: '1px solid var(--hud-stroke-dim)',
            background: 'var(--app-surface, #101826)',
            color: 'var(--label-primary)',
            fontSize: 14,
            lineHeight: '18px',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          +
        </button>
      ) : null}
      {placementPrice !== null && selectedContract ? (
        <OrderPlacementPopover
          price={placementPrice}
          top={placementY}
          rightInset={rightInset}
          contract={selectedContract}
          defaultQuantity={settings.defaultQuantity}
          defaultOrderType={defaultOrderType}
          onCancel={() => setPlacementPrice(null)}
          onPlace={async (input) => {
            await store.create({
              underlying: selectedContract.underlying,
              triggerPrice: round2(placementPrice),
              side: input.side,
              quantity: input.quantity,
              orderType: input.orderType,
              kind: 'limit',
              optionType: selectedContract.optionType,
              expiration: selectedContract.expiration,
              strike: selectedContract.strike,
            });
            setPlacementPrice(null);
          }}
        />
      ) : null}
    </>
  );
}

/** What the kind pill says: a fired line reports where it got to instead. */
function statusLabel(order: ChartOrder): string {
  if (order.status === 'failed') return 'FAILED';
  // A triggered line that has not filled is still exposed — saying "SENT" would
  // read as done, which is exactly the wrong impression for an unfilled stop.
  if (order.status === 'triggered') return 'WORKING';
  return kindLabel(order.kind);
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export { LINE_HIT_DISTANCE };
