import { useEffect, useId, useMemo, useRef } from 'react';
import type { OptionsAnalyticsSnapshot } from '@0dtetrader/shared-types';
import type { IChartApi, ISeriesApi } from 'lightweight-charts';
import type { ChartCandle } from '../ChartStore';
import {
  buildOptionsAnalyticsPresentation,
  formatCompactDollars,
  selectOptionsAnalyticsProfileStrikes,
  type OptionsAnalyticsStrikePresentation,
} from './optionsAnalyticsPresentation';
import type { OptionsAnalyticsSettings } from './optionsAnalyticsSettings';
import { optionsAnalyticsRailWidth } from './optionsAnalyticsGeometry';
import { optionsAnalyticsHoverLines } from './optionsAnalyticsHover';

interface OptionsAnalyticsOverlayProps {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  snapshot: OptionsAnalyticsSnapshot;
  settings: OptionsAnalyticsSettings;
  candles: ChartCandle[];
  retained: boolean;
  nowMs?: number;
}

interface HoverBar {
  left: number;
  right: number;
  top: number;
  bottom: number;
  strike: OptionsAnalyticsStrikePresentation;
}

const COLORS = {
  call: '#22e06a',
  put: '#ff3b4e',
  range: '100, 210, 255',
  straddle: '#64d2ff',
  wall: '#ffc53d',
  markedOiCall: '#ff9f0a',
  markedOiPut: '#ffd60a',
  proxy: '#bf5af2',
};

function optionalPercent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/** Point-in-time structure rail. All price shading is limited to the right edge. */
export function OptionsAnalyticsOverlay({
  chart,
  series,
  snapshot,
  settings,
  candles,
  retained,
  nowMs,
}: OptionsAnalyticsOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scheduleRef = useRef<() => void>(() => undefined);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);
  const model = useMemo(
    () => buildOptionsAnalyticsPresentation(snapshot, settings, nowMs ?? Date.now()),
    [snapshot, settings, nowMs],
  );
  const modelRef = useRef(model);
  modelRef.current = model;
  const summaryId = `options-analytics-summary-${useId().replaceAll(':', '')}`;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let frame = 0;

    const yAt = (price: number): number | null => series.priceToCoordinate(price);

    const drawPriceLine = (
      context: CanvasRenderingContext2D,
      railStart: number,
      width: number,
      price: number,
      color: string,
      label: string,
      dash: number[] = [],
    ): void => {
      const y = yAt(price);
      if (y === null) return;
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.setLineDash(dash);
      context.beginPath();
      context.moveTo(railStart, y);
      context.lineTo(width, y);
      context.stroke();
      context.setLineDash([]);
      context.font = '9px "JetBrains Mono", ui-monospace, monospace';
      context.fillStyle = color;
      context.fillText(label, railStart + 3, y - 3);
    };

    const draw = (): void => {
      const pane = chart.paneSize();
      const axisWidth = chart.priceScale('left').width();
      const pixelRatio = window.devicePixelRatio || 1;
      canvas.style.left = `${axisWidth}px`;
      canvas.style.width = `${pane.width}px`;
      canvas.style.height = `${pane.height}px`;
      if (canvas.width !== pane.width * pixelRatio || canvas.height !== pane.height * pixelRatio) {
        canvas.width = pane.width * pixelRatio;
        canvas.height = pane.height * pixelRatio;
      }
      const context = canvas.getContext('2d');
      if (!context) return;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, pane.width, pane.height);
      if (pane.width === 0 || pane.height === 0) return;

      const presentation = modelRef.current;
      const railWidth = optionsAnalyticsRailWidth(pane.width);
      const railStart = Math.max(0, pane.width - railWidth);
      const center = railStart + railWidth * 0.5;
      const halfWidth = railWidth * 0.43;
      const hoverBars: HoverBar[] = [];
      const isStrikeVisible = (strike: OptionsAnalyticsStrikePresentation): boolean => {
        const coordinate = yAt(strike.strike);
        return coordinate !== null && coordinate >= 0 && coordinate <= pane.height;
      };
      const profileStrikes = selectOptionsAnalyticsProfileStrikes(
        presentation.allStrikes,
        presentation.profileStrikeCount,
        isStrikeVisible,
      );

      if (presentation.impliedRange) {
        const upper = yAt(presentation.impliedRange.upper);
        const lower = yAt(presentation.impliedRange.lower);
        if (upper !== null && lower !== null) {
          context.fillStyle = `rgba(${COLORS.range}, 0.09)`;
          context.fillRect(railStart, upper, pane.width - railStart, lower - upper);
        }
        drawPriceLine(
          context,
          railStart,
          pane.width,
          presentation.impliedRange.straddleLower,
          COLORS.straddle,
          'Straddle BE',
          [3, 3],
        );
        drawPriceLine(
          context,
          railStart,
          pane.width,
          presentation.impliedRange.straddleUpper,
          COLORS.straddle,
          'Straddle BE',
          [3, 3],
        );
      }

      if (presentation.putWall !== null) {
        drawPriceLine(
          context,
          railStart,
          pane.width,
          presentation.putWall,
          COLORS.put,
          `Put wall ${presentation.putWall.toFixed(2)}`,
        );
      }
      if (presentation.callWall !== null) {
        drawPriceLine(
          context,
          railStart,
          pane.width,
          presentation.callWall,
          COLORS.call,
          `Call wall ${presentation.callWall.toFixed(2)}`,
        );
      }
      if (presentation.maxOpenInterestStrike !== null) {
        drawPriceLine(
          context,
          railStart,
          pane.width,
          presentation.maxOpenInterestStrike,
          COLORS.markedOiPut,
          `Max OI node ${presentation.maxOpenInterestStrike.toFixed(2)}`,
          [2, 2],
        );
      }

      const hasStrikeLayer =
        presentation.showGammaProfile || presentation.showMarkedOi || presentation.showLiquidity;
      if (hasStrikeLayer) {
        context.strokeStyle = 'rgba(190, 215, 245, 0.35)';
        context.beginPath();
        context.moveTo(center, 0);
        context.lineTo(center, pane.height);
        context.stroke();
        context.font = 'bold 9px "JetBrains Mono", ui-monospace, monospace';
        context.fillStyle = COLORS.put;
        context.fillText('P', railStart + 3, 11);
        context.fillStyle = COLORS.call;
        context.fillText('C', pane.width - 10, 11);

        for (const strike of profileStrikes) {
          const y = yAt(strike.strike);
          if (y === null) continue;
          const callWidth = halfWidth * strike.callScale;
          const putWidth = halfWidth * strike.putScale;
          const barHeight = 5;
          const callLiquidityAlpha =
            strike.liquidity?.callRelativeSpread === null ||
            strike.liquidity?.callRelativeSpread === undefined
              ? 0.78
              : Math.max(0.35, 1 - strike.liquidity.callRelativeSpread);
          const putLiquidityAlpha =
            strike.liquidity?.putRelativeSpread === null ||
            strike.liquidity?.putRelativeSpread === undefined
              ? 0.78
              : Math.max(0.35, 1 - strike.liquidity.putRelativeSpread);

          if (presentation.showGammaProfile) {
            context.globalAlpha = putLiquidityAlpha;
            context.fillStyle = COLORS.put;
            context.fillRect(center - putWidth, y - barHeight, putWidth, barHeight * 2);
            context.globalAlpha = callLiquidityAlpha;
            context.fillStyle = COLORS.call;
            context.fillRect(center, y - barHeight, callWidth, barHeight * 2);
            context.globalAlpha = 1;
          }

          if (presentation.showMarkedOi) {
            const callOiWidth = halfWidth * strike.callMarkedOiScale;
            const putOiWidth = halfWidth * strike.putMarkedOiScale;
            const oiY = presentation.showGammaProfile ? y + 6 : y;
            context.fillStyle = COLORS.markedOiPut;
            context.fillRect(center - putOiWidth, oiY - 1.5, putOiWidth, 3);
            context.fillStyle = COLORS.markedOiCall;
            context.fillRect(center, oiY - 1.5, callOiWidth, 3);
          }

          if (presentation.showLiquidity && strike.liquidity) {
            context.font = '7px "JetBrains Mono", ui-monospace, monospace';
            context.fillStyle = 'rgba(255, 214, 10, 0.92)';
            const liquidityY =
              y + (presentation.showGammaProfile ? 11 : presentation.showMarkedOi ? 6 : 2);
            context.textAlign = 'left';
            context.fillText(
              `P ${optionalPercent(strike.liquidity.putRelativeSpread)}`,
              railStart + 2,
              liquidityY,
            );
            context.textAlign = 'right';
            context.fillText(
              `C ${optionalPercent(strike.liquidity.callRelativeSpread)}`,
              pane.width - 2,
              liquidityY,
            );
            context.textAlign = 'start';
          }
          hoverBars.push({
            left: railStart,
            right: pane.width,
            top: y - 8,
            bottom: y + 14,
            strike,
          });
        }
      }

      if (presentation.dealerProxy) {
        for (const root of presentation.dealerProxy.gammaRoots) {
          drawPriceLine(
            context,
            railStart,
            pane.width,
            root,
            COLORS.proxy,
            'Gamma flip proxy',
            [6, 3],
          );
        }
      }

      const mouse = mouseRef.current;
      const hit = mouse
        ? hoverBars.find(
            (bar) =>
              mouse.x >= bar.left &&
              mouse.x <= bar.right &&
              mouse.y >= bar.top &&
              mouse.y <= bar.bottom,
          )
        : undefined;
      if (mouse && hit) {
        const lines = optionsAnalyticsHoverLines(hit.strike);
        context.font = '9px "JetBrains Mono", ui-monospace, monospace';
        const tooltipWidth = Math.max(...lines.map((line) => context.measureText(line).width)) + 14;
        const tooltipHeight = lines.length * 13 + 8;
        const tooltipX = Math.max(
          4,
          Math.min(mouse.x - tooltipWidth - 8, pane.width - tooltipWidth - 4),
        );
        const tooltipY = Math.max(4, Math.min(mouse.y + 9, pane.height - tooltipHeight - 4));
        context.fillStyle = 'rgba(8, 16, 32, 0.94)';
        context.fillRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight);
        context.strokeStyle = COLORS.wall;
        context.strokeRect(tooltipX + 0.5, tooltipY + 0.5, tooltipWidth - 1, tooltipHeight - 1);
        lines.forEach((line, index) => {
          context.fillStyle = index === 0 ? COLORS.wall : 'rgba(220, 232, 248, 0.9)';
          context.fillText(line, tooltipX + 7, tooltipY + 13 + index * 13);
        });
      }
    };

    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        draw();
      });
    };
    scheduleRef.current = schedule;
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    const resizeObserver = new ResizeObserver(schedule);
    const overlayRoot = canvas.parentElement;
    const interactionSurface = overlayRoot?.parentElement;
    if (overlayRoot) resizeObserver.observe(overlayRoot);

    const onMouseMove = (event: Event): void => {
      const bounds = canvas.getBoundingClientRect();
      const mouseEvent = event as MouseEvent;
      const inside =
        mouseEvent.clientX >= bounds.left &&
        mouseEvent.clientX <= bounds.right &&
        mouseEvent.clientY >= bounds.top &&
        mouseEvent.clientY <= bounds.bottom;
      mouseRef.current = inside
        ? { x: mouseEvent.clientX - bounds.left, y: mouseEvent.clientY - bounds.top }
        : null;
      schedule();
    };
    const onMouseLeave = (): void => {
      mouseRef.current = null;
      schedule();
    };
    interactionSurface?.addEventListener('mousemove', onMouseMove);
    interactionSurface?.addEventListener('mouseleave', onMouseLeave);
    schedule();

    return () => {
      scheduleRef.current = () => undefined;
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(schedule);
      resizeObserver.disconnect();
      interactionSurface?.removeEventListener('mousemove', onMouseMove);
      interactionSurface?.removeEventListener('mouseleave', onMouseLeave);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [chart, series]);

  useEffect(() => {
    scheduleRef.current();
  }, [model, candles, retained]);

  return (
    <div
      role="group"
      aria-label="Options structure snapshot"
      aria-describedby={summaryId}
      tabIndex={0}
      style={{ position: 'absolute', inset: 0, zIndex: 2, pointerEvents: 'none' }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
      />
      <div
        style={{
          position: 'absolute',
          top: 6,
          right: 6,
          maxWidth: '72%',
          padding: '4px 6px',
          border: '1px solid color-mix(in srgb, var(--hud-stroke) 70%, transparent)',
          background: 'rgba(8, 16, 32, 0.84)',
          color: 'var(--label-secondary)',
          fontFamily: 'var(--font-mono)',
          fontSize: 8,
          lineHeight: 1.25,
        }}
      >
        <div style={{ color: 'var(--label-primary)', fontWeight: 600 }}>
          Options structure{retained ? ' · retained last snapshot' : ''}
        </div>
        {model.visibleQualityLines.map((line) => (
          <div key={line}>{line}</div>
        ))}
        <div>{model.structureLine}</div>
        {model.dealerProxy ? (
          <>
            <div>Assumption: {model.dealerProxy.assumption}</div>
            <div>
              Proxy gamma {formatCompactDollars(model.dealerProxy.gammaExposure)} · delta{' '}
              {formatCompactDollars(model.dealerProxy.deltaNotional)}
            </div>
          </>
        ) : null}
      </div>
      {model.showGammaProfile || model.showMarkedOi || model.showLiquidity ? (
        <div
          style={{
            position: 'absolute',
            right: 4,
            bottom: 4,
            width: 'clamp(56px, 28%, 112px)',
            padding: '2px 4px',
            background: 'rgba(8, 16, 32, 0.84)',
            color: 'var(--label-secondary)',
            fontFamily: 'var(--font-mono)',
            fontSize: 7,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
            <span aria-label="Put profile" style={{ color: COLORS.put }}>
              P
            </span>
            <span aria-label="Call profile" style={{ color: COLORS.call }}>
              C
            </span>
          </div>
          {model.showMarkedOi ? <div>Marked OI value: call and put composition</div> : null}
          {model.showLiquidity ? (
            <div>
              Liquidity: bid/ask quote sizes, OI, volume, relative spread, and per-contract round
              trip
            </div>
          ) : null}
        </div>
      ) : null}
      <span
        id={summaryId}
        className="sr-only"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {retained ? 'Retained last snapshot. ' : ''}
        {model.accessibleSummary}
      </span>
    </div>
  );
}
