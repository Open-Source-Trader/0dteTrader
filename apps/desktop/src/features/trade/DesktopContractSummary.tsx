import type { OptionContract, OrderType } from '@0dtetrader/shared-types';
import { ChevronDownIcon } from '../../design/icons';
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
      <div className="summary-header" aria-label={summary.executionLine}>
        <span className="desktop-contract-summary__contract numeric">{summary.contractLine}</span>
        <span className="desktop-contract-summary__price numeric">{summary.executionValue}</span>
      </div>

      <div className="summary-context">
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
      </div>

      <details className="desktop-contract-summary__details">
        <summary className="summary-details-toggle">
          <span>Details</span>
          <ChevronDownIcon size={10} />
        </summary>

        <div className="summary-details-content">
          <div className="summary-details-cell">
            <span className="summary-details-label">Expiry B/E</span>
            <span className="summary-details-value" aria-label={summary.breakEvenLine}>
              {summary.breakEvenValue}
              {summary.breakEvenPercentValue ? ` (${summary.breakEvenPercentValue})` : ''}
            </span>
          </div>
          <div className="summary-details-cell summary-details-cell--end">
            <span className="summary-details-label">Spread</span>
            <span className="summary-details-value" aria-label={summary.spreadLine}>
              {summary.spreadValue}
            </span>
          </div>
          <div className="summary-details-cell">
            <span className="summary-details-label" title="Real value if exercised right now.">
              Intrinsic
            </span>
            <span className="summary-details-value">{summary.intrinsicValue}</span>
          </div>
          <div className="summary-details-cell summary-details-cell--end">
            <span
              className="summary-details-label"
              title="What you're paying for the chance the trade still moves your way — decays to $0 by today's close."
            >
              Extrinsic (time)
            </span>
            <span className="summary-details-value">{summary.extrinsicValue}</span>
          </div>
        </div>
      </details>
    </section>
  );
}
