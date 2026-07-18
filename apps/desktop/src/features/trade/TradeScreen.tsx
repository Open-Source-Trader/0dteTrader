import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { OrderSide } from '@0dtetrader/shared-types';
import { useContainer } from '../../app/container';
import { useStore } from '../../core/observable';
import { NavBar } from '../../design/components/NavBar';
import { Format } from '../../design/format';
import { ClockIcon, LayoutFullIcon, LayoutSplitIcon, PersonCircleIcon } from '../../design/icons';
import type { TradeLayout } from '../../core/storage/SettingsStore';
import { ChartView } from '../chart/ChartView';
import { IndicatorSettingsView } from '../chart/IndicatorSettingsView';
import { SymbolSearchView } from '../chart/SymbolSearchView';
import { ProfileView } from '../profile/ProfileView';
import { FloatingTradeButtons } from './FloatingTradeButtons';
import { HistoryView } from './HistoryView';
import { OrderConfirmSheet } from './OrderConfirmSheet';
import { PositionsStrip } from './PositionsStrip';
import { ToastView } from './ToastView';
import { TradePanel } from './TradePanel';
import { futuresRootFor } from './futuresRoots';

const DIVIDER_HEIGHT = 20;

/**
 * The main screen (TradeScreenView.swift):
 * Layout A (fullscreen) — chart fills the screen, floating Buy/Sell overlaid;
 * Layout B (split) — chart on top, trade panel below, draggable divider.
 */
export function TradeScreen({ onLogout }: { onLogout: () => Promise<void> }) {
  const container = useContainer();
  const { chartStore, chainStore, tradeStore, settingsStore, quoteSocket, drawingsStore } =
    container;

  const chart = useStore(chartStore);
  const trade = useStore(tradeStore);
  useStore(chainStore); // re-render when the chain selection changes (canTrade below)

  const [layout, setLayout] = useState<TradeLayout>(() => settingsStore.layoutMode);
  const [splitFraction, setSplitFraction] = useState(() => settingsStore.splitFraction);
  const [showSymbolSearch, setShowSymbolSearch] = useState(false);
  const [showIndicatorSettings, setShowIndicatorSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const dragRef = useRef<{ startY: number; startFraction: number; scale: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dividerHover, setDividerHover] = useState(false);
  const rafRef = useRef(0);
  const lastFractionRef = useRef(splitFraction);

  // Startup: candles + stream, positions/orders, chain, futures root sync.
  useEffect(() => {
    void chartStore.start();
    void tradeStore.refreshTradingData();
    tradeStore.optionContractResolver = (symbol) =>
      chainStore.getState().chain?.contracts.find((contract) => contract.symbol === symbol);
    return quoteSocket.onOrderUpdate((update) => tradeStore.handleOrderUpdate(update));
  }, [chartStore, tradeStore, chainStore, quoteSocket]);

  useEffect(() => {
    void chainStore.load(chart.symbol);
    drawingsStore.setSymbol(chart.symbol);
    const root = futuresRootFor(chart.symbol);
    if (root) void tradeStore.setFuturesRoot(root);
  }, [chart.symbol, chainStore, tradeStore, drawingsStore]);

  // Stream live quotes for the selected contracts and all open positions.
  // The chart's own symbol is excluded: its subscription is owned by ChartStore.
  const watchedKey = [
    ...new Set(
      [
        chainStore.selectedContract?.symbol,
        trade.selectedFutureSymbol,
        ...trade.positions.map((position) => position.symbol),
      ].filter((symbol): symbol is string => Boolean(symbol) && symbol !== chart.symbol),
    ),
  ]
    .sort()
    .join(',');
  useEffect(() => {
    if (!watchedKey) return;
    const symbols = watchedKey.split(',');
    quoteSocket.subscribeSymbols(symbols);
    return () => quoteSocket.unsubscribeSymbols(symbols);
  }, [watchedKey, quoteSocket]);

  useEffect(
    () =>
      quoteSocket.onQuote((quote) => {
        // No-ops for symbols that aren't a known contract or position.
        chainStore.applyContractQuote(quote);
        tradeStore.applyContractQuote(quote);
      }),
    [quoteSocket, chainStore, tradeStore],
  );

  // Keep indicative chain/futures quotes fresh; paused while the confirm
  // sheet is open so the armed ticket's context doesn't shift underneath it.
  useEffect(() => {
    const timer = setInterval(() => {
      if (tradeStore.getState().armedTicket) return;
      void chainStore.refresh();
      void tradeStore.loadFuturesContracts(true);
    }, 30_000);
    return () => clearInterval(timer);
  }, [chainStore, tradeStore]);

  // Price alerts: toast when the live price crosses an alert line.
  useEffect(() => {
    let prevLast: number | null = null;
    let prevSymbol = '';
    return quoteSocket.onQuote((quote) => {
      const symbol = chartStore.getState().symbol;
      if (quote.symbol !== symbol) return;
      // Keep AUTO's reference price live instead of the chain-load snapshot.
      if (chainStore.getState().underlying === symbol) {
        chainStore.setUnderlyingLast(quote.last);
      }
      if (prevSymbol !== symbol) {
        prevSymbol = symbol;
        prevLast = null;
      }
      if (prevLast !== null) {
        for (const alert of drawingsStore.checkAlerts(prevLast, quote.last)) {
          tradeStore.showToast(`Alert: ${symbol} crossed ${Format.price(alert.price)}`, 'info');
        }
      }
      prevLast = quote.last;
    });
  }, [quoteSocket, chartStore, chainStore, drawingsStore, tradeStore]);

  // Track the content area height for the split layout math.
  useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setContentHeight(element.clientHeight));
    observer.observe(element);
    setContentHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  const toggleLayout = () => {
    const next: TradeLayout = layout === 'fullscreen' ? 'split' : 'fullscreen';
    setLayout(next);
    settingsStore.layoutMode = next;
  };

  const arm = (side: OrderSide) => {
    tradeStore.arm(side, chartStore.getState().symbol, chainStore);
  };

  // Same gate as the split-layout TradePanel's Buy/Sell buttons.
  const canTrade =
    trade.assetClass === 'option'
      ? chainStore.selectedContract !== null
      : tradeStore.selectedFuture !== null;

  // Explains a disabled BUY/SELL; rendered above the floating buttons.
  const disabledReason = chart.errorMessage
    ? 'Market data unavailable — check credentials in Profile'
    : trade.assetClass === 'option' && !chainStore.selectedContract
      ? 'Select an option contract to trade'
      : trade.assetClass === 'future' && !tradeStore.selectedFuture
        ? 'Select a futures contract to trade'
        : null;

  // 300px floor keeps the whole ticket (incl. the SELL/BUY row) reachable.
  const panelHeight = Math.max(Math.round(contentHeight * splitFraction), 300);
  const chartHeight = Math.max(contentHeight - panelHeight - DIVIDER_HEIGHT, 96);

  const endDrag = () => {
    if (dragRef.current) {
      dragRef.current = null;
      setDragging(false);
      cancelAnimationFrame(rafRef.current);
      const fraction = lastFractionRef.current;
      setSplitFraction(fraction);
      settingsStore.splitFraction = fraction;
    }
  };

  const positionsStrip = (
    <PositionsStrip
      positions={trade.positions}
      openOrders={trade.openOrders}
      workingSymbols={trade.workingSymbols}
      onFlatten={(position) => void tradeStore.flatten(position)}
      onCancelOrder={(order) => void tradeStore.cancel(order)}
    />
  );

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
      <NavBar
        leading={
          <>
            <button className="navbar-icon-button" onClick={() => setShowProfile(true)} aria-label="Profile">
              <PersonCircleIcon size={22} />
            </button>
            <button className="navbar-icon-button" onClick={() => setShowHistory(true)} aria-label="Trade history">
              <ClockIcon size={22} />
            </button>
          </>
        }
        trailing={
          <button
            className="navbar-icon-button"
            onClick={toggleLayout}
            aria-pressed={layout === 'split'}
            aria-label={
              layout === 'fullscreen' ? 'Switch to split layout' : 'Switch to fullscreen layout'
            }
          >
            {layout === 'fullscreen' ? <LayoutSplitIcon size={22} /> : <LayoutFullIcon size={22} />}
          </button>
        }
      />

      <div ref={contentRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {layout === 'fullscreen' ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
            <ChartView
              store={chartStore}
              drawingsStore={drawingsStore}
              onSymbolSearch={() => setShowSymbolSearch(true)}
              onIndicatorSettings={() => setShowIndicatorSettings(true)}
            />
            {/* Scrim so the dock never lets chart content bleed through the buttons */}
            <div
              aria-hidden
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: 190,
                pointerEvents: 'none',
                background:
                  'linear-gradient(to bottom, rgba(0,0,0,0), var(--app-background) 78%)',
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {positionsStrip}
              <FloatingTradeButtons
                isEnabled={canTrade}
                disabledReason={disabledReason}
                onSide={arm}
              />
            </div>
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                height: chartHeight,
                flex: 'none',
                display: 'flex',
                flexDirection: 'column',
                transition: dragging ? 'none' : 'height 200ms cubic-bezier(0.32, 0.72, 0, 1)',
              }}
            >
              <ChartView
                store={chartStore}
                drawingsStore={drawingsStore}
                onSymbolSearch={() => setShowSymbolSearch(true)}
                onIndicatorSettings={() => setShowIndicatorSettings(true)}
              />
            </div>

            {/* Draggable divider */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize trade panel"
              aria-valuenow={Math.round(splitFraction * 100)}
              aria-valuemin={34}
              aria-valuemax={50}
              tabIndex={0}
              style={{
                height: DIVIDER_HEIGHT,
                flex: 'none',
                background: 'var(--app-surface)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'ns-resize',
                touchAction: 'none',
              }}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 0.05 : 0.01;
                let next: number | null = null;
                if (event.key === 'ArrowUp') next = Math.min(0.5, splitFraction + step);
                if (event.key === 'ArrowDown') next = Math.max(0.34, splitFraction - step);
                if (next !== null) {
                  event.preventDefault();
                  setSplitFraction(next);
                  settingsStore.splitFraction = next;
                }
              }}
              onPointerEnter={() => setDividerHover(true)}
              onPointerLeave={() => setDividerHover(false)}
              onPointerDown={(event) => {
                // The whole frame is scaled; convert screen px to logical px.
                const target = event.currentTarget;
                const scale = target.getBoundingClientRect().height / target.offsetHeight || 1;
                dragRef.current = { startY: event.clientY, startFraction: splitFraction, scale };
                setDragging(true);
                target.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || contentHeight === 0) return;
                const delta = (drag.startY - event.clientY) / drag.scale / contentHeight;
                const fraction = Math.min(0.5, Math.max(0.34, drag.startFraction + delta));
                lastFractionRef.current = fraction;
                // Throttle state updates to one per frame during the drag.
                cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => setSplitFraction(fraction));
              }}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <div
                style={{
                  width: 48,
                  height: 4,
                  borderRadius: 2,
                  background:
                    dragging || dividerHover ? 'var(--label-primary)' : 'var(--label-secondary)',
                  transition: 'background 150ms ease-out',
                }}
              />
            </div>

            <div
              style={{
                height: panelHeight,
                flex: 'none',
                minHeight: 0,
                transition: dragging ? 'none' : 'height 200ms cubic-bezier(0.32, 0.72, 0, 1)',
              }}
            >
              <TradePanel tradeStore={tradeStore} chainStore={chainStore} onArm={arm} />
            </div>
          </div>
        )}
      </div>

      {/* Toast overlay */}
      {trade.toast ? (
        <ToastView toast={trade.toast} onDismiss={() => tradeStore.dismissToast()} />
      ) : null}

      {/* Sheets */}
      {trade.armedTicket ? (
        <OrderConfirmSheet tradeStore={tradeStore} ticket={trade.armedTicket} />
      ) : null}
      {showSymbolSearch ? (
        <SymbolSearchView
          currentSymbol={chart.symbol}
          onSelect={(symbol) => chartStore.selectSymbol(symbol)}
          onDismiss={() => setShowSymbolSearch(false)}
        />
      ) : null}
      {showIndicatorSettings ? (
        <IndicatorSettingsView
          settings={chart.indicatorSettings}
          onChange={(settings) => chartStore.setIndicatorSettings(settings)}
          onDismiss={() => setShowIndicatorSettings(false)}
        />
      ) : null}
      {showProfile ? (
        <ProfileView onLogout={onLogout} onDismiss={() => setShowProfile(false)} />
      ) : null}
      {showHistory ? <HistoryView onDismiss={() => setShowHistory(false)} /> : null}
    </div>
  );
}
