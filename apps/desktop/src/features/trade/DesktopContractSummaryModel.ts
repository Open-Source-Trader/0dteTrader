import type { OptionContract, OrderType } from '@0dtetrader/shared-types';
import { midPrice, optionTypeShortName } from '../../core/models/domain';
import { dayString } from '../../core/models/dates';
import { Format } from '../../design/format';
import { selectSelectedContractExpiryBreakEven, selectedContractPremium } from './expiryBreakEven';

export type ContractQuoteState = 'none' | 'loading' | 'quoted' | 'unavailable';

type QuoteFieldKey = 'bid' | 'mid' | 'ask';

export interface ContractSummaryModel {
  state: ContractQuoteState;
  contractLine: string;
  quoteLine: string;
  spreadLine: string;
  spreadValueLine: string;
  breakEvenLine: string;
  moneynessLine: string;
  intrinsicExtrinsicLine: string;
  executionLine: string;
  estimatedDebitLine: string;
  maxLossLine: string;
  sideLabel: string;
  side: OptionContract['optionType'] | null;
  quoteFields: Array<{ key: QuoteFieldKey; label: string; value: string }>;
  /** Structured fields for the rendered card — the *Line strings above stay
   *  as flat sentences for aria-labels/tests, but a labeled grid needs the
   *  label and value split apart rather than parsed back out of a string. */
  executionLabel: string;
  executionValue: string;
  moneynessValue: string;
  /** Spot price alone, and the OTM/ITM/ATM distance alone — split so the
   *  card can lay them out as two table columns instead of one middot-joined
   *  string sharing a single cell's width. */
  spotValue: string;
  moneynessDistanceValue: string;
  intrinsicValue: string;
  extrinsicValue: string;
  breakEvenValue: string;
  breakEvenPercentValue: string | null;
  spreadValue: string;
}

const EMPTY_QUOTE_FIELDS: ContractSummaryModel['quoteFields'] = [
  { key: 'bid', label: 'B', value: '—' },
  { key: 'mid', label: 'M', value: '—' },
  { key: 'ask', label: 'A', value: '—' },
];

function moneyOrDash(value: number | null): string {
  return value !== null && Number.isFinite(value) && value > 0 ? `$${Format.price(value)}` : '—';
}

function priceOrDash(value: number | null): string {
  return value !== null && Number.isFinite(value) && value > 0 ? Format.price(value) : '—';
}

function contractLabel(contract: OptionContract): string {
  return `${contract.underlying} ${Format.strike(contract.strike)}${optionTypeShortName(contract.optionType)}`;
}

function emptySummary({
  state,
  contractLine,
  quoteLine,
  side = null,
}: {
  state: ContractQuoteState;
  contractLine: string;
  quoteLine: string;
  side?: OptionContract['optionType'] | null;
}): ContractSummaryModel {
  let sideLabel = 'No side';
  if (side === 'call') sideLabel = 'CALL';
  if (side === 'put') sideLabel = 'PUT';

  return {
    state,
    contractLine,
    quoteLine,
    spreadLine: 'Spread —',
    spreadValueLine: 'Spread —',
    breakEvenLine: 'Expiry B/E —',
    moneynessLine: 'Spot —',
    intrinsicExtrinsicLine: 'Intrinsic — · Extrinsic —',
    executionLine: 'Execution —',
    estimatedDebitLine: 'Debit —',
    maxLossLine: 'Max loss —',
    sideLabel,
    side,
    quoteFields: EMPTY_QUOTE_FIELDS,
    executionLabel: '—',
    executionValue: '—',
    moneynessValue: '—',
    spotValue: '—',
    moneynessDistanceValue: '—',
    intrinsicValue: '—',
    extrinsicValue: '—',
    breakEvenValue: '—',
    breakEvenPercentValue: null,
    spreadValue: '—',
  };
}

function executionParts({
  contract,
  orderType,
  customLimitPrice,
}: {
  contract: OptionContract | null;
  orderType: OrderType;
  customLimitPrice: number | null;
}): { label: string; value: string } {
  if (!contract) return { label: '—', value: '—' };
  const mid = midPrice(contract.bid, contract.ask);
  switch (orderType) {
    case 'bid':
      return { label: 'Bid', value: moneyOrDash(contract.bid) };
    case 'mid':
      return { label: 'Mid', value: moneyOrDash(mid) };
    case 'ask':
      return { label: 'Ask', value: moneyOrDash(contract.ask) };
    case 'custom':
      return {
        label: 'Custom',
        value:
          customLimitPrice !== null && customLimitPrice > 0
            ? `$${Format.price(customLimitPrice)}`
            : '—',
      };
    case 'market':
      if (contract.ask > 0)
        return { label: 'Market est.', value: `Mkt $${Format.price(contract.ask)}` };
      if (mid !== null) return { label: 'Market est.', value: `$${Format.price(mid)}` };
      return { label: 'Market est.', value: '—' };
  }
}

export function selectExecutionSummary(args: {
  contract: OptionContract | null;
  orderType: OrderType;
  customLimitPrice: number | null;
}): string {
  const { label, value } = executionParts(args);
  return `Execution · ${label} ${value}`;
}

/** How far spot sits from the strike, and which side of it — the number a
 *  0DTE scalper reads to judge how much move an entry still needs. Spot and
 *  the OTM/ITM/ATM distance are returned separately so the card can render
 *  them as two table columns rather than one joined string. */
function moneynessParts(
  contract: OptionContract,
  underlyingLast: number | null,
): {
  line: string;
  value: string;
  spotValue: string;
  distanceValue: string;
  intrinsicPerShare: number | null;
} {
  if (underlyingLast === null || !Number.isFinite(underlyingLast)) {
    return {
      line: 'Spot —',
      value: '—',
      spotValue: '—',
      distanceValue: '—',
      intrinsicPerShare: null,
    };
  }
  const distance =
    contract.optionType === 'call'
      ? contract.strike - underlyingLast
      : underlyingLast - contract.strike;
  const percent = underlyingLast !== 0 ? (Math.abs(distance) / underlyingLast) * 100 : 0;
  const intrinsicPerShare = Math.max(0, -distance);
  let state: 'OTM' | 'ITM' | 'ATM' = 'ATM';
  if (distance > 0) state = 'OTM';
  else if (distance < 0) state = 'ITM';
  const spot = Format.price(underlyingLast);
  if (state === 'ATM') {
    return {
      line: `Spot ${spot} · ATM`,
      value: `${spot} · ATM`,
      spotValue: spot,
      distanceValue: 'ATM',
      intrinsicPerShare,
    };
  }
  const detail = `${Format.price(Math.abs(distance))} ${state} (${Format.price(percent, 2)}%)`;
  return {
    line: `Spot ${spot} · ${detail}`,
    value: `${spot} · ${detail}`,
    spotValue: spot,
    distanceValue: detail,
    intrinsicPerShare,
  };
}

export function buildDesktopContractSummary(
  contract: OptionContract | null,
  isLoading: boolean,
  orderType: OrderType = 'mid',
  customLimitPrice: number | null = null,
  quantity = 1,
  underlyingLast: number | null = null,
): ContractSummaryModel {
  if (!contract) {
    return emptySummary({
      state: isLoading ? 'loading' : 'none',
      contractLine: isLoading ? 'Loading option chain…' : 'No contract selected',
      quoteLine: isLoading ? 'Refreshing quotes' : 'Select a call or put row',
    });
  }

  const expiration = contract.expiration === dayString() ? '0DTE' : contract.expiration;
  const contractLine = `${contractLabel(contract)} · ${expiration}`;

  if (isLoading) {
    return emptySummary({
      state: 'loading',
      contractLine,
      quoteLine: 'Refreshing quotes',
      side: contract.optionType,
    });
  }

  const mid = midPrice(contract.bid, contract.ask);
  const spread = contract.ask - contract.bid;
  const spreadPercent = mid && spread >= 0 ? (spread / mid) * 100 : null;
  const hasQuote = contract.bid > 0 && contract.ask > 0 && mid !== null && spread >= 0;
  const quoteFields: ContractSummaryModel['quoteFields'] = [
    { key: 'bid', label: 'B', value: priceOrDash(contract.bid) },
    { key: 'mid', label: 'M', value: priceOrDash(mid) },
    { key: 'ask', label: 'A', value: priceOrDash(contract.ask) },
  ];
  const quoteLine = hasQuote
    ? `Quote B ${priceOrDash(contract.bid)} · M ${priceOrDash(mid)} · A ${priceOrDash(contract.ask)}`
    : 'Quote unavailable';
  const spreadValueLine = hasQuote
    ? `Spread · $${Format.price(spread)} / ${Format.price(spreadPercent ?? 0, 1)}%`
    : 'Spread —';
  const breakEven = selectSelectedContractExpiryBreakEven({
    contract,
    orderType,
    customLimitPrice,
  });
  const breakEvenPercent =
    breakEven !== null && underlyingLast
      ? ((breakEven - underlyingLast) / underlyingLast) * 100
      : null;
  const breakEvenLine =
    breakEven !== null
      ? `Expiry B/E $${Format.price(breakEven)}${breakEvenPercent !== null ? ` (${Format.signedPrice(breakEvenPercent, 2)}%)` : ''}`
      : 'Expiry B/E —';
  const premium = selectedContractPremium({ contract, orderType, customLimitPrice });
  const estimatedDebit = premium !== null ? premium * Math.max(1, quantity) * 100 : null;
  const {
    line: moneynessLineText,
    value: moneynessValue,
    spotValue,
    distanceValue: moneynessDistanceValue,
    intrinsicPerShare,
  } = moneynessParts(contract, underlyingLast);
  const extrinsicPerShare =
    intrinsicPerShare !== null && mid !== null ? Math.max(0, mid - intrinsicPerShare) : null;
  const intrinsicExtrinsicLine =
    intrinsicPerShare !== null && extrinsicPerShare !== null
      ? `Intrinsic $${Format.price(intrinsicPerShare)} · Extrinsic $${Format.price(extrinsicPerShare)}`
      : 'Intrinsic — · Extrinsic —';
  const execution = executionParts({ contract, orderType, customLimitPrice });

  return {
    state: hasQuote ? 'quoted' : 'unavailable',
    contractLine,
    quoteLine,
    spreadLine: spreadValueLine,
    spreadValueLine,
    breakEvenLine,
    moneynessLine: moneynessLineText,
    intrinsicExtrinsicLine,
    executionLine: `Execution · ${execution.label} ${execution.value}`,
    executionLabel: execution.label,
    executionValue: execution.value,
    moneynessValue,
    spotValue,
    moneynessDistanceValue,
    intrinsicValue: intrinsicPerShare !== null ? `$${Format.price(intrinsicPerShare)}` : '—',
    extrinsicValue: extrinsicPerShare !== null ? `$${Format.price(extrinsicPerShare)}` : '—',
    breakEvenValue: breakEven !== null ? `$${Format.price(breakEven)}` : '—',
    breakEvenPercentValue:
      breakEvenPercent !== null ? `${Format.signedPrice(breakEvenPercent, 2)}%` : null,
    spreadValue: hasQuote
      ? `$${Format.price(spread)} / ${Format.price(spreadPercent ?? 0, 1)}%`
      : '—',
    estimatedDebitLine:
      estimatedDebit !== null ? `Debit $${Format.price(estimatedDebit)}` : 'Debit —',
    maxLossLine:
      estimatedDebit !== null ? `Max loss $${Format.price(estimatedDebit)}` : 'Max loss —',
    sideLabel: contract.optionType === 'call' ? 'CALL' : 'PUT',
    side: contract.optionType,
    quoteFields,
  };
}
