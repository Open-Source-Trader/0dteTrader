import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Me, OrderSide, TradingMode } from '@0dtetrader/shared-types';
import { useContainer } from '../../app/container';
import { useStore } from '../../core/observable';
import { AlertDialog } from '../../design/components/AlertDialog';
import { NavBar } from '../../design/components/NavBar';
import { Format } from '../../design/format';
import { ClockIcon, LayoutFullIcon, LayoutSplitIcon, PersonCircleIcon } from '../../design/icons';
import type { TradeLayout } from '../../core/storage/SettingsStore';
import { enabledSubPanes } from '../chart/indicatorSettings';
import { ChartView } from '../chart/ChartView';
import { IndicatorSettingsView } from '../chart/IndicatorSettingsView';
import { TwcSettingsView } from '../chart/TwcSettingsView';
import { SymbolSearchView } from '../chart/SymbolSearchView';
import { ProfileView } from '../profile/ProfileView';
import { FloatingTradeButtons } from './FloatingTradeButtons';
import { HistoryView } from './HistoryView';
import { OrderConfirmSheet } from './OrderConfirmSheet';
import { PositionsStrip } from './PositionsStrip';
import { ToastView } from './ToastView';
import { TradePanel } from './TradePanel';
import { optionsAnalyticsExpirationForChart } from './optionsAnalyticsSelection';

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
  } = container;

  const chart = useStore(chartStore);
  const trade = useStore(tradeStore);
  const chain = useStore(chainStore); // Chain selection supplies the exact analytics expiration.

  const [layout, setLayout] = useState<TradeLayout>(() => settingsStore.layoutMode);
  const [showSymbolSearch, setShowSymbolSearch] = useState(false);
  const [showIndicatorSettings, setShowIndicatorSettings] = useState(false);
  const [showTwcSettings, setShowTwcSettings] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // 'practice' is only the pre-fetch placeholder; the server value wins.
  const [tradingMode, setTradingMode] = useState<TradingMode>('practice');
  const [showModeConfirmation, setShowModeConfirmation] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const nextMode: TradingMode = tradingMode === 'live' ? 'practice' : 'live';

  // Active trading provider (from /v1/me) and whether it has credentials
  // stored for the current trading mode — drives the provider-aware copy and
  // the "configure provider" empty state.
  const tradingProvider = me?.tradingProvider ?? 'webull';
  const providerName = tradingProvider === 'alpaca' ? 'Alpaca' : 'Webull';
  const activeProviderConfigured = me
    ? tradingProvider === 'alpaca'
      ? tradingMode === 'practice'
        ? Boolean(me.alpacaPracticeConfigured)
        : Boolean(me.alpacaConfigured)
      : tradingMode === 'practice'
        ? Boolean(me.webullPracticeConfigured)
        : Boolean(me.webullConfigured)
    : true;
  const needsProviderConfig = me != null && !activeProviderConfigured;

  useEffect(() => {
    let cancelled = false;
    void apiClient
      .me()
      .then((m) => {
        if (!cancelled) {
          setTradingMode(m.tradingMode);
          setMe(m);
        }
      })
      .catch(() => {
        // Keep the placeholder; profile/quote errors surface elsewhere.
      });
    return () => {
      cancelled = true;
    };
  }, [apiClient]);

  const confirmModeSwitch = async () => {
    await apiClient.updateTradingMode(nextMode);
    // Deliberately simple: guarantees every store and the quote socket
    // re-init against the new environment.
    location.reload();
  };

  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);

  // Startup: candles + stream, positions/orders, chain.
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
  }, [chart.symbol, chainStore, drawingsStore]);

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
  const canTrade = chainStore.selectedContract !== null;

  // Explains a disabled BUY/SELL; rendered above the floating buttons.
  const disabledReason = chart.errorMessage
    ? 'Market data unavailable — check credentials in Profile'
    : !chainStore.selectedContract
      ? 'Select an option contract to trade'
      : null;

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
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}
    >
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
        {layout === 'fullscreen' ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
            <ChartView
              store={chartStore}
              drawingsStore={drawingsStore}
              apiClient={apiClient}
              onSymbolSearch={() => setShowSymbolSearch(true)}
              onIndicatorSettings={() => setShowIndicatorSettings(true)}
              tradingMode={tradingMode}
              onToggleMode={() => setShowModeConfirmation(true)}
              optionsAnalyticsExpiration={optionsAnalyticsExpiration}
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
                optionsAnalyticsExpiration={optionsAnalyticsExpiration}
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
              />
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
          twcEnabled={chart.twcSettings.enabled}
          onToggleTwc={(on) => chartStore.setTwcSettings({ ...chart.twcSettings, enabled: on })}
          onOpenTwcSettings={() => {
            setShowIndicatorSettings(false);
            setShowTwcSettings(true);
          }}
          optionsAnalytics={chart.optionsAnalytics}
          onChangeOptionsAnalytics={(settings) => chartStore.setOptionsAnalytics(settings)}
        />
      ) : null}
      {showTwcSettings ? (
        <TwcSettingsView
          settings={chart.twcSettings}
          onChange={(settings) => chartStore.setTwcSettings(settings)}
          onBack={() => {
            setShowTwcSettings(false);
            setShowIndicatorSettings(true);
          }}
          onDismiss={() => setShowTwcSettings(false)}
        />
      ) : null}
      {showProfile ? (
        <ProfileView onLogout={onLogout} onDismiss={() => setShowProfile(false)} />
      ) : null}
      {showHistory ? <HistoryView onDismiss={() => setShowHistory(false)} /> : null}
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
    </div>
  );
}
