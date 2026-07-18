import { useEffect } from 'react';
import type { OrderSide } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { midPrice } from '../../core/models/domain';
import { dayString } from '../../core/models/dates';
import { Menu } from '../../design/components/Menu';
import { QuickChip } from '../../design/components/QuickChip';
import { SegmentedControl } from '../../design/components/SegmentedControl';
import { Spinner } from '../../design/components/Spinner';
import { TradeActionButton } from '../../design/components/TradeActionButton';
import { Format } from '../../design/format';
import {
  BoxIcon,
  CalendarIcon,
  ChartLineIcon,
  DocIcon,
  MinusIcon,
  PlusIcon,
} from '../../design/icons';
import type { ChainStore } from './ChainStore';
import type { TradeStore } from './TradeStore';
import { PositionsStrip } from './PositionsStrip';
import { KNOWN_FUTURES_ROOTS } from './futuresRoots';

interface TradePanelProps {
  tradeStore: TradeStore;
  chainStore: ChainStore;
  onArm: (side: OrderSide) => void;
}

function expirationLabel(expiration: string): string {
  return expiration === dayString() ? `${expiration} · 0DTE` : expiration;
}

/** Layout B's bottom trade panel (TradePanelView.swift). */
export function TradePanel({ tradeStore, chainStore, onArm }: TradePanelProps) {
  const trade = useStore(tradeStore);
  const chain = useStore(chainStore);

  useEffect(() => {
    // Ensure a contract list exists even when the chart symbol isn't a root.
    if (tradeStore.getState().futuresContracts.length === 0) {
      void tradeStore.loadFuturesContracts();
    }
  }, [tradeStore]);

  const autoContract = chainStore.autoContract;
  const selectedContract = chainStore.selectedContract;
  const selectedFuture = tradeStore.selectedFuture;
  const autoMid = autoContract ? midPrice(autoContract.bid, autoContract.ask) : null;

  const canTrade = trade.assetClass === 'option' ? selectedContract !== null : selectedFuture !== null;

  const selectedQuote = trade.assetClass === 'option' ? selectedContract : selectedFuture;
  const indicativeMid = selectedQuote ? midPrice(selectedQuote.bid, selectedQuote.ask) : null;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '4px 12px 0',
        background: 'var(--app-background)',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      <PositionsStrip
        positions={trade.positions}
        openOrders={trade.openOrders}
        workingSymbols={trade.workingSymbols}
        onFlatten={(position) => void tradeStore.flatten(position)}
        onCancelOrder={(order) => void tradeStore.cancel(order)}
      />

      <SegmentedControl
        options={[
          { value: 'option', label: 'Options' },
          { value: 'future', label: 'Futures' },
        ]}
        value={trade.assetClass}
        onChange={(value) => tradeStore.setAssetClass(value)}
      />

      {trade.assetClass === 'option' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                padding: '8px 12px',
                borderRadius: 999,
                background: chain.isAutoMode ? 'var(--app-accent)' : 'var(--app-surface-elevated)',
                color: chain.isAutoMode ? '#fff' : 'var(--label-primary)',
              }}
              onClick={() => chainStore.setAutoMode(!chain.isAutoMode)}
              aria-label="Auto +1 OTM selection"
            >
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
                  minHeight: 34,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  padding: '0 10px',
                  background: 'var(--app-surface)',
                  borderRadius: 'var(--radius-chip)',
                }}
              >
                {chain.isLoading ? (
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
                    <span className="text-secondary" style={{ fontSize: 'var(--fs-caption)' }}>
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
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Menu
            direction="up"
            trigger={
              <button className="chip-button">
                <BoxIcon size={13} />
                <span className="chip-title">{trade.futuresRoot}</span>
              </button>
            }
            items={KNOWN_FUTURES_ROOTS.map((root) => ({
              key: root,
              label: root,
              checked: root === trade.futuresRoot,
              onSelect: () => void tradeStore.setFuturesRoot(root),
            }))}
          />
          <Menu
            direction="up"
            trigger={
              <button className="chip-button">
                <DocIcon size={13} />
                <span className="chip-title">{trade.selectedFutureSymbol ?? 'Contract'}</span>
              </button>
            }
            items={trade.futuresContracts.map((contract) => ({
              key: contract.symbol,
              label: (
                <>
                  {contract.symbol}
                  {contract.frontMonth ? (
                    <span className="text-secondary" style={{ marginLeft: 6 }}>
                      · front
                    </span>
                  ) : null}
                </>
              ),
              checked: contract.symbol === trade.selectedFutureSymbol,
              onSelect: () => tradeStore.selectFuture(contract.symbol),
            }))}
          />
          {selectedFuture ? (
            <span className="text-secondary" style={{ fontSize: 'var(--fs-caption)', flex: 'none' }}>
              ≈ {indicativeMid !== null ? Format.price(indicativeMid) : '—'}
            </span>
          ) : null}
        </div>
      )}

      {/* Quantity row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="text-secondary" style={{ fontSize: 'var(--fs-subheadline)' }}>
          Qty
        </span>
        <button
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'var(--app-surface-elevated)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => tradeStore.addQuantity(-1)}
          aria-label="Decrease quantity"
        >
          <MinusIcon size={13} />
        </button>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--fs-body)',
            fontWeight: 500,
            minWidth: 36,
            textAlign: 'center',
          }}
        >
          {trade.quantity}
        </span>
        <button
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            background: 'var(--app-surface-elevated)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={() => tradeStore.addQuantity(1)}
          aria-label="Increase quantity"
        >
          <PlusIcon size={13} />
        </button>
        <span style={{ flex: 1 }} />
        <QuickChip title="+1" onClick={() => tradeStore.addQuantity(1)} />
        <QuickChip title="+5" onClick={() => tradeStore.addQuantity(5)} />
        <QuickChip title="+10" onClick={() => tradeStore.addQuantity(10)} />
      </div>

      {/* Order type row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <SegmentedControl
          options={[
            { value: 'mid', label: 'Mid' },
            { value: 'market', label: 'Market' },
          ]}
          value={trade.orderType}
          onChange={(value) => tradeStore.setOrderType(value)}
        />
        {selectedQuote ? (
          <span className="text-secondary" style={{ fontSize: 'var(--fs-caption)', flex: 'none' }}>
            {Format.price(selectedQuote.bid)} × {Format.price(selectedQuote.ask)}
            {trade.orderType === 'mid'
              ? ` · ≈ ${indicativeMid !== null ? Format.price(indicativeMid) : '—'}`
              : ''}
          </span>
        ) : null}
      </div>

      {/* Action row */}
      <div style={{ display: 'flex', gap: 12 }}>
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
