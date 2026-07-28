import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import type {
  ChartOrder,
  Me,
  OptionContract,
  OrderSide,
  Position,
  TradingMode,
} from '@0dtetrader/shared-types';
import { narrowToChartOrderType } from '@0dtetrader/shared-types';
import { useContainer } from '../../app/container';
import { useLayoutBreakpoint } from '../../app/useLayoutBreakpoint';
import { useStore } from '../../core/observable';
import { AlertDialog } from '../../design/components/AlertDialog';
import { NavBar } from '../../design/components/NavBar';
import { Format } from '../../design/format';
import {
  ClockIcon,
  LayoutFullIcon,
  LayoutSplitIcon,
  LockIcon,
  LockOpenIcon,
  PersonCircleIcon,
  SlidersIcon,
} from '../../design/icons';
import { DesktopSettingsPanel } from '../../design/components/DesktopSettingsPanel';
import type { TradeLayout } from '../../core/storage/SettingsStore';
import { enabledSubPanes } from '../chart/indicatorSettings';
import type { ChartTradingProps } from '../chart/CandleChart';
import { ChartView } from '../chart/ChartView';
import { kindLabel } from '../chart/chartOrders';
import { IndicatorSettingsView } from '../chart/IndicatorSettingsView';
import { IndicatorSettingsDesktop } from '../chart/IndicatorSettingsDesktop';
import { SymbolSearchView } from '../chart/SymbolSearchView';
import { SymbolSpotlight } from '../chart/SymbolSpotlight';
import { ProfileView } from '../profile/ProfileView';
import { DesktopPositionsPanel } from './DesktopPositionsPanel';
import { DesktopChartTopBar } from './DesktopTopBar';
import { DesktopTradeTicket } from './DesktopTradeTicket';
import { FloatingTradeButtons } from './FloatingTradeButtons';
import { HistoryView } from './HistoryView';
import { OrderConfirmPopup } from './OrderConfirmPopup';
import { PositionsStrip } from './PositionsStrip';
import { ToastView } from './ToastView';
import { TradePanel } from './TradePanel';
import { optionsAnalyticsExpirationForChart } from './optionsAnalyticsSelection';
import { useTradeShortcuts } from './useTradeShortcuts';

const DIVIDER_HEIGHT = 1;

/**
 * The main screen (TradeScreenView.swift):
 * Layout A (fullscreen) — chart fills the screen, floating Buy/Sell overlaid;
 * Layout B (split) — chart on top, trade panel below at a fixed fraction:
 * 1/4 of the content height when sub-pane indicators are enabled (they take
 * chart space), 1/3 otherwise.
 */
export function TradeScreen({ onLogout }: { onLogout: () => Promise<void> }) {
  const container = useContainer();
  const {
    apiClient,
    chartStore,
    chainStore,
    tradeStore,
    settingsStore,
    quoteSocket,
    drawingsStore,
    chartOrdersStore,
  } = container;

  const chart = useStore(chartStore);
  const trade = useStore(tradeStore);
  const chain = useStore(chainStore); // Chain selection supplies the exact analytics expiration.

  const [layout, setLayout] = useState<TradeLayout>(() => settingsStore.layoutMode);
  const [locked, setLocked] = useState(() => settingsStore.tradingLocked);
  const [showSymbolSearch, setShowSymbolSearch] = useState(false);
  const [showIndicatorSettings, setShowIndicatorSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // 'practice' is only the pre-fetch placeholder; the server value wins.
  const [tradingMode, setTradingMode] = useState<TradingMode>('practice');
  const [showModeConfirmation, setShowModeConfirmation] = useState(false);
  const [chartTradingSettings, setChartTradingSettings] = useState(
    () => settingsStore.chartTrading,
  );
  // The entry line's ✕ sends a market order to close a real position, so it
  // confirms first — same gate as flattening from the positions strip.
  const [positionPendingChartFlatten, setPositionPendingChartFlatten] = useState<Position | null>(
    null,
  );
  // A working line's ✕ throws away a resting order the user set up deliberately,
  // so it confirms — matching the iOS alert rather than cancelling on one click.
  const [orderPendingCancel, setOrderPendingCancel] = useState<ChartOrder | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const nextMode: TradingMode = tradingMode === 'live' ? 'practice' : 'live';

  // Active trading provider (from /v1/me) and whether it has credentials
  // stored for the current trading mode — drives the provider-aware copy and
  // the "configure provider" empty state.
  const tradingProvider = me?.tradingProvider ?? 'webull';
  const providerName = tradingProvider === 'alpaca' ? 'Alpaca' : 'Webull';
  let activeProviderConfigured = true;
  if (me) {
    if (tradingProvider === 'alpaca') {
      activeProviderConfigured =
        tradingMode === 'practice'
          ? Boolean(me.alpacaPracticeConfigured)
          : Boolean(me.alpacaConfigured);
    } else {
      activeProviderConfigured =
        tradingMode === 'practice'
          ? Boolean(me.webullPracticeConfigured)
          : Boolean(me.webullConfigured);
    }
  }
  const needsProviderConfig = me != null && !activeProviderConfigured;

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .me()
      .then((m) => {
        if (cancelled) return;
        setTradingMode(m.tradingMode);
        setMe(m);
        // Session proven valid: if the initial candle load raced login and
        // left the chart empty, reload the current symbol rather than making
        // the user switch tickers to force it.
        const { candles, isLoading } = chartStore.getState();
        if (candles.length === 0 && !isLoading) void chartStore.start();
      })
      .catch(() => {
        // Keep the placeholder; profile/quote errors surface elsewhere.
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient, chartStore]);

  const confirmModeSwitch = async () => {
    await apiClient.updateTradingMode(nextMode);
    // Deliberately simple: guarantees every store and the quote socket
    // re-init against the new environment.
    location.reload();
  };

  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [shellRef, breakpoint] = useLayoutBreakpoint();
  const isDesktopGrid = breakpoint === 'standard' || breakpoint === 'wide';

  // Chart/ticket column widths for the desktop grid, persisted across
  // restarts (localStorage-backed, same mechanism SettingsStore uses).
  const desktopGridLayout = useDefaultLayout({
    id: 'trade-screen.desktop-grid',
    storage: localStorage,
    panelIds: ['chart', 'ticket'],
  });

  // Startup: candles + stream, positions/orders, chain.
  useEffect(() => {
    void chartStore.start();
    void tradeStore.refreshTradingData();
    tradeStore.optionContractResolver = (symbol) =>
      chainStore
        .getState()
        .chain?.contracts.find((contract: OptionContract) => contract.symbol === symbol);
    tradeStore.isSocketConnected = () => quoteSocket.getState().connectionState === 'connected';
    void chartOrdersStore.load();
    const offOrders = quoteSocket.onOrderUpdate((update) => tradeStore.handleOrderUpdate(update));
    // The server-side watcher fires lines with the app closed or backgrounded;
    // these pushes are how the chart learns about it.
    const offChartOrders = quoteSocket.onChartOrder((order) => {
      chartOrdersStore.applyServerUpdate(order);
      // A fired line means a real order went out — refresh positions so the
      // entry line appears without waiting for the next poll.
      void tradeStore.refreshTradingData();
    });
    // Pushes that landed while the socket was down are gone; re-read on the
    // way back rather than drawing a bracket that already fired.
    const offReconnect = quoteSocket.onReconnect(() => {
      void chartOrdersStore.load();
      void tradeStore.refreshTradingData();
    });
    return () => {
      offOrders();
      offChartOrders();
      offReconnect();
    };
  }, [chartStore, tradeStore, chainStore, chartOrdersStore, quoteSocket]);

  useEffect(() => {
    void chainStore.load(chart.symbol);
    drawingsStore.setSymbol(chart.symbol);
    chartOrdersStore.setSymbol(chart.symbol);
  }, [chart.symbol, chainStore, drawingsStore, chartOrdersStore]);

  // Stream live quotes for the selected contracts and all open positions.
  // The chart's own symbol is excluded: its subscription is owned by ChartStore.
  const watchedKey = [
    ...new Set(
      [
        chainStore.selectedContract?.symbol,
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

  // Keep indicative chain quotes fresh; paused while the confirm
  // sheet is open so the armed ticket's context doesn't shift underneath it.
  useEffect(() => {
    const timer = setInterval(() => {
      if (tradeStore.getState().armedTicket) return;
      void chainStore.refresh();
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
      // Chart order lines fire off the same tick. The store nudges the server,
      // which is also polling — the shared idempotency key makes that a race
      // with one winner rather than two orders.
      chartOrdersStore.applyQuote(symbol, quote.last);
    });
  }, [quoteSocket, chartStore, chainStore, drawingsStore, tradeStore, chartOrdersStore]);

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

  const toggleLock = () => {
    const next = !locked;
    setLocked(next);
    settingsStore.tradingLocked = next;
  };

  const arm = (side: OrderSide) => {
    tradeStore.arm(
      side,
      chartStore.getState().symbol,
      chainStore,
      settingsStore.bypassOrderConfirmation,
    );
  };

  // Same gate as the split-layout TradePanel's Buy/Sell buttons; the lock
  // disables every order-placing control while leaving the chart untouched.
  const canTrade = chainStore.selectedContract !== null && !locked;

  // Desktop-grid-only keyboard layer: Cmd/Ctrl+K always opens the symbol
  // command palette; B/S arm an order and L toggles the lock, gated by the
  // user's "Trading shortcuts" preference (Profile › Desktop) — that
  // preference guards trading actions only, not navigation, so disabling it
  // must not also disable Cmd+K. Read live off the store, same as
  // bypassOrderConfirmation, so toggling it while Profile is open takes
  // effect immediately. The compact layout has no command palette or
  // hotkeys at all (floating touch buttons instead).
  useTradeShortcuts({
    enabled: isDesktopGrid,
    tradingShortcutsEnabled: settingsStore.keyboardShortcutsEnabled,
    canTrade,
    onArm: arm,
    onToggleLock: toggleLock,
    onOpenSymbolSearch: () => setShowSymbolSearch(true),
  });

  // Explains a disabled BUY/SELL; rendered above the floating buttons.
  let disabledReason: string | null = null;
  if (locked) {
    disabledReason = 'Trading locked';
  } else if (chart.errorMessage) {
    disabledReason = 'Market data unavailable — check credentials in Profile';
  } else if (!chainStore.selectedContract) {
    disabledReason = 'Select an option contract to trade';
  }

  // Fixed split sized by sub-pane count (0/1/2): each pane takes chart
  // height, so the panel shrinks and its content compacts to match — the
  // panel never scrolls (see TradePanel density).
  // No pixel floor: at the phone frame's height the fraction lands under the
  // old 300px floor and would never switch.
  const paneCount = enabledSubPanes(chart.indicatorSettings).length;
  const PANEL_FRACTIONS = [1 / 3, 0.3, 0.27] as const;
  const PANEL_DENSITIES = ['roomy', 'compact', 'dense'] as const;
  const panelHeight = Math.round(contentHeight * PANEL_FRACTIONS[paneCount]);
  const panelDensity = PANEL_DENSITIES[paneCount];
  const chartHeight = Math.max(contentHeight - panelHeight - DIVIDER_HEIGHT, 96);
  const optionsAnalyticsExpiration = optionsAnalyticsExpirationForChart(
    chart.symbol,
    chain.underlying,
    chain.selectedExpiration,
  );

  // Order-line overlay inputs. resolveContract reuses the same chain lookup the
  // flatten path already depends on, so an entry line only draws for a contract
  // whose chain is loaded — the same constraint, surfaced the same way.
  const chartTrading: ChartTradingProps = {
    store: chartOrdersStore,
    settings: chartTradingSettings,
    positions: trade.positions,
    resolveContract: (contractSymbol) =>
      chainStore.getState().chain?.contracts.find((c) => c.symbol === contractSymbol) ?? null,
    selectedContract: chainStore.selectedContract,
    // Narrowed here, at the one seam where the panel's five-way pricing meets
    // the chart's two-way. A line fires unattended, so `custom`/`bid`/`ask`
    // collapse onto the server-computed mid — see narrowToChartOrderType.
    defaultOrderType: narrowToChartOrderType(trade.orderType),
    onFlatten: (position) => setPositionPendingChartFlatten(position),
    onCancelOrder: (order) => setOrderPendingCancel(order),
  };

  const positionsStrip = (
    <PositionsStrip
      positions={trade.positions}
      openOrders={trade.openOrders}
      workingSymbols={trade.workingSymbols}
      onFlatten={(position) => void tradeStore.flatten(position)}
      onCancelOrder={(order) => void tradeStore.cancel(order)}
      locked={locked}
    />
  );

  // Desktop grid: tabbed dense table instead of the phone strip's chip row.
  const desktopPositionsPanel = (
    <DesktopPositionsPanel
      positions={trade.positions}
      openOrders={trade.openOrders}
      workingSymbols={trade.workingSymbols}
      onFlatten={(position) => void tradeStore.flatten(position)}
      onCancelOrder={(order) => void tradeStore.cancel(order)}
      locked={locked}
    />
  );

  let contentArea: React.ReactNode;
  if (isDesktopGrid) {
    contentArea = (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        <Group
          orientation="horizontal"
          style={{ flex: 1, minHeight: 0, display: 'flex' }}
          defaultLayout={desktopGridLayout.defaultLayout}
          onLayoutChanged={desktopGridLayout.onLayoutChanged}
        >
          <Panel
            id="chart"
            defaultSize={breakpoint === 'wide' ? '78' : '70'}
            minSize="40"
            style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}
          >
            <DesktopChartTopBar
              chartStore={chartStore}
              chart={chart}
              onSymbolSearch={() => setShowSymbolSearch(true)}
              onIndicatorSettings={() => setShowIndicatorSettings(true)}
              tradingMode={tradingMode}
              onToggleMode={() => setShowModeConfirmation(true)}
            />
            <ChartView
              store={chartStore}
              drawingsStore={drawingsStore}
              apiClient={apiClient}
              onSymbolSearch={() => setShowSymbolSearch(true)}
              onIndicatorSettings={() => setShowIndicatorSettings(true)}
              tradingMode={tradingMode}
              onToggleMode={() => setShowModeConfirmation(true)}
              onToggleFullscreen={toggleLayout}
              optionsAnalyticsExpiration={optionsAnalyticsExpiration}
              chartTrading={chartTrading}
              dense
              positionsLocked={locked}
              onToggleLock={toggleLock}
              onShowHistory={() => setShowHistory(true)}
              onShowProfile={() => setShowProfile(true)}
            />
          </Panel>

          {/* Draggable divider between chart and the order ticket rail. */}
          <Separator
            style={{
              width: 5,
              flex: 'none',
              cursor: 'col-resize',
              background: 'var(--hud-stroke-dim)',
            }}
          />

          {/* Order ticket + chain rail: always visible, never a sheet —
              a scalper needs the ticket armed and ready without a click
              to reveal it. */}
          <Panel
            id="ticket"
            defaultSize={breakpoint === 'wide' ? '22' : '30'}
            minSize="18"
            style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}
          >
            <DesktopTradeTicket
              tradeStore={tradeStore}
              chainStore={chainStore}
              onArm={arm}
              locked={locked}
            />
          </Panel>
        </Group>

        {/* Static hairline between the main row and the positions footer */}
        <div
          aria-hidden
          style={{ height: DIVIDER_HEIGHT, flex: 'none', background: 'var(--hud-stroke-dim)' }}
        />

        {/* Positions/orders footer: full width, always visible so open
            risk is never a click away. */}
        <div style={{ flex: 'none', height: 160, minHeight: 0 }}>{desktopPositionsPanel}</div>
      </div>
    );
  } else if (layout === 'fullscreen') {
    contentArea = (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        <ChartView
          store={chartStore}
          drawingsStore={drawingsStore}
          apiClient={apiClient}
          onSymbolSearch={() => setShowSymbolSearch(true)}
          onIndicatorSettings={() => setShowIndicatorSettings(true)}
          tradingMode={tradingMode}
          onToggleMode={() => setShowModeConfirmation(true)}
          onToggleFullscreen={toggleLayout}
          optionsAnalyticsExpiration={optionsAnalyticsExpiration}
          chartTrading={chartTrading}
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
            background: 'linear-gradient(to bottom, rgba(0,0,0,0), var(--app-background) 78%)',
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
          <FloatingTradeButtons isEnabled={canTrade} disabledReason={disabledReason} onSide={arm} />
        </div>
      </div>
    );
  } else {
    contentArea = (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
        <div
          style={{
            height: chartHeight,
            flex: 'none',
            display: 'flex',
            flexDirection: 'column',
            transition: 'height 200ms cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        >
          <ChartView
            store={chartStore}
            drawingsStore={drawingsStore}
            apiClient={apiClient}
            onSymbolSearch={() => setShowSymbolSearch(true)}
            onIndicatorSettings={() => setShowIndicatorSettings(true)}
            tradingMode={tradingMode}
            onToggleMode={() => setShowModeConfirmation(true)}
            onToggleFullscreen={toggleLayout}
            optionsAnalyticsExpiration={optionsAnalyticsExpiration}
            chartTrading={chartTrading}
          />
        </div>

        {/* Static hairline between chart and panel */}
        <div
          aria-hidden
          style={{ height: DIVIDER_HEIGHT, flex: 'none', background: 'var(--hud-stroke-dim)' }}
        />

        <div
          style={{
            height: panelHeight,
            flex: 'none',
            minHeight: 0,
            transition: 'height 200ms cubic-bezier(0.32, 0.72, 0, 1)',
          }}
        >
          <TradePanel
            tradeStore={tradeStore}
            chainStore={chainStore}
            onArm={arm}
            density={panelDensity}
            locked={locked}
            onToggleLock={toggleLock}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
      {/* Desktop grid uses DesktopTopBar instead — one merged row with the
          chart's own symbol/price alongside these same global actions,
          rather than a full-width app NavBar stacked above a second,
          separate chart header. */}
      {isDesktopGrid ? null : (
        <NavBar
          title="0dteTrader"
          leading={
            <>
              <button
                className="navbar-icon-button"
                onClick={() => setShowProfile(true)}
                aria-label="Profile"
              >
                <PersonCircleIcon size={22} />
              </button>
              <button
                className="navbar-icon-button"
                onClick={() => setShowHistory(true)}
                aria-label="Trade history"
              >
                <ClockIcon size={22} />
              </button>
            </>
          }
          trailing={
            <>
              <button
                className="navbar-icon-button"
                onClick={toggleLock}
                aria-pressed={locked}
                aria-label={locked ? 'Unlock trading' : 'Lock trading'}
              >
                {locked ? <LockIcon size={22} /> : <LockOpenIcon size={22} />}
              </button>
              <button
                className="navbar-icon-button"
                onClick={toggleLayout}
                aria-pressed={layout === 'split'}
                aria-label={
                  layout === 'fullscreen' ? 'Switch to split layout' : 'Switch to fullscreen layout'
                }
              >
                {layout === 'fullscreen' ? (
                  <LayoutSplitIcon size={22} />
                ) : (
                  <LayoutFullIcon size={22} />
                )}
              </button>
            </>
          }
        />
      )}

      {needsProviderConfig ? (
        <button
          type="button"
          onClick={() => setShowProfile(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            padding: '8px 12px',
            width: '100%',
            border: 'none',
            cursor: 'pointer',
            background: 'var(--hud-stroke-dim)',
            color: 'var(--text-primary)',
            fontSize: 13,
          }}
        >
          No {providerName} credentials configured — open Profile to connect.
        </button>
      ) : null}

      <div ref={contentRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {contentArea}
      </div>

      {/* Toast overlay */}
      {trade.toast ? (
        <ToastView toast={trade.toast} onDismiss={() => tradeStore.dismissToast()} />
      ) : null}

      {/* The order confirmation is an anchored popup over the SELL/BUY row,
          not a sheet — but it is still driven by the armed ticket, which is
          what makes Cancel, the scrim and a successful submit one path. */}
      {trade.armedTicket ? (
        <OrderConfirmPopup tradeStore={tradeStore} ticket={trade.armedTicket} />
      ) : null}
      {showSymbolSearch && isDesktopGrid ? (
        <SymbolSpotlight
          currentSymbol={chart.symbol}
          onSelect={(symbol) => chartStore.selectSymbol(symbol)}
          onDismiss={() => setShowSymbolSearch(false)}
        />
      ) : null}
      {showSymbolSearch && !isDesktopGrid ? (
        <SymbolSearchView
          currentSymbol={chart.symbol}
          onSelect={(symbol) => chartStore.selectSymbol(symbol)}
          onDismiss={() => setShowSymbolSearch(false)}
        />
      ) : null}
      {isDesktopGrid && (showIndicatorSettings || showProfile) ? (
        <DesktopSettingsPanel
          initialTabKey={showProfile ? 'account' : 'indicators'}
          onDismiss={() => {
            setShowIndicatorSettings(false);
            setShowProfile(false);
          }}
          tabs={[
            {
              key: 'account',
              label: 'Account',
              icon: <PersonCircleIcon size={18} />,
              content: (
                <ProfileView onLogout={onLogout} onDismiss={() => setShowProfile(false)} bodyOnly />
              ),
            },
            {
              key: 'indicators',
              label: 'Indicators',
              icon: <SlidersIcon size={18} />,
              content: (
                <IndicatorSettingsDesktop
                  settings={chart.indicatorSettings}
                  onChange={(settings) => chartStore.setIndicatorSettings(settings)}
                  twcEnabled={chart.twcSettings.enabled}
                  onToggleTwc={(on) =>
                    chartStore.setTwcSettings({ ...chart.twcSettings, enabled: on })
                  }
                  twcSettings={chart.twcSettings}
                  onChangeTwcSettings={(settings) => chartStore.setTwcSettings(settings)}
                  optionsAnalytics={chart.optionsAnalytics}
                  onChangeOptionsAnalytics={(settings) => chartStore.setOptionsAnalytics(settings)}
                />
              ),
            },
          ]}
        />
      ) : null}
      {!isDesktopGrid && showIndicatorSettings ? (
        <IndicatorSettingsView
          settings={chart.indicatorSettings}
          onChange={(settings) => chartStore.setIndicatorSettings(settings)}
          onDismiss={() => setShowIndicatorSettings(false)}
          twcEnabled={chart.twcSettings.enabled}
          onToggleTwc={(on) => chartStore.setTwcSettings({ ...chart.twcSettings, enabled: on })}
          twcSettings={chart.twcSettings}
          onChangeTwcSettings={(settings) => chartStore.setTwcSettings(settings)}
          optionsAnalytics={chart.optionsAnalytics}
          onChangeOptionsAnalytics={(settings) => chartStore.setOptionsAnalytics(settings)}
          chartTrading={chartTradingSettings}
          onChangeChartTrading={(settings) => {
            settingsStore.chartTrading = settings;
            setChartTradingSettings(settings);
          }}
        />
      ) : null}
      {!isDesktopGrid && showProfile ? (
        <ProfileView onLogout={onLogout} onDismiss={() => setShowProfile(false)} />
      ) : null}
      {showHistory ? (
        <HistoryView onDismiss={() => setShowHistory(false)} dense={isDesktopGrid} />
      ) : null}
      {showModeConfirmation ? (
        <AlertDialog
          title={nextMode === 'live' ? 'Switch to LIVE trading?' : 'Switch to PRACTICE mode?'}
          message={
            nextMode === 'live'
              ? 'Real money will be used for orders and quotes.'
              : `Orders will go to the ${providerName} paper environment.`
          }
          actions={[
            {
              label: nextMode === 'live' ? 'Switch to LIVE' : 'Switch to PRACTICE',
              role: nextMode === 'live' ? 'destructive' : undefined,
              onSelect: () => void confirmModeSwitch(),
            },
            { label: 'Cancel', role: 'cancel' },
          ]}
          onDismiss={() => setShowModeConfirmation(false)}
        />
      ) : null}
      {positionPendingChartFlatten ? (
        <AlertDialog
          title="Close position?"
          message={`Sends a market order to close ${positionPendingChartFlatten.symbol}. Only this contract is closed.`}
          actions={[
            {
              label: 'Close position',
              role: 'destructive',
              onSelect: () => void tradeStore.flatten(positionPendingChartFlatten),
            },
            { label: 'Cancel', role: 'cancel' },
          ]}
          onDismiss={() => setPositionPendingChartFlatten(null)}
        />
      ) : null}
      {orderPendingCancel ? (
        <AlertDialog
          title="Cancel order line?"
          message={`Removes the ${kindLabel(orderPendingCancel.kind)} line at ${Format.price(
            orderPendingCancel.triggerPrice,
          )}. Nothing was sent to the broker.`}
          actions={[
            {
              label: 'Cancel line',
              role: 'destructive',
              onSelect: () => void chartOrdersStore.cancel(orderPendingCancel.id),
            },
            { label: 'Keep', role: 'cancel' },
          ]}
          onDismiss={() => setOrderPendingCancel(null)}
        />
      ) : null}
    </div>
  );
}
