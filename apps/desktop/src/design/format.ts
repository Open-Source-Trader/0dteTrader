/** Shared display formatting for prices, strikes and P&L (Formatters.swift). */
export const Format = {
  price(value: number, fractionDigits = 2): string {
    return value.toFixed(fractionDigits);
  },

  /** `+1.24` / `-0.87` style signed values for P&L. */
  signedPrice(value: number, fractionDigits = 2): string {
    const text = Math.abs(value).toFixed(fractionDigits);
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
