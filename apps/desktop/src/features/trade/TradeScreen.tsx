import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { OrderSide } from '@0dtetrader/shared-types';
import { useContainer } from '../../app/container';
import { useStore } from '../../core/observable';
import { NavBar } from '../../design/components/NavBar';
import { LayoutFullIcon, LayoutSplitIcon, PersonCircleIcon } from '../../design/icons';
import type { TradeLayout } from '../../core/storage/SettingsStore';
import { ChartView } from '../chart/ChartView';
import { IndicatorSettingsView } from '../chart/IndicatorSettingsView';
import { SymbolSearchView } from '../chart/SymbolSearchView';
import { ProfileView } from '../profile/ProfileView';
import { FloatingTradeButtons } from './FloatingTradeButtons';
import { OrderConfirmSheet } from './OrderConfirmSheet';
import { PositionsStrip } from './PositionsStrip';
import { ToastView } from './ToastView';
import { TradePanel } from './TradePanel';
import { futuresRootFor } from './futuresRoots';

const DIVIDER_HEIGHT = 18;

/**
 * The main screen (TradeScreenView.swift):
 * Layout A (fullscreen) — chart fills the screen, floating Buy/Sell overlaid;
 * Layout B (split) — chart on top, trade panel below, draggable divider.
 */
export function TradeScreen({ onLogout }: { onLogout: () => Promise<void> }) {
  const container = useContainer();
  const { chartStore, chainStore, tradeStore, settingsStore, quoteSocket } = container;

  const chart = useStore(chartStore);
  const trade = useStore(tradeStore);

  const [layout, setLayout] = useState<TradeLayout>(() => settingsStore.layoutMode);
  const [splitFraction, setSplitFraction] = useState(() => settingsStore.splitFraction);
  const [showSymbolSearch, setShowSymbolSearch] = useState(false);
  const [showIndicatorSettings, setShowIndicatorSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const dragRef = useRef<{ startY: number; startFraction: number } | null>(null);

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
    const root = futuresRootFor(chart.symbol);
    if (root) void tradeStore.setFuturesRoot(root);
  }, [chart.symbol, chainStore, tradeStore]);

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

  const panelHeight = Math.max(Math.round(contentHeight * splitFraction), 120);
  const chartHeight = Math.max(contentHeight - panelHeight - DIVIDER_HEIGHT, 100);

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
          <button className="navbar-icon-button" onClick={() => setShowProfile(true)} aria-label="Profile">
            <PersonCircleIcon size={22} />
          </button>
        }
        trailing={
          <button className="navbar-icon-button" onClick={toggleLayout} aria-label="Toggle layout">
            {layout === 'fullscreen' ? <LayoutSplitIcon size={20} /> : <LayoutFullIcon size={20} />}
          </button>
        }
      />

      <div ref={contentRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {layout === 'fullscreen' ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
            <ChartView
              store={chartStore}
              onSymbolSearch={() => setShowSymbolSearch(true)}
              onIndicatorSettings={() => setShowIndicatorSettings(true)}
            />
            <div
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {positionsStrip}
              <FloatingTradeButtons isEnabled onSide={arm} />
            </div>
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: chartHeight, flex: 'none', display: 'flex', flexDirection: 'column' }}>
              <ChartView
                store={chartStore}
                onSymbolSearch={() => setShowSymbolSearch(true)}
                onIndicatorSettings={() => setShowIndicatorSettings(true)}
              />
            </div>

            {/* Draggable divider */}
            <div
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
              aria-label="Resize trade panel"
              onPointerDown={(event) => {
                dragRef.current = { startY: event.clientY, startFraction: splitFraction };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (!drag || contentHeight === 0) return;
                const delta = (drag.startY - event.clientY) / contentHeight;
                setSplitFraction(Math.min(0.5, Math.max(0.25, drag.startFraction + delta)));
              }}
              onPointerUp={() => {
                if (dragRef.current) {
                  dragRef.current = null;
                  settingsStore.splitFraction = splitFraction;
                }
              }}
            >
              <div
                style={{ width: 48, height: 5, borderRadius: 2.5, background: 'var(--app-border)' }}
              />
            </div>

            <div style={{ height: panelHeight, flex: 'none', minHeight: 0 }}>
              <TradePanel tradeStore={tradeStore} chainStore={chainStore} onArm={arm} />
            </div>
          </div>
        )}
      </div>

      {/* Toast overlay */}
      {trade.toast ? <ToastView toast={trade.toast} /> : null}

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
    </div>
  );
}
