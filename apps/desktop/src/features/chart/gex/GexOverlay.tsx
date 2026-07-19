import { useEffect, useRef } from 'react';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { ChartCandle } from '../ChartStore';
import type { GexSettings } from './gexSettings';
import type { GexLevels } from './gexTypes';

interface GexOverlayProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  levels: GexLevels | null;
  settings: GexSettings;
  /** Candle version: live ticks shift price→y geometry, so repaint. */
  candles: ChartCandle[];
  stale: boolean;
}

const COLORS = {
  gammaFlip: '#ffd60a',
  callWall: '#30d158',
  putWall: '#ff453a',
  magnet: '#64d2ff',
  premium: '255, 159, 10', // orange rgb, alpha scaled per band
  zonePositive: '48, 209, 88',
  zoneNegative: '255, 69, 58',
};

function formatDollars(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '+';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * Read-only canvas overlay for the GEX/DEX level structure: premium heat
 * bands, regime zone shading between the walls, and labeled level lines.
 * Same event-driven repaint pattern as TwcOverlay; no pointer interaction.
 */
export function GexOverlay({ chart, series, levels, settings, candles, stale }: GexOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scheduleRef = useRef<() => void>(() => {});
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const staleRef = useRef(stale);
  staleRef.current = stale;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;

    const yAt = (price: number): number | null => series.priceToCoordinate(price);

    const drawLine = (
      ctx: CanvasRenderingContext2D,
      width: number,
      price: number,
      color: string,
      label: string,
      dashed = false,
    ): void => {
      const y = yAt(price);
      if (y === null) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash(dashed ? [6, 4] : []);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = '10px -apple-system, "SF Pro Text", system-ui, sans-serif';
      const textWidth = ctx.measureText(label).width;
      const x = width - textWidth - 12;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x - 6, y - 8, textWidth + 12, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#000000';
      ctx.fillText(label, x, y + 3.5);
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

      const data = levelsRef.current;
      const cfg = settingsRef.current;
      if (!data || pane.width === 0) return;

      // ── Premium heat bands (below the level lines, drawn first) ──
      if (cfg.showPremium && data.topPremium.length > 0) {
        const shown = data.topPremium.slice(0, cfg.maxPremiumStrikes);
        const maxPremium = shown[0].totalPremium;
        // Band half-height: quarter of the smallest strike gap.
        const gaps = data.topPremium
          .map((level) => level.strike)
          .sort((a, b) => a - b);
        let minGap = 1;
        for (let i = 1; i < gaps.length; i++) {
          const gap = gaps[i] - gaps[i - 1];
          if (gap > 0 && gap < minGap) minGap = gap;
        }
        const half = minGap / 4;
        shown.forEach((level, index) => {
          const yTop = yAt(level.strike + half);
          const yBottom = yAt(level.strike - half);
          if (yTop === null || yBottom === null) return;
          const intensity = level.totalPremium / maxPremium;
          const alpha = Math.min(0.15 + intensity * cfg.opacityCap, cfg.opacityCap);
          ctx.fillStyle = `rgba(${COLORS.premium}, ${alpha.toFixed(3)})`;
          ctx.fillRect(0, yTop, pane.width, yBottom - yTop);
          // Only the top 3 get text; the rest stay quiet bands.
          if (index < 3) {
            ctx.font = '9px -apple-system, "SF Pro Text", system-ui, sans-serif';
            ctx.fillStyle = `rgba(${COLORS.premium}, 0.95)`;
            ctx.fillText(
              `$${level.strike} — ${formatDollars(level.totalPremium).replace('+', '')} premium`,
              6,
              yTop + 10,
            );
          }
        });
      }

      if (cfg.showLevels) {
        // ── Regime zone between put wall and call wall ──
        if (data.putWall !== null && data.callWall !== null) {
          const low = Math.min(data.putWall, data.callWall);
          const high = Math.max(data.putWall, data.callWall);
          const yTop = yAt(high);
          const yBottom = yAt(low);
          if (yTop !== null && yBottom !== null) {
            const rgb = data.netGex >= 0 ? COLORS.zonePositive : COLORS.zoneNegative;
            ctx.fillStyle = `rgba(${rgb}, 0.07)`;
            ctx.fillRect(0, yTop, pane.width, yBottom - yTop);
          }
        }

        // ── Level lines ──
        if (data.putWall !== null) {
          drawLine(ctx, pane.width, data.putWall, COLORS.putWall, `Put Wall $${data.putWall}`);
        }
        if (data.callWall !== null) {
          drawLine(ctx, pane.width, data.callWall, COLORS.callWall, `Call Wall $${data.callWall}`);
        }
        if (data.gammaFlip !== null) {
          drawLine(ctx, pane.width, data.gammaFlip, COLORS.gammaFlip, `Gamma Flip $${data.gammaFlip.toFixed(1)}`, true);
        }
        if (data.magnet !== null) {
          drawLine(ctx, pane.width, data.magnet, COLORS.magnet, `0DTE Magnet $${data.magnet}`, true);
        }
      }

      // ── Regime readout, top-right ──
      ctx.font = '10px ui-monospace, "SF Mono", Menlo, monospace';
      const regime = data.netGex >= 0 ? 'positive' : 'negative';
      const gexText = `GEX: ${formatDollars(data.netGex)} (${regime})${staleRef.current ? ' · STALE' : ''}`;
      const dexText = `DEX: ${formatDollars(data.netDex)}`;
      const gexWidth = ctx.measureText(gexText).width;
      const dexWidth = ctx.measureText(dexText).width;
      const boxWidth = Math.max(gexWidth, dexWidth) + 16;
      ctx.fillStyle = 'rgba(28, 28, 30, 0.82)';
      ctx.fillRect(pane.width - boxWidth - 6, 6, boxWidth, 34);
      ctx.fillStyle = staleRef.current
        ? '#ff9f0a'
        : data.netGex >= 0
          ? COLORS.callWall
          : COLORS.putWall;
      ctx.fillText(gexText, pane.width - boxWidth + 2, 19);
      ctx.fillStyle = 'rgba(235, 235, 245, 0.6)';
      ctx.fillText(dexText, pane.width - boxWidth + 2, 33);
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        draw();
      });
    };
    scheduleRef.current = schedule;

    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(canvas.parentElement as Element);
    schedule();

    return () => {
      scheduleRef.current = () => {};
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      resizeObserver.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [chart, series]);

  // Level/settings/candle changes shift geometry or content; repaint.
  useEffect(() => {
    scheduleRef.current();
  }, [levels, settings, candles, stale]);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 2, pointerEvents: 'none' }}
      aria-hidden="true"
    />
  );
}
