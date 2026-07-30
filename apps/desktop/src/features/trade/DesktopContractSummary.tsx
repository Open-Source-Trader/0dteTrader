import type { OptionContract, OrderType } from '@0dtetrader/shared-types';
import { buildDesktopContractSummary } from './DesktopContractSummaryModel';

export function DesktopContractSummary({
  selectedContract,
  isLoading,
  orderType,
  customLimitPrice,
  quantity,
  underlyingLast,
}: {
  selectedContract: OptionContract | null;
  isLoading: boolean;
  orderType: OrderType;
  customLimitPrice: number | null;
  quantity: number;
  underlyingLast: number | null;
}) {
  const summary = buildDesktopContractSummary(
    selectedContract,
    isLoading,
    orderType,
    customLimitPrice,
    quantity,
    underlyingLast,
  );

  return (
    <section
      className={`desktop-contract-summary desktop-contract-summary--${summary.state}`}
      aria-label={`Selected contract summary: ${summary.contractLine}. ${summary.quoteLine}. ${summary.executionLine}. ${summary.moneynessLine}. ${summary.intrinsicExtrinsicLine}. ${summary.breakEvenLine}. ${summary.spreadValueLine}`}
      data-state={summary.state}
    >
      <div className="desktop-contract-summary__topline" aria-label={summary.executionLine}>
        <span className="desktop-contract-summary__contract numeric">{summary.contractLine}</span>
        <span className="desktop-contract-summary__price numeric">{summary.executionValue}</span>
      </div>

      <table className="desktop-contract-summary__table numeric">
        <thead>
          <tr>
            <th>Spot</th>
            <th>Distance</th>
          </tr>
        </thead>
        <tbody>
          <tr aria-label={summary.moneynessLine}>
            <td>{summary.spotValue}</td>
            <td>{summary.moneynessDistanceValue}</td>
          </tr>
        </tbody>
      </table>

      <table className="desktop-contract-summary__table numeric">
        <thead>
          <tr>
            <th>Expiry B/E</th>
            <th>Spread</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td aria-label={summary.breakEvenLine}>
              {summary.breakEvenValue}
              {summary.breakEvenPercentValue ? ` (${summary.breakEvenPercentValue})` : ''}
            </td>
            <td aria-label={summary.spreadLine}>{summary.spreadValue}</td>
          </tr>
        </tbody>
      </table>

      <table className="desktop-contract-summary__table numeric">
        <thead>
          <tr>
            <th title="Real value if exercised right now.">Intrinsic</th>
            <th title="What you're paying for the chance the trade still moves your way — decays to $0 by today's close.">
              Extrinsic (time)
            </th>
          </tr>
        </thead>
        <tbody>
          <tr aria-label={summary.intrinsicExtrinsicLine}>
            <td>{summary.intrinsicValue}</td>
            <td>{summary.extrinsicValue}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
