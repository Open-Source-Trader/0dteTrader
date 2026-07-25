import type { OptionContract, OrderSide } from '@0dtetrader/shared-types';
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
import { CalendarIcon } from '../../design/icons';
import type { ChainStore } from './ChainStore';
import type { TradeStore } from './TradeStore';
import { OptionChainTable } from './OptionChainTable';

interface DesktopTradeTicketProps {
  tradeStore: TradeStore;
  chainStore: ChainStore;
  onArm: (side: OrderSide) => void;
  locked?: boolean;
}

function expirationLabel(expiration: string): string {
  return expiration === dayString() ? `${expiration} · 0DTE` : expiration;
}

/** Desktop-grid order ticket: the option chain itself is the strike picker
 *  (see OptionChainTable) instead of the phone ticket's single-strike
 *  dropdown chip — a scalper scans the ladder, not a menu. Expiration,
 *  quantity, order type, and Buy/Sell stay the same controls as the phone
 *  ticket, just laid out for a tall narrow rail instead of a short strip. */
export function DesktopTradeTicket({
  tradeStore,
  chainStore,
  onArm,
  locked = false,
}: DesktopTradeTicketProps) {
  const trade = useStore(tradeStore);
  const chain = useStore(chainStore);

  const selectedContract = chainStore.selectedContract;
  const canTrade = selectedContract !== null && !locked;
  const indicativeMid = selectedContract
    ? midPrice(selectedContract.bid, selectedContract.ask)
    : null;

  let orderTypeQuoteLabel = '';
  if (selectedContract) {
    orderTypeQuoteLabel =
      trade.orderType === 'mid'
        ? `≈ ${indicativeMid !== null ? Format.price(indicativeMid) : '—'}`
        : `${Format.price(selectedContract.bid)} × ${Format.price(selectedContract.ask)}`;
  }

  const contractsByStrike = new Map<number, { call?: OptionContract; put?: OptionContract }>();
  if (chain.chain && chain.selectedExpiration) {
    for (const contract of chain.chain.contracts) {
      if (contract.expiration !== chain.selectedExpiration) continue;
      const entry = contractsByStrike.get(contract.strike) ?? {};
      if (contract.optionType === 'call') entry.call = contract;
      else entry.put = contract;
      contractsByStrike.set(contract.strike, entry);
    }
  }

  // AUTO mode: the chain stays visible (see OptionChainTable's autoSelected
  // prop) instead of being swapped out for a status box — hiding it hid
  // exactly the spread/liquidity info a scalper needs. The auto-picked
  // strike/type drive the table's highlighted row and move live with price.
  const effectiveStrike = chain.isAutoMode
    ? (selectedContract?.strike ?? null)
    : chain.selectedStrike;
  const effectiveOptionType = chain.isAutoMode
    ? (selectedContract?.optionType ?? chain.optionType)
    : chain.optionType;

  let autoModeStatus: React.ReactNode = null;
  if (chain.isAutoMode) {
    if (chain.errorMessage) {
      autoModeStatus = (
        <button
          className="text-secondary"
          style={{
            fontSize: 'var(--fs-caption-desktop)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
          onClick={() => void chainStore.load(chain.underlying)}
          aria-label={`Chain failed to load: ${chain.errorMessage}. Activate to retry`}
        >
          <span style={{ color: 'var(--pnl-negative)' }}>
            Chain unavailable — <u>Retry</u>
          </span>
        </button>
      );
    } else if (chain.isLoading) {
      autoModeStatus = <Spinner size={14} />;
    } else if (selectedContract) {
      autoModeStatus = (
        <>
          <span className="numeric" style={{ fontWeight: 700 }}>
            {Format.strike(selectedContract.strike)}
            {selectedContract.optionType === 'call' ? 'C' : 'P'}
          </span>
          <span className="text-secondary numeric">
            ≈ {indicativeMid !== null ? Format.price(indicativeMid) : '—'}
          </span>
        </>
      );
    } else {
      autoModeStatus = <span className="text-secondary">No contract</span>;
    }
  }

  return (
    <div
      className="trade-panel desktop"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '6px 8px 8px',
        background: 'var(--app-background)',
        height: '100%',
        minHeight: 0,
      }}
    >
      {/* Expiration + AUTO toggle */}
      <div
        inert={locked}
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flex: 'none',
          opacity: locked ? 0.55 : 1,
        }}
      >
        <Menu
          className="chip-flex"
          direction="down"
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
        <button
          className={chain.isAutoMode ? 'hud-toggle-chip on' : 'hud-toggle-chip'}
          onClick={() => chainStore.setAutoMode(!chain.isAutoMode)}
          aria-label="Auto +1 OTM selection"
          aria-pressed={chain.isAutoMode}
        >
          AUTO
        </button>
        <span style={{ flex: 1 }} />
        <SegmentedControl
          options={[
            { value: 'call', label: 'Call' },
            { value: 'put', label: 'Put' },
          ]}
          value={chain.optionType}
          onChange={(value) => chainStore.setOptionType(value)}
        />
      </div>

      {/* AUTO status strip: slim, not a chain replacement — the chain below
          stays visible and readable so spread/liquidity info is never hidden. */}
      {chain.isAutoMode ? (
        <div
          style={{
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            padding: '3px 6px',
            background: 'var(--app-surface)',
            border: chain.errorMessage
              ? '1px solid var(--sell-red)'
              : '1px solid var(--hud-stroke-dim)',
            fontSize: 'var(--fs-caption-desktop)',
          }}
        >
          {autoModeStatus}
        </div>
      ) : null}

      {/* The chain: click a bid/ask cell to select that leg. In AUTO mode
          it's read-only and the auto-picked leg is highlighted — see
          OptionChainTable's autoSelected prop. */}
      <OptionChainTable
        chainStore={chainStore}
        underlyingLast={chain.underlyingLast}
        strikes={chainStore.strikes}
        contractsByStrike={contractsByStrike}
        selectedStrike={effectiveStrike}
        optionType={effectiveOptionType}
        locked={locked}
        autoSelected={chain.isAutoMode}
      />

      {/* Order-entry controls: quantity through Buy/Sell. Deliberately
          roomier than the chain/read-only rows above — a mis-click here
          places or mis-sizes a real order, so this section trades density
          for a safer, more deliberate hit target. */}
      <div
        inert={locked}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          flex: 'none',
          padding: '8px 2px 2px',
          opacity: locked ? 0.55 : 1,
        }}
      >
        {/* Quantity row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="text-secondary" style={{ fontSize: 'var(--fs-caption-desktop)' }}>
            Qty
          </span>
          <Stepper
            value={trade.quantity}
            min={1}
            max={1000}
            onChange={(value) => tradeStore.setQuantity(value)}
          />
          <span
            className="numeric"
            style={{
              fontSize: 'var(--fs-subheadline-desktop)',
              fontWeight: 500,
              minWidth: 32,
              textAlign: 'center',
              textShadow: '0 0 8px var(--hud-glow)',
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
              fontSize: 'var(--fs-caption-desktop)',
              flex: 'none',
              minWidth: 96,
              textAlign: 'right',
              visibility: selectedContract ? 'visible' : 'hidden',
            }}
          >
            {orderTypeQuoteLabel}
          </span>
        </div>

        {/* Action row */}
        <div style={{ display: 'flex', gap: 10 }}>
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
    </div>
  );
}
