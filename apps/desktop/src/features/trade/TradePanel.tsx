import { useEffect, useRef, useState } from 'react';
import type { OrderSide } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { midPrice } from '../../core/models/domain';
import { dayString } from '../../core/models/dates';
import { isPriceInputShape, parsePriceInput } from '../../core/models/priceInput';
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
  LockIcon,
  LockOpenIcon,
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
  /** Trading lock: disables Buy/Sell, the order-config controls, and the
   *  positions strip's flatten/cancel. */
  locked?: boolean;
  /** Flips the lock. The panel only asks; the screen owns and persists it. */
  onToggleLock?: () => void;
}

/**
 * `firstGap` is the space above the panel's first control row, and it is
 * deliberately not `gap`. Together with the top half of `padding` it is the
 * whole distance from the chart card's bottom border to the lock chip — a seam
 * between two surfaces, which was reading as a gulf — while `gap` also sets
 * every space *between* the panel's own rows and the pad above SELL/BUY, none
 * of which the chart is anywhere near. Both terms are halved; the bottom pad is
 * untouched, since it separates the buttons from the home indicator.
 */
const DENSITY = {
  roomy: { gap: 8, firstGap: 4, padding: '4px 16px 12px', stripMaxHeight: 140 },
  compact: { gap: 6, firstGap: 3, padding: '3px 16px 8px', stripMaxHeight: 100 },
  dense: { gap: 4, firstGap: 2, padding: '2px 16px 4px', stripMaxHeight: 64 },
} as const;

function expirationLabel(expiration: string): string {
  return expiration === dayString() ? `${expiration} · 0DTE` : expiration;
}

/**
 * One column of the order-type row's readout: the price over its name. Both
 * grey — the panel's chrome text is one colour now — so the hierarchy is
 * carried by type size and position rather than by brightness. An em dash
 * rather than a blank while the chain is loading or nothing is selected: the
 * row keeps its three columns and its height either way.
 */
function QuoteColumn({
  label,
  value,
  selected,
  onSelect,
}: {
  label: string;
  value: string | null;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`quote-column segment${selected ? ' selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="quote-column__value numeric">{value || '—'}</span>
      <span className="quote-column__label">{label}</span>
    </button>
  );
}

/** Layout B's bottom trade panel (TradePanelView.swift). */
export function TradePanel({
  tradeStore,
  chainStore,
  onArm,
  density = 'roomy',
  locked = false,
  onToggleLock,
}: TradePanelProps) {
  const trade = useStore(tradeStore);
  const chain = useStore(chainStore);

  const autoContract = chainStore.autoContract;
  const selectedContract = chainStore.selectedContract;
  const autoMid = autoContract ? midPrice(autoContract.bid, autoContract.ask) : null;

  /** Raw keystrokes while the custom field is being typed in; null shows the
   *  settled price. See `priceInput.ts` — a field that re-renders the canonical
   *  string mid-word turns `2.45` into `245`. */
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  const customRef = useRef<HTMLInputElement>(null);
  const customText = customDraft ?? trade.customLimitPrice?.toFixed(2) ?? '';

  // A typed price belongs to the contract it was typed against, so the store
  // drops it (and the Custom selection with it) when the contract changes
  // underneath. Keyed on the symbol, which covers a strike change, an
  // expiration change and AUTO repicking alike.
  const selectedSymbol = selectedContract?.symbol ?? null;
  useEffect(() => {
    tradeStore.clearCustomLimitPrice();
    setCustomDraft(null);
  }, [selectedSymbol, tradeStore]);

  // Custom with nothing typed in it cannot be armed — there is no price to
  // send, and the server would reject the request anyway.
  const canTrade = selectedContract !== null && !locked && tradeStore.canArm;

  const selectedQuote = selectedContract;
  const indicativeMid = selectedQuote ? midPrice(selectedQuote.bid, selectedQuote.ask) : null;

  const d = DENSITY[density];

  // The mid printed beside the strike, in either mode: `selectedContract`
  // already resolves to AUTO's pick when AUTO is on.
  const strikeMid = indicativeMid !== null ? `≈ ${Format.price(indicativeMid)}` : null;

  // AUTO's pick, wearing the strike chip it stands in for — same class, so the
  // two halves of the contract row are the same height whichever mode is on.
  // They used to be a `.chip-button` against a hand-rolled `minHeight: 36` div,
  // which is what made the row change height with the toggle.
  let autoModeContent;
  if (chain.errorMessage) {
    autoModeContent = (
      <button
        className="chip-button"
        onClick={() => void chainStore.load(chain.underlying)}
        aria-label={`Chain failed to load: ${chain.errorMessage}. Activate to retry`}
      >
        <span style={{ color: 'var(--pnl-negative)' }}>
          Chain unavailable — <u>Retry</u>
        </span>
      </button>
    );
  } else if (chain.isLoading) {
    autoModeContent = (
      <div className="chip-button chip-button--static">
        <Spinner size={14} />
      </div>
    );
  } else if (autoContract) {
    autoModeContent = (
      <div className="chip-button chip-button--static" aria-label="Auto-selected contract">
        <ChartLineIcon size={13} />
        <span className="chip-title">
          {Format.strike(autoContract.strike)}
          {autoContract.optionType === 'call' ? 'C' : 'P'}
        </span>
        <span className="chip-detail numeric">
          {autoMid !== null ? `≈ ${Format.price(autoMid)}` : '—'}
        </span>
      </div>
    );
  } else {
    autoModeContent = (
      <div className="chip-button chip-button--static chip-button--placeholder">
        <ChartLineIcon size={13} />
        <span className="chip-title">No contract</span>
      </div>
    );
  }

  return (
    <div
      className={`trade-panel ${density}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
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
        locked={locked}
      />

      {/* Everything below the strip in one stack, so the gap above the first
          control can differ from the gaps between the rows under it. With no
          open positions the strip is zero-height, which makes that first gap
          the last leg of the run down from the chart card's bottom border. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: d.gap,
          marginTop: d.firstGap,
          flex: 1,
          minHeight: 0,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* The lock leads the row, ahead of the controls it disables, and stays
            outside the inert wrapper: a control that disables itself cannot be
            used to undo the lock. */}
          <button
            className={
              locked
                ? 'hud-toggle-chip hud-toggle-chip--lock on'
                : 'hud-toggle-chip hud-toggle-chip--lock'
            }
            onClick={onToggleLock}
            aria-label={locked ? 'Unlock trading' : 'Lock trading'}
            aria-pressed={locked}
          >
            {/* Icon only: an open or closed padlock is not ambiguous, and the
              aria-label above carries the meaning for anyone it is. */}
            {locked ? <LockIcon size={13} /> : <LockOpenIcon size={13} />}
          </button>
          <div
            inert={locked}
            style={{ display: 'flex', gap: 8, alignItems: 'center', opacity: locked ? 0.55 : 1 }}
          >
            <SegmentedControl
              options={[
                { value: 'call', label: 'Call' },
                { value: 'put', label: 'Put' },
              ]}
              value={chain.optionType}
              onChange={(value) => chainStore.setOptionType(value)}
            />
            <button
              className={chain.isAutoMode ? 'hud-toggle-chip on' : 'hud-toggle-chip'}
              onClick={() => chainStore.setAutoMode(!chain.isAutoMode)}
              aria-label="Auto +1 OTM selection"
              aria-pressed={chain.isAutoMode}
            >
              {chain.isAutoMode ? <CheckmarkIcon size={11} /> : null}
              AUTO
            </button>
          </div>
        </div>

        <div
          inert={locked}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: d.gap,
            opacity: locked ? 0.55 : 1,
          }}
        >
          <div style={{ display: 'flex', gap: 8 }}>
            <Menu
              className="chip-flex"
              direction="up"
              edge="leading"
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
              <div className="chip-flex chip-static">{autoModeContent}</div>
            ) : (
              <Menu
                className="chip-flex"
                direction="up"
                edge="trailing"
                trigger={
                  <button className="chip-button">
                    <ChartLineIcon size={13} />
                    <span className="chip-title">
                      {chain.selectedStrike !== null
                        ? Format.strike(chain.selectedStrike)
                        : 'Strike'}
                    </span>
                    {strikeMid ? <span className="chip-detail numeric">{strikeMid}</span> : null}
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
        <div
          inert={locked}
          style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: locked ? 0.55 : 1 }}
        >
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
              color: 'var(--label-secondary)',
              textShadow: '0 0 8px var(--hud-glow)',
            }}
          >
            {trade.quantity}
          </span>
          <span style={{ flex: 1 }} />
          <QuickChip title="+5" onClick={() => tradeStore.addQuantity(5)} />
          <QuickChip title="+10" onClick={() => tradeStore.addQuantity(10)} />
        </div>

        {/* Pricing row: five ways to price the order, one highlight. Custom
            hard left where the Mid button used to be, Market hard right, and
            the three readouts between them are selectable now rather than
            passive — each still shows its live price over its grey caption.

            One track, not five chips: these are one either/or, and five
            separately-bordered controls across a row would read as five
            independent toggles. The segments are laid out directly rather than
            through `SegmentedControl` because one of them is a text field, but
            they wear that component's own `.segmented` / `.segment` chrome, so
            the highlight cannot drift from the rest of the panel's. */}
        <div
          inert={locked}
          style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: locked ? 0.55 : 1 }}
        >
          <div className="segmented segmented--split" role="group" aria-label="Order pricing">
            {/* Selecting Custom and typing in it are the same gesture: a click
                anywhere on the segment focuses the field. */}
            <div
              className={`segment segment--field${trade.orderType === 'custom' ? ' selected' : ''}`}
              onClick={() => {
                tradeStore.setOrderType('custom');
                customRef.current?.focus();
              }}
            >
              <input
                ref={customRef}
                // Text rather than `number`: a number input reports the
                // part-typed states as `''`, which wipes what is being typed.
                type="text"
                inputMode="decimal"
                className="segment__input numeric"
                aria-label="Custom limit price"
                aria-invalid={trade.orderType === 'custom' && trade.customLimitPrice === null}
                placeholder="0.00"
                value={customText}
                onFocus={() => tradeStore.setOrderType('custom')}
                onChange={(event) => {
                  const raw = event.target.value;
                  if (!isPriceInputShape(raw)) return;
                  setCustomDraft(raw);
                  tradeStore.setCustomLimitPrice(parsePriceInput(raw));
                }}
                // Typing is over, so the field can stop showing the keystrokes
                // and show the price they added up to.
                onBlur={() => setCustomDraft(null)}
              />
              <span className="quote-column__label">Custom</span>
            </div>
            <QuoteColumn
              label="Bid"
              value={selectedQuote ? Format.price(selectedQuote.bid) : null}
              selected={trade.orderType === 'bid'}
              onSelect={() => tradeStore.setOrderType('bid')}
            />
            <QuoteColumn
              label="Mid"
              value={indicativeMid !== null ? Format.price(indicativeMid) : null}
              selected={trade.orderType === 'mid'}
              onSelect={() => tradeStore.setOrderType('mid')}
            />
            <QuoteColumn
              label="Ask"
              value={selectedQuote ? Format.price(selectedQuote.ask) : null}
              selected={trade.orderType === 'ask'}
              onSelect={() => tradeStore.setOrderType('ask')}
            />
            <button
              type="button"
              className={`segment${trade.orderType === 'market' ? ' selected' : ''}`}
              aria-pressed={trade.orderType === 'market'}
              onClick={() => tradeStore.setOrderType('market')}
            >
              Market
            </button>
          </div>
        </div>

        {/* Action row — pinned to the panel's bottom edge */}
        {/* `data-trade-actions`: the box the order confirmation opens out of. */}
        <div data-trade-actions style={{ display: 'flex', gap: 8, marginTop: 'auto' }}>
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
