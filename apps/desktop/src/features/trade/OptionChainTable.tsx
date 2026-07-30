import { useEffect, useRef } from 'react';
import type { OptionContract, OptionType } from '@0dtetrader/shared-types';
import { Format } from '../../design/format';
import type { ChainStore } from './ChainStore';

interface OptionChainTableProps {
  chainStore: ChainStore;
  underlyingLast: number | null;
  strikes: number[];
  contractsByStrike: Map<number, { call?: OptionContract; put?: OptionContract }>;
  selectedStrike: number | null;
  optionType: OptionType;
  locked?: boolean;
  /** AUTO mode: the chain stays visible and readable (never hidden — that
   *  hides exactly the liquidity/spread info a scalper needs) but isn't
   *  manually clickable, since AUTO owns the pick. Distinct from `locked`:
   *  this is "not yours to change right now," not "trading is disabled." */
  autoSelected?: boolean;
}

function LegCell({
  contract,
  side,
  selected,
  disabled,
  autoSelected,
  onSelect,
}: {
  contract: OptionContract | undefined;
  side: OptionType;
  selected: boolean;
  disabled: boolean;
  autoSelected: boolean;
  onSelect: () => void;
}) {
  if (!contract) {
    return <div className="chain-cell chain-cell--empty" aria-hidden="true" />;
  }
  const label = `${side === 'call' ? 'Call' : 'Put'} ${Format.strike(contract.strike)}, bid ${Format.price(contract.bid)}, ask ${Format.price(contract.ask)}`;
  return (
    <button
      type="button"
      className={`chain-cell chain-cell--${side}${selected ? ' selected' : ''}`}
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={autoSelected && selected ? `${label}, AUTO-selected` : label}
    >
      <span className="numeric chain-cell-bid">{Format.price(contract.bid)}</span>
      <span className="numeric chain-cell-ask">{Format.price(contract.ask)}</span>
    </button>
  );
}

/** Desktop-only option chain: calls / strike / puts, one row per strike,
 *  click a bid/ask cell to select that leg. This is the actual chain a
 *  scalper scans for spread/liquidity before picking a strike — a dropdown
 *  chip (the phone ticket's approach) hides exactly the information that
 *  matters for that read. In AUTO mode the chain stays visible (readOnly)
 *  with the auto-picked leg tracked live as `selectedStrike`/`optionType`
 *  move with price, instead of swapping the whole table out for a status box. */
export function OptionChainTable({
  chainStore,
  underlyingLast,
  strikes,
  contractsByStrike,
  selectedStrike,
  optionType,
  locked = false,
  autoSelected = false,
}: OptionChainTableProps) {
  const selectedRowRef = useRef<HTMLDivElement>(null);
  const userInteractingRef = useRef(false);
  const interactionTimerRef = useRef<number | null>(null);

  const markUserInteracting = () => {
    userInteractingRef.current = true;
    if (interactionTimerRef.current !== null) window.clearTimeout(interactionTimerRef.current);
    interactionTimerRef.current = window.setTimeout(() => {
      userInteractingRef.current = false;
      interactionTimerRef.current = null;
    }, 900);
  };

  // Keep the auto-picked (or manually selected) row in view as it moves,
  // but never steal the scroll while the trader is scanning the ladder.
  useEffect(() => {
    if (userInteractingRef.current) return;
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedStrike]);

  useEffect(
    () => () => {
      if (interactionTimerRef.current !== null) window.clearTimeout(interactionTimerRef.current);
    },
    [],
  );

  if (strikes.length === 0) {
    return (
      <div className="chain-table-empty text-secondary" style={{ fontSize: 'var(--fs-caption)' }}>
        No contracts for this expiration
      </div>
    );
  }

  const readOnly = locked || autoSelected;

  return (
    <div
      className={
        autoSelected ? 'chain-table chain-table--auto hide-scrollbar' : 'chain-table hide-scrollbar'
      }
      role="table"
      aria-label={autoSelected ? 'Option chain, AUTO selection active' : 'Option chain'}
      onPointerDown={markUserInteracting}
      onWheel={markUserInteracting}
    >
      <div className="chain-table-header" role="row">
        <span role="columnheader">Call</span>
        <span role="columnheader">Strike</span>
        <span role="columnheader">Put</span>
      </div>
      <div className="chain-table-body hide-scrollbar">
        {strikes.map((strike) => {
          const legs = contractsByStrike.get(strike);
          const isSelected = strike === selectedStrike;
          const isAtm = underlyingLast !== null && Math.abs(strike - underlyingLast) < 0.5;
          return (
            <div
              key={strike}
              ref={isSelected ? selectedRowRef : undefined}
              role="row"
              className={`chain-row${isAtm ? ' chain-row--atm' : ''}`}
            >
              <LegCell
                contract={legs?.call}
                side="call"
                selected={isSelected && optionType === 'call'}
                disabled={readOnly}
                autoSelected={autoSelected}
                onSelect={() => {
                  chainStore.setOptionType('call');
                  chainStore.selectStrike(strike);
                }}
              />
              <span
                className={
                  autoSelected && isSelected
                    ? 'chain-row-strike chain-row-strike--auto numeric'
                    : 'chain-row-strike numeric'
                }
                role="cell"
              >
                {autoSelected && isSelected ? (
                  <span className="chain-row-auto-dot" aria-hidden="true" />
                ) : null}
                {Format.strike(strike)}
              </span>
              <LegCell
                contract={legs?.put}
                side="put"
                selected={isSelected && optionType === 'put'}
                disabled={readOnly}
                autoSelected={autoSelected}
                onSelect={() => {
                  chainStore.setOptionType('put');
                  chainStore.selectStrike(strike);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
