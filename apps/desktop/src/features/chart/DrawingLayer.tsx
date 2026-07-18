import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi, Logical } from 'lightweight-charts';
import { useStore } from '../../core/observable';
import { Format } from '../../design/format';
import type { Drawing, DrawingPoint, DrawingsStore } from './drawings';

const ACCENT = '#568ff7';
const ALERT_COLOR = '#ff9f0a';
const HANDLE_RADIUS = 5;
const HIT_DISTANCE = 7;

interface DrawingLayerProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  store: DrawingsStore;
  /** First candle's bucket time (epoch s) — anchor for time→logical mapping. */
  firstTime: number;
  intervalSec: number;
}

interface DragState {
  id: string;
  mode: 'whole' | 'p1' | 'p2' | 'alert';
  startPointer: DrawingPoint;
  origP1: DrawingPoint;
  origP2: DrawingPoint | null;
}

/**
 * TradingView-style annotation overlay: renders and edits trend lines, rays,
 * horizontal lines, boxes, and alert lines on a canvas above the chart pane.
 * Anchors are (time, price); times map to x via the uniform bucket spacing so
 * shapes stay put across pan/zoom, live appends, and reloads.
 */
export function DrawingLayer({ chart, series, store, firstTime, intervalSec }: DrawingLayerProps) {
  const { tool } = useStore(store);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const draftingRef = useRef(false);
  const geometryRef = useRef({ firstTime, intervalSec });
  geometryRef.current = { firstTime, intervalSec };

  // MARK: - Coordinate mapping

  const toXY = (point: DrawingPoint): { x: number | null; y: number | null } => {
    const { firstTime: t0, intervalSec: step } = geometryRef.current;
    const logical = (point.time - t0) / step;
    const x = chart.timeScale().logicalToCoordinate(logical as Logical);
    const y = series.priceToCoordinate(point.price);
    return { x: x ?? null, y: y ?? null };
  };

  const toPoint = (x: number, y: number): DrawingPoint | null => {
    const { firstTime: t0, intervalSec: step } = geometryRef.current;
    const logical = chart.timeScale().coordinateToLogical(x);
    const price = series.coordinateToPrice(y);
    if (logical === null || price === null) return null;
    return { time: t0 + logical * step, price };
  };

  /** Pointer event → logical canvas coordinates (compensates the app scale). */
  const canvasXY = (event: PointerEvent | React.PointerEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((event.clientX - rect.left) * canvas.clientWidth) / rect.width,
      y: ((event.clientY - rect.top) * canvas.clientHeight) / rect.height,
    };
  };

  // MARK: - Render loop

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
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

      const state = store.getState();
      for (const drawing of state.drawings) {
        renderDrawing(ctx, drawing, drawing.id === state.selectedId, pane.width);
      }
      if (state.draft) renderDrawing(ctx, state.draft, false, pane.width);
      for (const alert of state.alerts) {
        renderAlert(ctx, alert.price, alert.id === state.selectedId, pane.width);
      }
    };

    const renderDrawing = (
      ctx: CanvasRenderingContext2D,
      drawing: Drawing,
      selected: boolean,
      width: number,
    ) => {
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = selected ? 2 : 1.25;
      const a = toXY(drawing.p1);
      if (drawing.kind === 'hline') {
        if (a.y === null) return;
        ctx.beginPath();
        ctx.moveTo(0, a.y);
        ctx.lineTo(width, a.y);
        ctx.stroke();
        priceTag(ctx, drawing.p1.price, a.y, ACCENT);
        if (selected && a.x !== null) handle(ctx, a.x, a.y);
        return;
      }
      if (!drawing.p2) return;
      const b = toXY(drawing.p2);
      if (a.x === null || a.y === null || b.x === null || b.y === null) return;

      if (drawing.kind === 'rect') {
        ctx.fillStyle = 'rgba(86, 143, 247, 0.12)';
        ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      } else {
        let endX = b.x;
        let endY = b.y;
        if (drawing.kind === 'ray' && (a.x !== b.x || a.y !== b.y)) {
          // Extend past p2 to the canvas edge.
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const scale = dx !== 0 ? Math.abs((dx > 0 ? width + 50 - a.x : a.x + 50) / dx) : 10_000;
          endX = a.x + dx * scale;
          endY = a.y + dy * scale;
        }
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      }
      if (selected) {
        handle(ctx, a.x, a.y);
        handle(ctx, b.x, b.y);
      }
    };

    const renderAlert = (
      ctx: CanvasRenderingContext2D,
      price: number,
      selected: boolean,
      width: number,
    ) => {
      const y = series.priceToCoordinate(price);
      if (y === null) return;
      ctx.strokeStyle = ALERT_COLOR;
      ctx.lineWidth = selected ? 2 : 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.setLineDash([]);
      priceTag(ctx, price, y, ALERT_COLOR, '⏰ ');
    };

    const priceTag = (
      ctx: CanvasRenderingContext2D,
      price: number,
      y: number,
      color: string,
      prefix = '',
    ) => {
      const label = `${prefix}${Format.price(price)}`;
      ctx.font = '10px ui-monospace, monospace';
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = color;
      ctx.fillRect(4, y - 8, w, 16);
      ctx.fillStyle = '#0b0c10';
      ctx.fillText(label, 8, y + 3.5);
    };

    const handle = (ctx: CanvasRenderingContext2D, x: number, y: number) => {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, store]);

  // MARK: - Hit testing (cursor mode)

  const hitTest = (
    x: number,
    y: number,
  ): { id: string; mode: DragState['mode'] } | null => {
    const state = store.getState();
    // Alerts first (thin lines on top).
    for (const alert of [...state.alerts].reverse()) {
      const ay = series.priceToCoordinate(alert.price);
      if (ay !== null && Math.abs(y - ay) <= HIT_DISTANCE) return { id: alert.id, mode: 'alert' };
    }
    for (const drawing of [...state.drawings].reverse()) {
      const a = toXY(drawing.p1);
      const b = drawing.p2 ? toXY(drawing.p2) : null;
      if (a.x !== null && a.y !== null && distance(x, y, a.x, a.y) <= HANDLE_RADIUS + 3) {
        return { id: drawing.id, mode: 'p1' };
      }
      if (b && b.x !== null && b.y !== null && distance(x, y, b.x, b.y) <= HANDLE_RADIUS + 3) {
        return { id: drawing.id, mode: 'p2' };
      }
      if (drawing.kind === 'hline') {
        if (a.y !== null && Math.abs(y - a.y) <= HIT_DISTANCE) return { id: drawing.id, mode: 'whole' };
        continue;
      }
      if (!b || a.x === null || a.y === null || b.x === null || b.y === null) continue;
      if (drawing.kind === 'rect') {
        const inX = x >= Math.min(a.x, b.x) - 2 && x <= Math.max(a.x, b.x) + 2;
        const inY = y >= Math.min(a.y, b.y) - 2 && y <= Math.max(a.y, b.y) + 2;
        if (inX && inY) return { id: drawing.id, mode: 'whole' };
        continue;
      }
      let endX = b.x;
      let endY = b.y;
      if (drawing.kind === 'ray' && (a.x !== b.x || a.y !== b.y)) {
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        endX = a.x + dx * 100;
        endY = a.y + dy * 100;
      }
      if (segmentDistance(x, y, a.x, a.y, endX, endY) <= HIT_DISTANCE) {
        return { id: drawing.id, mode: 'whole' };
      }
    }
    return null;
  };

  // Cursor-mode selection/drag: intercept pointerdown on the chart container
  // in the capture phase so hits edit the shape instead of panning the chart.
  useEffect(() => {
    const canvas = canvasRef.current;
    const containerEl = canvas?.parentElement;
    if (!canvas || !containerEl) return;

    const onPointerDown = (event: PointerEvent) => {
      if (store.getState().tool !== 'cursor') return;
      const xy = canvasXY(event);
      if (!xy) return;
      const hit = hitTest(xy.x, xy.y);
      if (!hit) {
        store.select(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      store.select(hit.id);
      const pointer = toPoint(xy.x, xy.y);
      if (!pointer) return;
      const state = store.getState();
      const drawing = state.drawings.find((d) => d.id === hit.id);
      const alert = state.alerts.find((a) => a.id === hit.id);
      dragRef.current = {
        id: hit.id,
        mode: hit.mode,
        startPointer: pointer,
        origP1: drawing?.p1 ?? { time: pointer.time, price: alert?.price ?? pointer.price },
        origP2: drawing?.p2 ?? null,
      };

      const onMove = (moveEvent: PointerEvent) => {
        const drag = dragRef.current;
        const moveXY = canvasXY(moveEvent);
        if (!drag || !moveXY) return;
        const current = toPoint(moveXY.x, moveXY.y);
        if (!current) return;
        const dTime = current.time - drag.startPointer.time;
        const dPrice = current.price - drag.startPointer.price;
        if (drag.mode === 'alert') {
          store.updateAlertPrice(drag.id, drag.origP1.price + dPrice);
        } else if (drag.mode === 'p1') {
          store.updateDrawing(drag.id, current, drag.origP2);
        } else if (drag.mode === 'p2') {
          store.updateDrawing(drag.id, drag.origP1, current);
        } else {
          store.updateDrawing(
            drag.id,
            { time: drag.origP1.time + dTime, price: drag.origP1.price + dPrice },
            drag.origP2
              ? { time: drag.origP2.time + dTime, price: drag.origP2.price + dPrice }
              : null,
          );
        }
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    containerEl.addEventListener('pointerdown', onPointerDown, true);
    return () => containerEl.removeEventListener('pointerdown', onPointerDown, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, series, store]);

  // Delete/Backspace removes the selection; Escape cancels draft/selection.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        store.removeSelected();
      } else if (event.key === 'Escape') {
        store.cancelDraft();
        store.select(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);

  // MARK: - Draw-tool pointer handlers (on the canvas itself)

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const activeTool = store.getState().tool;
    if (activeTool === 'cursor') return;
    const xy = canvasXY(event);
    if (!xy) return;
    const point = toPoint(xy.x, xy.y);
    if (!point) return;
    if (activeTool === 'alert') {
      store.addAlert(point.price);
      return;
    }
    if (activeTool === 'hline') {
      store.addHLine(point.price, point.time);
      return;
    }
    draftingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    store.beginDraft(activeTool, point);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!draftingRef.current) return;
    const xy = canvasXY(event);
    const point = xy && toPoint(xy.x, xy.y);
    if (point) store.updateDraft(point);
  };

  const onPointerUp = () => {
    if (!draftingRef.current) return;
    draftingRef.current = false;
    store.commitDraft();
  };

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        zIndex: 3,
        pointerEvents: tool === 'cursor' ? 'none' : 'auto',
        cursor: tool === 'cursor' ? 'default' : 'crosshair',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x2 - x1, y2 - y1);
}

function segmentDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const lengthSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (lengthSq === 0) return distance(px, py, x1, y1);
  let t = ((px - x1) * (x2 - x1) + (py - y1) * (y2 - y1)) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return distance(px, py, x1 + t * (x2 - x1), y1 + t * (y2 - y1));
}
