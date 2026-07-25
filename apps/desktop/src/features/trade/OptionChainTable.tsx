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
}

function LegCell({
  contract,
  side,
  selected,
  disabled,
  onSelect,
}: {
  contract: OptionContract | undefined;
  side: OptionType;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  if (!contract) {
    return <div className="chain-cell chain-cell--empty" aria-hidden="true" />;
  }
  return (
    <button
      type="button"
      className={`chain-cell chain-cell--${side}${selected ? ' selected' : ''}`}
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      aria-label={`${side === 'call' ? 'Call' : 'Put'} ${Format.strike(contract.strike)}, bid ${Format.price(contract.bid)}, ask ${Format.price(contract.ask)}`}
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
 *  matters for that read. */
export function OptionChainTable({
  chainStore,
  underlyingLast,
  strikes,
  contractsByStrike,
  selectedStrike,
  optionType,
  locked = false,
}: OptionChainTableProps) {
  if (strikes.length === 0) {
    return (
      <div className="chain-table-empty text-secondary" style={{ fontSize: 'var(--fs-caption)' }}>
        No contracts for this expiration
      </div>
    );
  }

  return (
    <div className="chain-table hide-scrollbar" role="table" aria-label="Option chain">
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
            <div key={strike} role="row" className={`chain-row${isAtm ? ' chain-row--atm' : ''}`}>
              <LegCell
                contract={legs?.call}
                side="call"
                selected={isSelected && optionType === 'call'}
                disabled={locked}
                onSelect={() => {
                  chainStore.setOptionType('call');
                  chainStore.selectStrike(strike);
                }}
              />
              <span className="chain-row-strike numeric" role="cell">
                {Format.strike(strike)}
              </span>
              <LegCell
                contract={legs?.put}
                side="put"
                selected={isSelected && optionType === 'put'}
                disabled={locked}
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
