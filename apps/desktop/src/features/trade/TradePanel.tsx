import type { OrderSide } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { midPrice } from '../../core/models/domain';
import { dayString } from '../../core/models/dates';
import { Menu } from '../../design/components/Menu';
import { QuickChip } from '../../design/components/QuickChip';
import { SegmentedControl } from '../../design/components/SegmentedControl';
import { Spinner } from '../../design/components/Spinner';
import { Stepper } from '../../design/components/Stepper';
import { TradeActionButton } from '../../design/components/TradeActionButton';
import { Format } from '../../design/format';
import {
  CalendarIcon,
  ChartLineIcon,
  CheckmarkIcon,
} from '../../design/icons';
import type { ChainStore } from './ChainStore';
import type { TradeStore } from './TradeStore';
import { PositionsStrip } from './PositionsStrip';

interface TradePanelProps {
  tradeStore: TradeStore;
  chainStore: ChainStore;
  onArm: (side: OrderSide) => void;
  /**
   * Spacing tier driven by how many chart sub-panes are showing (0/1/2):
   * the panel's fixed height shrinks as panes appear, and the content
   * compacts to fit — the panel never scrolls.
   */
  density?: 'roomy' | 'compact' | 'dense';
}

const DENSITY = {
  roomy: { gap: 8, padding: '8px 16px 12px', stripMaxHeight: 140 },
  compact: { gap: 6, padding: '6px 16px 8px', stripMaxHeight: 100 },
  dense: { gap: 4, padding: '4px 16px 4px', stripMaxHeight: 64 },
} as const;

function expirationLabel(expiration: string): string {
  return expiration === dayString() ? `${expiration} · 0DTE` : expiration;
}

/** Layout B's bottom trade panel (TradePanelView.swift). */
export function TradePanel({ tradeStore, chainStore, onArm, density = 'roomy' }: TradePanelProps) {
  const trade = useStore(tradeStore);
  const chain = useStore(chainStore);

  const autoContract = chainStore.autoContract;
  const selectedContract = chainStore.selectedContract;
  const autoMid = autoContract ? midPrice(autoContract.bid, autoContract.ask) : null;

  const canTrade = selectedContract !== null;

  const selectedQuote = selectedContract;
  const indicativeMid = selectedQuote ? midPrice(selectedQuote.bid, selectedQuote.ask) : null;

  const d = DENSITY[density];

  return (
    <div
      className={`trade-panel ${density}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: d.gap,
        padding: d.padding,
        background: 'var(--app-background)',
        height: '100%',
        // The panel is sized to fit its content at every density — it must
        // never grow a scrollbar.
        overflow: 'hidden',
      }}
    >
      <PositionsStrip
        positions={trade.positions}
        openOrders={trade.openOrders}
        workingSymbols={trade.workingSymbols}
        onFlatten={(position) => void tradeStore.flatten(position)}
        onCancelOrder={(order) => void tradeStore.cancel(order)}
        rowPadding="0"
        maxHeight={d.stripMaxHeight}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: d.gap }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <SegmentedControl
            options={[
              { value: 'call', label: 'Call' },
              { value: 'put', label: 'Put' },
            ]}
            value={chain.optionType}
            onChange={(value) => chainStore.setOptionType(value)}
          />
          <button
            style={{
              fontSize: 'var(--fs-caption)',
              fontWeight: 600,
              padding: '10px 14px',
              borderRadius: 999,
              background: chain.isAutoMode ? 'var(--app-accent)' : 'var(--app-surface-elevated)',
              color: chain.isAutoMode ? '#0b0c10' : 'var(--label-primary)',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
            }}
            onClick={() => chainStore.setAutoMode(!chain.isAutoMode)}
            aria-label="Auto +1 OTM selection"
            aria-pressed={chain.isAutoMode}
          >
            {chain.isAutoMode ? <CheckmarkIcon size={11} /> : null}
            AUTO
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <Menu
            className="chip-flex"
            direction="up"
            trigger={
              <button className="chip-button">
                <CalendarIcon size={13} />
                <span className="chip-title">
                  {chain.selectedExpiration
                    ? expirationLabel(chain.selectedExpiration)
                    : 'Expiration'}
                </span>
              </button>
            }
            items={chainStore.expirations.map((expiration) => ({
              key: expiration,
              label: expirationLabel(expiration),
              checked: expiration === chain.selectedExpiration,
              onSelect: () => chainStore.selectExpiration(expiration),
            }))}
          />

          {chain.isAutoMode ? (
            <div
              style={{
                flex: 1,
                minWidth: 0,
                minHeight: 36,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                padding: '0 10px',
                background: 'var(--app-surface)',
                borderRadius: 'var(--radius-chip)',
              }}
            >
              {chain.errorMessage ? (
                <button
                  className="text-secondary"
                  style={{
                    fontSize: 'var(--fs-caption)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                  onClick={() => void chainStore.load(chain.underlying)}
                  aria-label={`Chain failed to load: ${chain.errorMessage}. Activate to retry`}
                >
                  <span style={{ color: 'var(--pnl-negative)' }}>Chain unavailable — Retry</span>
                </button>
              ) : chain.isLoading ? (
                <Spinner size={14} />
              ) : autoContract ? (
                <>
                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--fs-body)',
                      fontWeight: 500,
                    }}
                  >
                    {Format.strike(autoContract.strike)}
                    {autoContract.optionType === 'call' ? 'C' : 'P'}
                  </span>
                  <span
                    className="text-secondary numeric"
                    style={{ fontSize: 'var(--fs-caption)' }}
                  >
                    ≈ {autoMid !== null ? Format.price(autoMid) : '—'}
                  </span>
                </>
              ) : (
                <span className="text-secondary" style={{ fontSize: 'var(--fs-caption)' }}>
                  No contract
                </span>
              )}
            </div>
          ) : (
            <Menu
              direction="up"
              trigger={
                <button className="chip-button">
                  <ChartLineIcon size={13} />
                  <span className="chip-title">
                    {chain.selectedStrike !== null ? Format.strike(chain.selectedStrike) : 'Strike'}
                  </span>
                </button>
              }
              items={chainStore.strikes.map((strike) => ({
                key: String(strike),
                label: Format.strike(strike),
                checked: strike === chain.selectedStrike,
                onSelect: () => chainStore.selectStrike(strike),
              }))}
            />
          )}
        </div>
      </div>

      {/* Quantity row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="text-secondary" style={{ fontSize: 'var(--fs-subheadline)' }}>
          Qty
        </span>
        <Stepper
          value={trade.quantity}
          min={1}
          max={1000}
          onChange={(value) => tradeStore.setQuantity(value)}
        />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-body)',
            fontWeight: 500,
            minWidth: 40,
            textAlign: 'center',
          }}
        >
          {trade.quantity}
        </span>
        <span style={{ flex: 1 }} />
        <QuickChip title="+5" onClick={() => tradeStore.addQuantity(5)} />
        <QuickChip title="+10" onClick={() => tradeStore.addQuantity(10)} />
      </div>

      {/* Order type row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SegmentedControl
          options={[
            { value: 'mid', label: 'Mid' },
            { value: 'market', label: 'Market' },
          ]}
          value={trade.orderType}
          onChange={(value) => tradeStore.setOrderType(value)}
        />
        <span
          className="text-secondary numeric"
          style={{
            fontSize: 'var(--fs-caption)',
            flex: 'none',
            minWidth: 96,
            textAlign: 'right',
            visibility: selectedQuote ? 'visible' : 'hidden',
          }}
        >
          {selectedQuote
            ? `${Format.price(selectedQuote.bid)} × ${Format.price(selectedQuote.ask)}${
                trade.orderType === 'mid'
                  ? ` · ≈ ${indicativeMid !== null ? Format.price(indicativeMid) : '—'}`
                  : ''
              }`
            : ''}
        </span>
      </div>

      {/* Action row — pinned to the panel's bottom edge */}
      <div style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
        <TradeActionButton
          title="SELL"
          color="var(--sell-red)"
          isEnabled={canTrade}
          onClick={() => onArm('sell')}
        />
        <TradeActionButton
          title="BUY"
          color="var(--buy-green)"
          isEnabled={canTrade}
          onClick={() => onArm('buy')}
        />
      </div>
    </div>
  );
}
