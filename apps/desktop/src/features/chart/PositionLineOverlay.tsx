import { useEffect, useRef, useState } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { Position } from '@0dtetrader/shared-types';
import { Format } from '../../design/format';

interface PositionLineOverlayProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  /** Positions whose contract's underlying matches the chart's symbol —
   *  filtering by underlying is the caller's job (needs the loaded chain). */
  positions: Position[];
  onFlatten: (position: Position) => void;
  locked?: boolean;
}

/** `+$125.00` / `-$87.50`; zero renders unsigned. */
function signedCurrency(value: number): string {
  if (value === 0) return `$${Format.price(0)}`;
  return value < 0 ? `-$${Format.price(Math.abs(value))}` : `+$${Format.price(value)}`;
}

/**
 * On-chart position marker (TradingView convention): a horizontal line at
 * the entry price with an inline label (entry, live P&L) and a close
 * button anchored at the line's end — risk is visible right where the
 * price lives, and closing it is a single click without leaving the chart.
 * DOM overlay, not a lightweight-charts price line, because price lines
 * aren't natively clickable; positioned the same way TwcOverlay tracks
 * chart geometry (priceToCoordinate + pane resize/pan subscriptions).
 */
export function PositionLineOverlay({
  chart,
  series,
  positions,
  onFlatten,
  locked = false,
}: PositionLineOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tops, setTops] = useState<Map<string, number>>(new Map());
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let raf = 0;

    const reposition = () => {
      const pane = chart.paneSize();
      const axisWidth = chart.priceScale('left').width();
      container.style.left = `${axisWidth}px`;
      container.style.width = `${pane.width}px`;
      container.style.height = `${pane.height}px`;
      const next = new Map<string, number>();
      for (const position of positionsRef.current) {
        const y = series.priceToCoordinate(position.avgPrice);
        if (y !== null && y >= 0 && y <= pane.height) next.set(position.symbol, y);
      }
      setTops(next);
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        reposition();
      });
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(container.parentElement as Element);
    schedule();

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      resizeObserver.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [chart, series]);

  // Position/price changes shift geometry or P&L text; reposition+rerender.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const pane = chart.paneSize();
    const next = new Map<string, number>();
    for (const position of positions) {
      const y = series.priceToCoordinate(position.avgPrice);
      if (y !== null && y >= 0 && y <= pane.height) next.set(position.symbol, y);
    }
    setTops(next);
  }, [chart, series, positions]);

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 3, pointerEvents: 'none' }}
      aria-hidden="true"
    >
      {positions.map((position) => {
        const top = tops.get(position.symbol);
        if (top === undefined) return null;
        const positive = position.unrealizedPnl >= 0;
        const color = positive ? 'var(--pnl-positive)' : 'var(--pnl-negative)';
        return (
          <div
            key={position.symbol}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top,
              transform: 'translateY(-50%)',
              display: 'flex',
              alignItems: 'center',
              pointerEvents: 'none',
            }}
          >
            <div style={{ flex: 1, height: 1, background: color, opacity: 0.6 }} />
            <div
              className="position-line-label numeric"
              style={{ borderColor: color, color, pointerEvents: 'auto' }}
            >
              <span>@{Format.price(position.avgPrice)}</span>
              <span style={{ fontWeight: 700 }}>{signedCurrency(position.unrealizedPnl)}</span>
              <button
                className="position-line-close"
                onClick={() => onFlatten(position)}
                disabled={locked}
                aria-label={`Flatten position ${position.symbol}`}
                title="Flatten position"
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
