import type { OptionContract } from '@0dtetrader/shared-types';
import { Format } from '../../design/format';
import type { ChartPalette } from './chartColors';

/**
 * Entry-line stroke: the contract's direction, not the P/L sign — calls in
 * accent blue, puts in red. The P/L pill on the line keeps profit-sign
 * coloring; the line itself says what kind of position this is.
 */
export function entryLineStroke(
  contract: OptionContract,
  palette: Pick<ChartPalette, 'accent' | 'pnlNegative'>,
): string {
  return contract.optionType === 'call' ? palette.accent : palette.pnlNegative;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Entry-line contract label: `500C 0DTE` / `500P Aug 8`. Built from the
 * expiration's `yyyy-MM-dd` parts rather than a parsed Date — UTC-midnight
 * parsing would shift the day west of Greenwich. `todayIso` is the caller's
 * `dayString()` (kept as a parameter so the label is a pure function).
 */
export function entryLineLabel(contract: OptionContract, todayIso: string): string {
  const right = contract.optionType === 'call' ? 'C' : 'P';
  const prefix = `${Format.strike(contract.strike)}${right}`;
  if (contract.expiration === todayIso) return `${prefix} 0DTE`;
  const [, month, day] = contract.expiration.split('-');
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName || !Number.isFinite(Number(day))) return `${prefix} ${contract.expiration}`;
  return `${prefix} ${monthName} ${Number(day)}`;
}
