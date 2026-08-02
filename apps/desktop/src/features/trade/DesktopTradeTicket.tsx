import { useEffect, useRef, useState } from 'react';
import type { OptionContract, OrderSide, OrderType } from '@0dtetrader/shared-types';
import { useStore } from '../../core/observable';
import { dayString } from '../../core/models/dates';
import { midPrice, quotesPending } from '../../core/models/domain';
import { isPriceInputShape, parsePriceInput } from '../../core/models/priceInput';
import { AnchoredPopup } from '../../design/components/Menu';
import { MinusIcon, PlusIcon } from '../../design/icons';
import { Spinner } from '../../design/components/Spinner';
import { TradeActionButton } from '../../design/components/TradeActionButton';
import { Format } from '../../design/format';
import { CalendarIcon, ChevronDownIcon } from '../../design/icons';
import type { ChainStore } from './ChainStore';
import type { TradeStore } from './TradeStore';
import { DesktopContractSummary } from './DesktopContractSummary';
import { buildDesktopContractSummary } from './DesktopContractSummaryModel';
import { selectedContractPremium } from './expiryBreakEven';
import { OptionChainTable } from './OptionChainTable';

interface DesktopTradeTicketProps {
  tradeStore: TradeStore;
  chainStore: ChainStore;
  onArm: (side: OrderSide) => void;
  locked?: boolean;
}

const PRICE_MODES: Array<{ value: OrderType; label: string }> = [
  { value: 'bid', label: 'Bid' },
  { value: 'mid', label: 'Mid' },
  { value: 'ask', label: 'Ask' },
  { value: 'market', label: 'Market' },
];

/** The live price shown on each price-mode button — Bid/Mid/Ask carry their
 *  quote so it doesn't need repeating anywhere else on the card; Market has
 *  no fixed price to show. */
function priceModeQuote(mode: OrderType, contract: OptionContract | null): string | null {
  if (!contract) return null;
  switch (mode) {
    case 'bid':
      return contract.bid > 0 ? Format.price(contract.bid) : null;
    case 'mid': {
      const mid = midPrice(contract.bid, contract.ask);
      return mid !== null ? Format.price(mid) : null;
    }
    case 'ask':
      return contract.ask > 0 ? Format.price(contract.ask) : null;
    default:
      return null;
  }
}

function expirationLabel(expiration: string): string {
  return expiration === dayString() ? `${expiration} · 0DTE` : expiration;
}

/** Grid-cell label: month/day only, since the year and the row it's already
 *  filed under (this expiration list is never more than a few weeks) add
 *  nothing a trader needs when scanning a compact grid of dates. */
function expiryGridLabel(expiration: string): string {
  const parts = expiration.split('-');
  if (parts.length !== 3) return expiration;
  return `${parts[1]}/${parts[2]}`;
}

function dteLabel(expiration: string | null): string {
  if (!expiration) return 'Expiry';
  return expiration === dayString() ? '0DTE / Expiry' : expiration;
}

/** Desktop-grid execution rail: chain first, then configuration, selected
 *  contract, sizing/pricing, and finally the safety-critical BUY/SELL row. */
export function DesktopTradeTicket({
  tradeStore,
  chainStore,
  onArm,
  locked = false,
}: DesktopTradeTicketProps) {
  const trade = useStore(tradeStore);
  const chain = useStore(chainStore);
  const [customDraft, setCustomDraft] = useState<string | null>(null);
  const customRef = useRef<HTMLInputElement>(null);

  const selectedContract = chainStore.selectedContract;
  const selectedSymbol = selectedContract?.symbol ?? null;
  useEffect(() => {
    tradeStore.clearCustomLimitPrice();
    setCustomDraft(null);
  }, [selectedSymbol, tradeStore]);

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

  const effectiveStrike = chain.isAutoMode
    ? (selectedContract?.strike ?? null)
    : chain.selectedStrike;
  const effectiveOptionType = chain.optionType;
  const customText = customDraft ?? trade.customLimitPrice?.toFixed(2) ?? '';
  const premium = selectedContractPremium({
    contract: selectedContract,
    orderType: trade.orderType,
    customLimitPrice: trade.customLimitPrice,
  });
  const estimatedDebit = premium !== null ? premium * trade.quantity * 100 : null;
  const spreadSummary = buildDesktopContractSummary(
    selectedContract,
    chain.isLoading,
    trade.orderType,
    trade.customLimitPrice,
    trade.quantity,
    chain.underlyingLast,
  );
  // SELL only ever closes: it needs a held long that arm()'s underlying +
  // expiration + right match would find (same predicate, so gate and action
  // cannot disagree — not the exact selected symbol, which AUTO's live pick
  // can drift off of).
  const hasSellableLeg =
    tradeStore.sellableHeldLegs(chain.underlying, chain.selectedExpiration, chain.optionType)
      .length > 0;
  // `premium !== null` alone does not cover the Custom mode: a typed price
  // supplies a premium even when the leg itself has no quotes yet, so the
  // zero-quote CURR gate needs its own term here.
  const canSubmit =
    selectedContract !== null &&
    !locked &&
    !trade.isSubmitting &&
    !trade.armedTicket &&
    tradeStore.canArm &&
    premium !== null &&
    !quotesPending(selectedContract);
  const canBuy = canSubmit;
  const canSell = canSubmit && hasSellableLeg;

  return (
    <div className="trade-panel desktop desktop-ticket-rail">
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

      <div className="desktop-execution-deck">
        <div className="desktop-ticket-config-row" inert={locked}>
          <AnchoredPopup
            className="desktop-expiry-trigger"
            direction="up"
            role="menu"
            trigger={
              <button className="desktop-expiry-button" aria-label="Select expiration">
                <CalendarIcon size={13} />
                <span className="desktop-expiry-label">{dteLabel(chain.selectedExpiration)}</span>
                <ChevronDownIcon size={11} />
              </button>
            }
            panelClassName="desktop-expiry-grid"
          >
            {(close) => (
              <>
                {chainStore.expirations.map((expiration) => {
                  const isToday = expiration === dayString();
                  const isSelected = expiration === chain.selectedExpiration;
                  return (
                    <button
                      key={expiration}
                      type="button"
                      className={`desktop-expiry-cell${isSelected ? ' selected' : ''}`}
                      aria-pressed={isSelected}
                      aria-label={expirationLabel(expiration)}
                      onClick={() => {
                        chainStore.selectExpiration(expiration);
                        close();
                      }}
                    >
                      {isToday ? <span className="desktop-expiry-cell-badge">0DTE</span> : null}
                      <span className="desktop-expiry-cell-date numeric">
                        {expiryGridLabel(expiration)}
                      </span>
                    </button>
                  );
                })}
              </>
            )}
          </AnchoredPopup>
          <button
            type="button"
            className={`desktop-mode-button desktop-mode-button--auto${chain.isAutoMode ? ' selected' : ''}`}
            onClick={() => chainStore.setAutoMode(!chain.isAutoMode)}
            aria-label="Auto OTM selection"
            aria-pressed={chain.isAutoMode}
          >
            Auto
          </button>
          <button
            type="button"
            className={`desktop-mode-button desktop-mode-button--curr${chain.isCurrMode ? ' selected' : ''}`}
            onClick={() => chainStore.setCurrMode(!chain.isCurrMode)}
            disabled={!chain.isCurrMode && !chainStore.hasCurrPositions}
            title={
              !chain.isCurrMode && !chainStore.hasCurrPositions
                ? 'No open long for this underlying'
                : undefined
            }
            aria-label="Current position selection"
            aria-pressed={chain.isCurrMode}
          >
            Curr
          </button>
          <button
            type="button"
            className={`desktop-mode-button desktop-mode-button--call${chain.optionType === 'call' ? ' selected' : ''}`}
            aria-pressed={chain.optionType === 'call'}
            aria-label="Select call contract"
            onClick={() => chainStore.setOptionType('call')}
          >
            Call
          </button>
          <button
            type="button"
            className={`desktop-mode-button desktop-mode-button--put${chain.optionType === 'put' ? ' selected' : ''}`}
            aria-pressed={chain.optionType === 'put'}
            aria-label="Select put contract"
            onClick={() => chainStore.setOptionType('put')}
          >
            Put
          </button>
          {chain.isLoading ? <Spinner size={13} /> : null}
          {chain.errorMessage ? (
            <button
              className="desktop-ticket-config-error"
              onClick={() => void chainStore.load(chain.underlying)}
              aria-label={`Chain failed to load: ${chain.errorMessage}. Activate to retry`}
            >
              Retry chain
            </button>
          ) : null}
        </div>

        <DesktopContractSummary
          selectedContract={selectedContract}
          isLoading={chain.isLoading}
          orderType={trade.orderType}
          customLimitPrice={trade.customLimitPrice}
          quantity={trade.quantity}
          underlyingLast={chain.underlyingLast}
        />

        <div className="desktop-ticket-execution" inert={locked}>
          <div className="desktop-ticket-qty-section">
            <span className="desktop-ticket-qty-label">Quantity</span>
            <div className="desktop-ticket-qty-row" role="group" aria-label="Order quantity">
              <div className="desktop-qty-stepper">
                <button
                  type="button"
                  className="desktop-qty-step"
                  disabled={trade.quantity <= 1}
                  onClick={() => tradeStore.setQuantity(Math.max(1, trade.quantity - 1))}
                  aria-label="Decrement quantity"
                >
                  <MinusIcon size={13} />
                </button>
                <span className="numeric desktop-ticket-qty-value">{trade.quantity}</span>
                <button
                  type="button"
                  className="desktop-qty-step"
                  disabled={trade.quantity >= 1000}
                  onClick={() => tradeStore.setQuantity(Math.min(1000, trade.quantity + 1))}
                  aria-label="Increment quantity"
                >
                  <PlusIcon size={13} />
                </button>
              </div>
              <div className="desktop-qty-presets" role="group" aria-label="Quantity shortcuts">
                <button
                  type="button"
                  className="desktop-qty-preset"
                  aria-label="Add 5 contracts"
                  title="Add 5 contracts"
                  onClick={() => tradeStore.addQuantity(5)}
                >
                  +5
                </button>
                <button
                  type="button"
                  className="desktop-qty-preset"
                  aria-label="Add 10 contracts"
                  title="Add 10 contracts"
                  onClick={() => tradeStore.addQuantity(10)}
                >
                  +10
                </button>
              </div>
            </div>
          </div>

          <div className="desktop-ticket-price-row" role="group" aria-label="Execution price mode">
            <div
              className={`desktop-ticket-price-mode desktop-ticket-price-mode--custom${trade.orderType === 'custom' ? ' selected' : ''}`}
              onClick={() => {
                tradeStore.setOrderType('custom');
                customRef.current?.focus();
              }}
            >
              <input
                ref={customRef}
                className="desktop-ticket-price-mode-input numeric"
                value={customText}
                inputMode="decimal"
                placeholder="0.00"
                aria-label="Custom limit price"
                onFocus={() => tradeStore.setOrderType('custom')}
                onChange={(event) => {
                  const text = event.target.value;
                  if (!isPriceInputShape(text)) return;
                  setCustomDraft(text);
                  tradeStore.setCustomLimitPrice(parsePriceInput(text));
                }}
                onBlur={() => setCustomDraft(null)}
              />
              <span className="desktop-ticket-price-mode-label">Custom</span>
            </div>
            {PRICE_MODES.map((mode) => {
              const quote =
                mode.value === 'market'
                  ? 'Market'
                  : // `~${priceModeQuote('ask', selectedContract)}` :
                    priceModeQuote(mode.value, selectedContract);

              return (
                <button
                  key={mode.value}
                  type="button"
                  className={`desktop-ticket-price-mode${trade.orderType === mode.value ? ' selected' : ''}`}
                  aria-pressed={trade.orderType === mode.value}
                  onClick={() => tradeStore.setOrderType(mode.value)}
                >
                  <span className="desktop-ticket-price-mode-value numeric">{quote ?? '—'}</span>
                  <span className="desktop-ticket-price-mode-label">
                    {mode.value === 'market' ? '' : mode.label}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="desktop-ticket-risk numeric" role="status">
            <div className="desktop-ticket-risk-item">
              <span className="desktop-ticket-risk-label">Max loss</span>
              <span className="desktop-ticket-risk-value">
                {estimatedDebit !== null ? `$${Format.price(estimatedDebit)}` : '—'}
              </span>
            </div>
            <div className="desktop-ticket-risk-divider" aria-hidden="true" />
            <div className="desktop-ticket-risk-item desktop-ticket-risk-item--end">
              <span className="desktop-ticket-risk-label">Spread</span>
              <span className="desktop-ticket-risk-value">
                {selectedContract ? spreadSummary.spreadValue : '—'}
              </span>
            </div>
            {trade.isSubmitting ? (
              <span className="desktop-ticket-risk-status">Submitting…</span>
            ) : null}
          </div>
        </div>

        <div className="desktop-ticket-action-row">
          <TradeActionButton
            title={trade.isSubmitting ? 'Working…' : 'SELL TO CLOSE'}
            color="var(--sell-red)"
            isEnabled={canSell}
            secondary={!hasSellableLeg}
            onClick={() => onArm('sell')}
          />
          <TradeActionButton
            title={trade.isSubmitting ? 'Working…' : 'BUY TO OPEN'}
            color="var(--buy-green)"
            isEnabled={canBuy}
            onClick={() => onArm('buy')}
          />
        </div>
      </div>
    </div>
  );
}
