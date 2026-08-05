import type { OptionContract, OptionType, OptionsChain } from '@0dtetrader/shared-types';
import { dayString, isDayString } from '../../core/models/dates';

/**
 * AUTO contract selection (server's resolveAutoOtm analog): anchor on the ATM
 * strike — the one closest to the live underlying price, ties resolving toward
 * the OTM side — then step `otmOffset` rungs out of the money (calls up the
 * ladder, puts down). Offset 0 trades the ATM strike itself. Returns null when
 * the ladder runs out; the server re-validates at submission time.
 */
export function selectAutoOTM(
  chain: OptionsChain,
  optionType: OptionType,
  expiration?: string | null,
  last?: number | null,
  otmOffset = 1,
): OptionContract | null {
  const referencePrice = last ?? chain.underlyingPrice;
  const targetExpiration = expiration ?? nearestExpiration(chain.expirations);

  const candidates = chain.contracts.filter(
    (contract: OptionContract) =>
      contract.optionType === optionType &&
      (targetExpiration === null || contract.expiration === targetExpiration),
  );

  const ladder = [...new Set(candidates.map((contract: OptionContract) => contract.strike))].sort(
    (a, b) => a - b,
  );
  if (ladder.length === 0) return null;

  // Ties prefer the later (higher) rung for calls and the earlier (lower) one
  // for puts — both are the OTM side of an equidistant pair.
  let atm = 0;
  for (let i = 1; i < ladder.length; i++) {
    const distance = Math.abs(ladder[i] - referencePrice);
    const best = Math.abs(ladder[atm] - referencePrice);
    if (distance < best || (distance === best && optionType === 'call')) atm = i;
  }

  // Out-of-range indexes fall out as undefined: the ladder is exhausted.
  const target: number | undefined =
    ladder[optionType === 'call' ? atm + otmOffset : atm - otmOffset];
  if (target === undefined) return null;
  return candidates.find((contract: OptionContract) => contract.strike === target) ?? null;
}

/**
 * Nearest expiration on or after today; falls back to the latest known when
 * everything is in the past. `yyyy-MM-dd` strings sort chronologically.
 */
export function nearestExpiration(expirations: string[]): string | null {
  const todayString = dayString();
  const valid = expirations.filter(isDayString);
  if (valid.length === 0) return null;
  const upcoming = valid.filter((expiration) => expiration >= todayString);
  if (upcoming.length > 0) return upcoming.reduce((a, b) => (a < b ? a : b));
  return valid.reduce((a, b) => (a > b ? a : b));
}
