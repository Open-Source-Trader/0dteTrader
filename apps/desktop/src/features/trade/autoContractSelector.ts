import type { OptionContract, OptionType, OptionsChain } from '@0dtetrader/shared-types';
import { dayString, isDayString } from '../../core/models/dates';

/**
 * AUTO contract selection (AutoContractSelector.swift): the option +1 strike
 * OTM from the underlying price — calls: lowest strike strictly above; puts:
 * highest strike strictly below. The server re-validates at submission time.
 */
export function selectAutoOTM(
  chain: OptionsChain,
  optionType: OptionType,
  expiration?: string | null,
  last?: number | null,
): OptionContract | null {
  const referencePrice = last ?? chain.underlyingPrice;
  const targetExpiration = expiration ?? nearestExpiration(chain.expirations);

  const candidates = chain.contracts.filter(
    (contract: OptionContract) =>
      contract.optionType === optionType &&
      (targetExpiration === null || contract.expiration === targetExpiration),
  );

  if (optionType === 'call') {
    return candidates
      .filter((contract: OptionContract) => contract.strike > referencePrice)
      .reduce<OptionContract | null>(
        (best: OptionContract | null, contract: OptionContract) =>
          best === null || contract.strike < best.strike ? contract : best,
        null,
      );
  }
  return candidates
    .filter((contract: OptionContract) => contract.strike < referencePrice)
    .reduce<OptionContract | null>(
      (best: OptionContract | null, contract: OptionContract) =>
        best === null || contract.strike > best.strike ? contract : best,
      null,
    );
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
