/** Shared display formatting for prices, strikes and P&L (Formatters.swift). */

/** Locale grouping with a fixed fraction: 12345.678 → "12,345.68". */
function group(value: number, fractionDigits: number): string {
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export const Format = {
  price(value: number, fractionDigits = 2): string {
    return group(value, fractionDigits);
  },

  /** `+1.24` / `-0.87` style signed values for P&L; zero renders unsigned. */
  signedPrice(value: number, fractionDigits = 2): string {
    if (value === 0) return group(0, fractionDigits);
    const text = group(Math.abs(value), fractionDigits);
    return value < 0 ? `-${text}` : `+${text}`;
  },

  /** Option strikes: trims to at most 2 fraction digits (`503`, `502.5`). */
  strike(value: number): string {
    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2);
  },

  /** `+2` / `-1` signed position quantities. */
  signedQuantity(value: number): string {
    return value > 0 ? `+${value}` : `${value}`;
  },
};
