/** Prevents a selected expiration from crossing the chart/chain symbol boundary. */
export function optionsAnalyticsExpirationForChart(
  chartSymbol: string,
  chainUnderlying: string,
  selectedExpiration: string | null,
): string | null {
  return chainUnderlying === chartSymbol ? selectedExpiration : null;
}
