import { useCallback, useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type {
  ChartOrder,
  ChartOrderType,
  OptionContract,
  Position,
} from '@0dtetrader/shared-types';
import { bracketKindFor } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { dayString } from '../../core/models/dates';
import { Format } from '../../design/format';
import { chartPalette } from './chartColors';
import {
  canBracketFromEntry,
  entryLineLabel,
  entryLineSource,
  entryLineStroke,
} from './entryLineStyle';
import { positionsForUnderlying } from './positionsForUnderlying';
import { isPointerClaimed } from './chartPointerClaim';
import type { ChartCandle } from './ChartStore';
import type { ChartOrdersStore } from './chartOrders';
import {
  bracketLegDraft,
  isWorking,
  kindLabel,
  orderTypeLabel,
  workingBracketSiblings,
} from './chartOrders';
import type { ChartTradingSettings } from './chartTradingSettings';
import { OrderPlacementPopover } from './OrderPlacementPopover';
import {
  GUIDE_ADJUST_PAGE,
  GUIDE_ADJUST_STEP,
  GUIDE_DRAG_THRESHOLD,
  guideDragFloor,
  PLUS_MARGIN,
  PLUS_SIZE,
  resolveGuidePrice,
} from './placementGuide';
import {
  hitRows,
  layoutRow,
  LINE_HIT_DISTANCE,
  type LineRow,
  type PillKey,
  PILL_GAP,
  ROW_HEIGHT,
  ROW_LINE_GAP,
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
  defaultOrderType: ChartOrderType;
  onFlatten: (position: Position) => void;
  /** Confirms cancelling a *working* line. Terminal lines are dismissed here
   *  without asking — they already reached the broker, so "nothing was sent"
   *  would misdescribe a live order (ChartTradingCoordinator does the same). */
  onCancelOrder: (order: ChartOrder) => void;
  /** Live candles: repainting is event-driven, and data moves price→y. */
  candles: ChartCandle[];
  /** Keeps rows clear of the options-analytics rail when it is on. */
  rightInset: number;
}

interface EntryLine {
  /** False when the level is the placement-derived estimate — display and
   *  close only, never bracket classification (see entryLineSource). */
  authoritative: boolean;
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
  onCancelOrder,
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
  /** Detaches the window-level drag listeners. A drag outlives the element it
   *  started on (the pointer leaves the canvas), so the listeners live on
   *  `window` — which means unmounting mid-drag has to tear them down here or
   *  they survive with a disposed series behind them. */
  const endDragRef = useRef<() => void>(() => {});
  const hoverRef = useRef<{ id: string; pill: PillKey | null } | null>(null);
  /** The guide's level, or null when no guide is showing — which is the resting
   *  state: a click on empty chart space summons it and the next one dismisses
   *  it. A ref, not state: it changes on every drag frame and the canvas is
   *  already repainting — re-rendering React at 60fps to move an
   *  absolutely-positioned button is pure waste. */
  const guidePriceRef = useRef<number | null>(null);
  const guideDragRef = useRef(false);
  /** A press is live. Guards against a second gesture attaching a second pair
   *  of window listeners and orphaning the first for the life of the page. */
  const guidePressRef = useRef(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const endGuideDragRef = useRef<() => void>(() => {});
  /** Level the open window refers to. State, because the window is React. */
  const [placementPrice, setPlacementPrice] = useState<number | null>(null);

  // Latest props for the event handlers, which are bound once.
  const latest = useRef({
    settings,
    symbol,
    positions,
    resolveContract,
    selectedContract,
    defaultOrderType,
    onFlatten,
    onCancelOrder,
    rightInset,
    placementPrice,
  });
  latest.current = {
    settings,
    symbol,
    positions,
    resolveContract,
    selectedContract,
    defaultOrderType,
    onFlatten,
    onCancelOrder,
    rightInset,
    placementPrice,
  };

  /** Open positions on this underlying that have an anchor to draw at. */
  const entryLines = (): EntryLine[] => {
    const { positions: current, resolveContract: resolve, symbol: sym } = latest.current;
    // The shared underlying filter wants the contracts themselves; this layer
    // holds a resolver, so materialise the resolvable ones first.
    const contracts = current
      .map((position) => resolve(position.symbol))
      .filter((contract): contract is OptionContract => contract !== null);
    const lines: EntryLine[] = [];
    for (const position of positionsForUnderlying(current, sym, contracts)) {
      // Display falls back to the placement-derived ESTIMATE; the
      // authoritative fill-time field (reserved, unset today) wins when it
      // exists. Provenance rides the line: an estimate draws and closes but
      // never classifies a bracket.
      const source = entryLineSource(position);
      if (position.quantity === 0 || source === null) continue;
      const contract = resolve(position.symbol);
      if (!contract) continue;
      lines.push({
        position,
        contract,
        price: source.price,
        authoritative: source.authoritative,
      });
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
      // The guide is resolved before the rows are laid out, because whether one
      // is showing decides how much room they get. It is suppressed outright
      // when there is no contract to trade, since arming a line against nothing
      // is not a state the user can act on.
      const guideOn = latest.current.settings.enabled && latest.current.selectedContract !== null;
      const open = latest.current.placementPrice;
      // While the window is open it owns the level (`open ?? …`), so the guide
      // does not shift underneath the number the user is editing.
      const guide = !guideOn
        ? null
        : (open ??
          resolveGuidePrice(guidePriceRef.current, {
            max: series.coordinateToPrice(0) ?? NaN,
            min: series.coordinateToPrice(pane.height) ?? NaN,
          }));
      guidePriceRef.current = guide;
      /** Left edge of the `+` handle: flush to the pane's right border. */
      const plusLeft = pane.width - PLUS_MARGIN - PLUS_SIZE;
      // Rows stop short of the handle rather than running under it, but only
      // while a handle is actually showing — it is summoned and dismissed, and
      // a band reserved against a control that is not there just costs every
      // row width for nothing. The band itself is not optional while it is:
      // the handle is a DOM button stacked above this canvas, so it takes the
      // click from any control it covers, and the rightmost control is ✕, which
      // cancels a live order. Resolving it the other way is not an option — a
      // row at the guide's level would make the handle unreachable, and the
      // handle is the only way to drag the guide.
      const rightEdge = Math.min(
        pane.width - ROW_RIGHT_MARGIN - latest.current.rightInset,
        guide !== null ? plusLeft - PILL_GAP / 2 : Infinity,
      );
      const measure = (label: string) => ctx.measureText(label).width;
      const hovered = hoverRef.current;

      /**
       * A row's line, in two segments: one to the left of its buttons and one
       * from their right edge out to the pane's border.
       *
       * Two segments rather than one stroke behind the row, because some pills
       * are outlined rather than filled — the kind pill on an order line, P/L on
       * an entry line — and a line drawn under those would show through their
       * interiors and strike through their text. The caller has already set
       * strokeStyle, lineWidth, dash and alpha, so both halves match by
       * construction: a stop stays dashed and a terminal line stays dimmed on
       * either side.
       *
       * It runs to the pane's true border rather than stopping at `rightInset`.
       * The rows clear the options-analytics rail because they are a block of
       * text it would collide with; a 1.25px line crossing a sparse profile
       * reads as a chart line, and stopping short would leave a stub a few
       * pixels long that nobody would recognise as the line continuing. The
       * placement guide already crosses the rail on the same reasoning.
       */
      const strokeRowLine = (row: LineRow) => {
        const last = row.pills[row.pills.length - 1];
        ctx.beginPath();
        ctx.moveTo(0, row.y);
        ctx.lineTo(row.left - ROW_LINE_GAP, row.y);
        ctx.moveTo(last.x + last.width + ROW_LINE_GAP, row.y);
        ctx.lineTo(pane.width, row.y);
        ctx.stroke();
      };

      // Entry lines first, so a target or stop sitting on top of one wins the
      // pointer — the bracket legs are what you actually adjust.
      const todayIso = dayString();
      for (const entry of entryLines()) {
        const y = series.priceToCoordinate(entry.price);
        if (y === null) continue;
        // The line wears the contract's direction (calls blue, puts red);
        // only the P/L pill keeps profit-sign coloring.
        const typeColor = entryLineStroke(entry.contract, colors);
        const pnlColor =
          entry.position.unrealizedPnl >= 0 ? colors.pnlPositive : colors.pnlNegative;
        const pills = layoutRow(
          [
            {
              key: 'label',
              // "~": approximate — the level is the placement estimate.
              label: (entry.authoritative ? '' : '~') + entryLineLabel(entry.contract, todayIso),
            },
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

        ctx.strokeStyle = typeColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([]);
        strokeRowLine(row);

        for (const p of pills) {
          const filled = p.key === 'quantity' || p.key === 'close';
          const color = p.key === 'pnl' ? pnlColor : typeColor;
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
      }

      // Order lines.
      for (const order of store.visibleOrders) {
        const y = series.priceToCoordinate(order.triggerPrice);
        if (y === null) continue;
        const color = orderLineColor(order, colors);
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
        strokeRowLine(row);
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

      // Placement guide: a dashed level with the `+` handle at its right edge,
      // shown only once a click on empty chart space has summoned one.
      const guideY = guide === null ? null : series.priceToCoordinate(guide);

      if (guide !== null && guideY !== null) {
        ctx.strokeStyle = colors.guide;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, guideY);
        ctx.lineTo(plusLeft, guideY);
        ctx.stroke();
        ctx.setLineDash([]);
        // The level only needs calling out while it is moving; the rest of the
        // time the price axis already says where the line is.
        if (guideDragRef.current) {
          ctx.fillStyle = colors.guide;
          ctx.fillText(Format.price(guide), 8, guideY - 6);
        }
      }

      const plus = plusRef.current;
      if (plus) {
        // Kept mounted, but dormant, whenever the guide could be summoned and
        // has not been: a keyboard user has no "click on empty chart space", so
        // without a focusable handle in the resting state chart order placement
        // would be pointer-only. The dormant style is invisible and
        // pointer-transparent, so a mouse never meets it.
        const dormant = guide === null || guideY === null;
        plus.style.display = guideOn ? 'flex' : 'none';
        plus.classList.toggle('order-guide-plus--dormant', dormant);
        // Flush to the pane's right border, not inset past the analytics rail.
        plus.style.right = `${PLUS_MARGIN}px`;
        plus.style.top = `${(dormant ? pane.height / 2 : guideY) - PLUS_SIZE / 2}px`;
        plus.setAttribute(
          'aria-label',
          dormant
            ? 'Show the order placement guide'
            : `Place an order at ${Format.price(guide as number)}`,
        );
        // While the window owns the level the handle does nothing, so it says
        // so rather than presenting a drag cursor it will not honour.
        plus.classList.toggle('order-guide-plus--inert', open !== null);
        plus.setAttribute('aria-disabled', open !== null ? 'true' : 'false');
      }
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
    // `selectedContract` and `placementPrice` gate the guide inside the draw
    // loop rather than in JSX, so a re-render alone would not repaint it.
  }, [candles, positions, state, symbol, rightInset, selectedContract, placementPrice]);

  // MARK: - Pointer handling

  useEffect(() => {
    const canvas = canvasRef.current;
    const containerEl = canvas?.parentElement;
    if (!canvas || !containerEl) return;

    /** Summons the guide at `y`, or dismisses the one already showing. */
    const toggleGuide = (y: number) => {
      const {
        settings: current,
        selectedContract: contract,
        placementPrice: open,
      } = latest.current;
      // The window owns the level while it is open; the same gate the guide is
      // drawn under applies to summoning it.
      if (open !== null || !current.enabled || contract === null) return;
      if (guidePriceRef.current !== null) {
        guidePriceRef.current = null;
      } else {
        const price = series.coordinateToPrice(y);
        if (price === null) return;
        guidePriceRef.current = price;
      }
      scheduleRef.current();
    };

    /**
     * A press that landed on nothing of ours. It may still turn out to be a
     * click on genuinely empty chart space, which is what summons and dismisses
     * the guide — so the decision is deferred to the release, for two reasons.
     * A press that travels is a pan, and a pan has no single level to place a
     * guide at; and whether another layer spent this press on a drawing is only
     * knowable once every `pointerdown` handler has run.
     */
    const armGuideToggle = (downEvent: PointerEvent, y: number) => {
      const startX = downEvent.clientX;
      const startY = downEvent.clientY;

      const detach = () => {
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancelled);
      };

      // Both ends filter on the pointer that started this, so a second finger
      // going up cannot resolve a press it was never part of.
      const onUp = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== downEvent.pointerId) return;
        detach();
        if (isPointerClaimed(downEvent)) return;
        // Clicks two and three of a triple-click are on their way to toggling
        // fullscreen. Summoning and dismissing the guide underneath that would
        // leave a level showing that nobody asked for; only the first click of
        // a run gets to move it. (`detail` is 0 for touch, which leaves the
        // touch route exactly as it was.)
        if (downEvent.detail >= 2) return;
        const travel = Math.hypot(upEvent.clientX - startX, upEvent.clientY - startY);
        if (travel > GUIDE_DRAG_THRESHOLD) return;
        toggleGuide(y);
      };

      const onCancelled = (cancelEvent: PointerEvent) => {
        if (cancelEvent.pointerId === downEvent.pointerId) detach();
      };

      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancelled);
    };

    const onPointerDown = (event: PointerEvent) => {
      // The `+` and the placement window live inside this container, so a row
      // at the same y would otherwise eat their press in the capture phase.
      if ((event.target as Element | null)?.closest('[data-chart-placement]')) return;
      const xy = canvasXY(event);
      if (!xy) return;
      const hit = hitRows(rowsRef.current, xy.x, xy.y);
      if (!hit) {
        if (event.button === 0) armGuideToggle(event, xy.y);
        return;
      }
      // Claim the gesture before lightweight-charts (and DrawingLayer) can pan.
      event.preventDefault();
      event.stopPropagation();

      const entryId = hit.row.id.startsWith('entry:') ? hit.row.id.slice(6) : null;

      if (hit.pill === 'close') {
        if (entryId) {
          const entry = entryLines().find((e) => e.position.symbol === entryId);
          if (entry) latest.current.onFlatten(entry.position);
        } else {
          const order = store.byId(hit.row.id);
          // A working line still holds intent the user may not mean to throw
          // away, so it goes through the same confirmation iOS shows. Terminal
          // lines have nothing to cancel — ✕ just clears them.
          if (order && isWorking(order)) latest.current.onCancelOrder(order);
          else void store.cancel(hit.row.id);
        }
        return;
      }
      if (hit.pill === 'orderType') {
        void store.toggleOrderType(hit.row.id);
        return;
      }
      if (hit.pill === 'quantity' || hit.pill === 'pnl' || hit.pill === 'label') return; // labels, not controls

      // Line body: drag it.
      if (entryId) {
        const entry = entryLines().find((e) => e.position.symbol === entryId);
        if (!entry) return;
        // An estimated entry cannot begin a bracket drag: classifying
        // target-vs-stop against a level that may sit on the wrong side of
        // the true fill would move the wrong OCO sibling. The ✕ close pill
        // above is untouched — flattening never consults the entry level.
        if (!canBracketFromEntry(entry, latest.current.settings.bracketDrag)) return;
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

      const detach = () => {
        endDragRef.current = () => {};
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };

      const onUp = () => {
        const drag = dragRef.current;
        dragRef.current = null;
        detach();
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
      // Unmounting mid-drag abandons the gesture rather than committing it: the
      // series these coordinates mean is going away.
      endDragRef.current = () => {
        dragRef.current = null;
        detach();
      };
    };

    const onHover = (event: PointerEvent) => {
      const xy = canvasXY(event);
      if (!xy) return;
      const hit = hitRows(rowsRef.current, xy.x, xy.y);
      const next = hit ? { id: hit.row.id, pill: hit.pill } : null;
      if (next?.id !== hoverRef.current?.id || next?.pill !== hoverRef.current?.pill) {
        hoverRef.current = next;
        scheduleRef.current();
      }
      if (!hit) containerEl.style.cursor = '';
      else containerEl.style.cursor = hit.pill ? 'pointer' : 'ns-resize';
    };

    const onLeave = () => {
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
      endDragRef.current();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, store]);

  /**
   * Closes the window. Stable across renders because the popover's dismissal
   * listener depends on it, and a chart that re-renders every tick would
   * otherwise re-arm that listener behind a `setTimeout(0)` each time — leaving
   * a sliver of every tick where an outside click did not dismiss.
   */
  const closeWindow = useCallback(() => {
    // Hand focus back to the handle only when the window still holds it: an
    // outside click has already put focus where the user aimed it.
    const held = document.activeElement?.closest('.order-placement') != null;
    setPlacementPrice(null);
    if (held) plusRef.current?.focus();
  }, []);

  /** Arms the window at whatever level the guide is currently on. */
  const openPlacementWindow = () => {
    if (latest.current.placementPrice !== null || guidePriceRef.current === null) return;
    setPlacementPrice(round2(guidePriceRef.current));
  };

  /**
   * Summons the guide without a pointer, at the middle of the visible range.
   *
   * The pointer route picks the level by where you clicked; a keyboard user has
   * no click on empty chart space, so they get a level in view and the arrow
   * keys below to move it. Mirrors what activating the dormant handle does for
   * VoiceOver on iOS.
   */
  const summonGuide = () => {
    if (latest.current.placementPrice !== null) return;
    const price = series.coordinateToPrice(chart.paneSize().height / 2);
    if (price === null) return;
    guidePriceRef.current = round2(price);
    scheduleRef.current();
  };

  /**
   * Keyboard adjustment of the guide's level, and the keyboard's dismissal.
   * Dragging the handle is the only pointer route to a different level and a
   * keyboard user has no drag, so without this they could only ever arm an
   * order at the level it was summoned to. Mirrors VoiceOver's
   * increment/decrement on iOS, at the same one-tick step.
   */
  const onPlusKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (latest.current.placementPrice !== null) return; // the window owns the level
    if (event.key === 'Escape' && guidePriceRef.current !== null) {
      // The keyboard's second click: what dismisses a guide it summoned.
      event.preventDefault();
      guidePriceRef.current = null;
      scheduleRef.current();
      return;
    }
    const up = event.key === 'ArrowUp' || event.key === 'PageUp';
    const down = event.key === 'ArrowDown' || event.key === 'PageDown';
    if ((!up && !down) || guidePriceRef.current === null) return;
    const step = event.key.startsWith('Page') ? GUIDE_ADJUST_PAGE : GUIDE_ADJUST_STEP;
    // Otherwise the arrows scroll the page out from under the chart.
    event.preventDefault();
    guidePriceRef.current = round2(guidePriceRef.current + (up ? step : -step));
    scheduleRef.current();
  };

  /**
   * Press on the handle: a drag moves the guide, a click with no travel opens
   * the window. Same gesture the order lines use, so the two feel identical.
   */
  const onPlusPointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return; // a context-menu press must not arm an order
    if (latest.current.placementPrice !== null) return; // window owns the level
    if (guidePriceRef.current === null) return; // dormant: nothing to drag yet
    if (guidePressRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    guideDragRef.current = false;
    // Capture so a release outside the browser window still ends the gesture,
    // rather than leaving the guide following an unheld cursor. Claim the press
    // only once this has succeeded: a throw before the listeners are attached
    // would otherwise leave the flag set with nothing able to clear it, and the
    // guard above would refuse every press for the life of the component.
    event.currentTarget.setPointerCapture(event.pointerId);
    guidePressRef.current = true;

    const onMove = (moveEvent: PointerEvent) => {
      if (!guideDragRef.current && Math.abs(moveEvent.clientY - startY) < GUIDE_DRAG_THRESHOLD) {
        return;
      }
      guideDragRef.current = true;
      const xy = canvasXY(moveEvent);
      if (!xy) return;
      // Pin to the pane's edges instead of extrapolating past them: an
      // out-of-range level is one resolveGuidePrice dismisses on the next
      // frame, so dragging a little too far would delete the guide out from
      // under the pointer holding it.
      //
      // And short of the reset button, which now shares the handle's column.
      // `A` is a DOM button stacked above this canvas, so it takes the click
      // from anything it covers — a handle dragged under it could not be
      // picked up again. It costs the bottom ~40px of the visible range, which
      // is still reachable by dragging the price axis.
      const paneHeight = chart.paneSize().height;
      const floor = Math.min(paneHeight, guideDragFloor(paneHeight));
      const price = series.coordinateToPrice(Math.min(floor, Math.max(0, xy.y)));
      if (price === null) return;
      guidePriceRef.current = price;
      scheduleRef.current();
    };

    // No releasePointerCapture: capture is released implicitly once
    // `pointerup`/`pointercancel` has been dispatched, and on removal of the
    // capturing element.
    const detach = () => {
      endGuideDragRef.current = () => {};
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancelled);
    };

    /** Ends the gesture. Only a release opens the window; a cancelled gesture
     *  is one the user did not finish making. */
    const end = (opens: boolean) => {
      const dragged = guideDragRef.current;
      guideDragRef.current = false;
      guidePressRef.current = false;
      detach();
      scheduleRef.current();
      if (opens && !dragged) openPlacementWindow();
    };

    const onUp = () => end(true);
    const onCancelled = () => end(false);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancelled);
    // Unmounting mid-drag abandons the gesture: the series these coordinates
    // mean is going away.
    endGuideDragRef.current = () => {
      guideDragRef.current = false;
      guidePressRef.current = false;
      detach();
    };
  };

  // Tears the guide drag down if the component unmounts while the pointer is
  // still held — the listeners are on `window`, so they would outlive it.
  useEffect(() => () => endGuideDragRef.current(), []);

  /** Commits a bracket leg dragged off an entry line into the position's OCO group. */
  const placeBracket = async (entry: EntryLine, price: number) => {
    // Defensive twin of the drag-start gate: nothing may classify a bracket
    // against an estimated entry, even if a future code path re-enters here.
    if (!entry.authoritative) return;
    const kind = bracketKindFor(
      entry.contract.optionType,
      entry.position.quantity,
      entry.price,
      price,
    );
    // A leg of the same kind already exists (e.g. a second drag above entry on
    // a long call, both classified 'target'): move it to the new level rather
    // than creating a second one. The OCO group cancels siblings by
    // membership, not by kind, so two targets sharing a group would silently
    // retire one of them on fire — the user would lose whichever the market
    // did not reach first with no warning.
    const siblings = workingBracketSiblings(store.getState().orders, entry.position.symbol);
    const sameKind = siblings.find((order) => order.kind === kind);
    if (sameKind) {
      await store.move(sameKind.id, round2(price));
      return;
    }
    await store.create(
      bracketLegDraft({
        contract: entry.contract,
        position: entry.position,
        triggerPrice: round2(price),
        kind,
        orderType: latest.current.defaultOrderType,
        orders: store.getState().orders,
      }),
    );
  };

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
      <button
        ref={plusRef}
        type="button"
        data-chart-placement=""
        className="order-guide-plus hud-clip"
        onPointerDown={onPlusPointerDown}
        onKeyDown={onPlusKeyDown}
        aria-keyshortcuts="ArrowUp ArrowDown"
        // Enter and Space synthesise a click with no click count, which is what
        // separates them from the mouse release the press handler already
        // served — without this the handle is unreachable from the keyboard.
        // Dormant, it summons the guide; showing, it opens the window. The same
        // two steps a pointer gets from a click on the chart and a click on `+`.
        onClick={(event) => {
          if (event.detail !== 0) return;
          if (guidePriceRef.current === null) summonGuide();
          else openPlacementWindow();
        }}
        // Position and the aria-label are written by the draw loop, which is the
        // only place that knows the level; setting them here too would fight it.
        style={{ display: 'none', width: PLUS_SIZE, height: PLUS_SIZE }}
      >
        +
      </button>
      {placementPrice !== null && selectedContract ? (
        <OrderPlacementPopover
          price={placementPrice}
          onPriceChange={(next) => {
            setPlacementPrice(next);
            guidePriceRef.current = next;
            scheduleRef.current();
          }}
          rightInset={rightInset}
          contract={selectedContract}
          defaultQuantity={settings.defaultQuantity}
          defaultOrderType={defaultOrderType}
          onCancel={closeWindow}
          onPlace={async (input) => {
            const created = await store.create({
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
            // `create` reports failure by returning null (it surfaces the error
            // on the store). Closing regardless would tell the user their order
            // is armed when nothing was placed, so a failure keeps the window
            // up with their inputs intact to retry.
            if (created) closeWindow();
          }}
        />
      ) : null}
    </>
  );
}

/** Line colour: failed and stop read as danger, target as profit, limit as accent. */
function orderLineColor(
  order: ChartOrder,
  colors: { pnlPositive: string; pnlNegative: string; orderLimit: string },
): string {
  if (order.status === 'failed' || order.kind === 'stop') return colors.pnlNegative;
  if (order.kind === 'target') return colors.pnlPositive;
  return colors.orderLimit;
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
