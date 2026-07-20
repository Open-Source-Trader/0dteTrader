import type { OptionsAnalyticsStrikePresentation } from './optionsAnalyticsPresentation';
import { formatCompactDollars } from './optionsAnalyticsPresentation';

function optionalPercent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function optionalDollars(value: number | null): string {
  return value === null ? 'n/a' : formatCompactDollars(value);
}

function optionalCount(value: number | null): string {
  return value === null ? 'n/a' : value.toLocaleString();
}

function optionalDelta(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(3);
}

export function optionsAnalyticsHoverLines(strike: OptionsAnalyticsStrikePresentation): string[] {
  const lines = [
    `Strike ${strike.strike.toFixed(2)}`,
    `Call gamma ${formatCompactDollars(strike.callGammaExposure)}`,
    `Put gamma ${formatCompactDollars(strike.putGammaExposure)}`,
    `Call IV ${optionalPercent(strike.callImpliedVolatility)} · delta ${optionalDelta(strike.callDelta)} · delta notional ${optionalDollars(strike.callDeltaNotional)}`,
    `Put IV ${optionalPercent(strike.putImpliedVolatility)} · delta ${optionalDelta(strike.putDelta)} · delta notional ${optionalDollars(strike.putDeltaNotional)}`,
    `Total open interest ${strike.totalOpenInterest.toLocaleString()}`,
  ];
  if (strike.markedOiValue !== null) {
    lines.push(
      `Marked OI value C ${optionalDollars(strike.callMarkedOiValue)} · P ${optionalDollars(strike.putMarkedOiValue)}`,
    );
  }
  if (strike.liquidity) {
    lines.push(
      `Call bid/ask size ${optionalCount(strike.liquidity.callBidSize)} × ${optionalCount(strike.liquidity.callAskSize)} · OI ${optionalCount(strike.liquidity.callOpenInterest)} · volume ${optionalCount(strike.liquidity.callVolume)}`,
      `Call spread ${optionalPercent(strike.liquidity.callRelativeSpread)} · round trip/contract ${optionalDollars(strike.liquidity.callRoundTripCost)}`,
      `Put bid/ask size ${optionalCount(strike.liquidity.putBidSize)} × ${optionalCount(strike.liquidity.putAskSize)} · OI ${optionalCount(strike.liquidity.putOpenInterest)} · volume ${optionalCount(strike.liquidity.putVolume)}`,
      `Put spread ${optionalPercent(strike.liquidity.putRelativeSpread)} · round trip/contract ${optionalDollars(strike.liquidity.putRoundTripCost)}`,
    );
  }
  if (strike.dealerProxyGammaExposure !== null) {
    lines.push(`Dealer proxy exposure ${formatCompactDollars(strike.dealerProxyGammaExposure)}`);
  }
  return lines;
}
