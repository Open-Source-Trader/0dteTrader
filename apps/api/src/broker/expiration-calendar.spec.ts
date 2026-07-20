import { isTradingDay, marketHolidays, optionExpirations } from './expiration-calendar';
import * as expirationCalendar from './expiration-calendar';

function utc(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

describe('marketHolidays', () => {
  it('lists the 2026 NYSE calendar', () => {
    expect([...marketHolidays(2026)].sort()).toEqual([
      '2026-01-01', // New Year's Day (Thursday)
      '2026-01-19', // MLK Day
      '2026-02-16', // Washington's Birthday
      '2026-04-03', // Good Friday (Easter is April 5)
      '2026-05-25', // Memorial Day
      '2026-06-19', // Juneteenth (Friday)
      '2026-07-03', // Independence Day observed (July 4 is a Saturday)
      '2026-09-07', // Labor Day
      '2026-11-26', // Thanksgiving
      '2026-12-25', // Christmas (Friday)
    ]);
  });

  it('observes Sunday holidays the following Monday', () => {
    // July 4 2027 is a Sunday → observed Monday July 5.
    expect(marketHolidays(2027).has('2027-07-05')).toBe(true);
    expect(marketHolidays(2027).has('2027-07-04')).toBe(false);
  });

  it("does not observe New Year's on the prior Friday when Jan 1 is a Saturday", () => {
    // Jan 1 2022 was a Saturday: the NYSE was open Friday Dec 31 2021.
    expect(marketHolidays(2022).has('2022-01-01')).toBe(false);
    expect(marketHolidays(2021).has('2021-12-31')).toBe(false);
    expect(isTradingDay(utc('2021-12-31'))).toBe(true);
  });
});

describe('isTradingDay', () => {
  it('rejects weekends', () => {
    expect(isTradingDay(utc('2026-07-04'))).toBe(false); // Saturday
    expect(isTradingDay(utc('2026-07-05'))).toBe(false); // Sunday
  });

  it('rejects holidays and accepts regular weekdays', () => {
    expect(isTradingDay(utc('2026-07-03'))).toBe(false); // observed July 4th
    expect(isTradingDay(utc('2026-07-06'))).toBe(true);
    expect(isTradingDay(utc('2026-11-26'))).toBe(false); // Thanksgiving
    expect(isTradingDay(utc('2026-11-27'))).toBe(true); // day after is a trading day
  });
});

describe('optionExpirations', () => {
  it('never returns a weekend or holiday', () => {
    for (const underlying of ['SPY', 'AAPL']) {
      const expirations = optionExpirations(underlying, utc('2026-07-01'));
      for (const expiration of expirations) {
        expect(isTradingDay(utc(expiration))).toBe(true);
      }
    }
  });

  it('SPY gets daily expirations that skip the July 4th weekend', () => {
    const expirations = optionExpirations('SPY', utc('2026-07-01'));
    // Wed 1, Thu 2, then Fri 3 (holiday) + weekend skipped → Mon 6, Tue 7, Wed 8.
    expect(expirations.slice(0, 5)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
    ]);
  });

  it('a single-name ticker has no daily expirations, only weeklies and monthlies', () => {
    const expirations = optionExpirations('AAPL', utc('2026-07-01'));
    // Nearest is that week's expiry (Thursday, since Friday is a holiday) —
    // not "today", which is a Wednesday with no listing for single names.
    expect(expirations[0]).toBe('2026-07-02');
    expect(expirations).not.toContain('2026-07-01');
    expect(expirations).toContain('2026-07-10'); // next weekly Friday
    expect(expirations).toContain('2026-07-17'); // July monthly (3rd Friday)
    expect(expirations).toContain('2026-08-21'); // August monthly
  });

  it('moves the Good Friday week expiry to Thursday', () => {
    const expirations = optionExpirations('AAPL', utc('2026-03-30'));
    expect(expirations).toContain('2026-04-02');
    expect(expirations).not.toContain('2026-04-03');
  });

  it('includes today for a daily-listed ETF on a regular trading day', () => {
    const expirations = optionExpirations('QQQ', utc('2026-07-14')); // Tuesday
    expect(expirations[0]).toBe('2026-07-14');
  });

  it('is ascending and deduped', () => {
    const expirations = optionExpirations('SPY', utc('2026-07-13'));
    expect(expirations).toEqual([...new Set(expirations)].sort());
  });
});

describe('option settlement', () => {
  type SettlementCalendar = {
    optionSettlementAt?: (expiration: string, underlying: string, rootSymbol?: string) => Date;
    isRegularMarketSessionOpen?: (now: Date) => boolean;
  };

  const settlement = expirationCalendar as SettlementCalendar;

  it('settles PM equity and SPXW options at 16:00 America/New_York across DST', () => {
    expect(settlement.optionSettlementAt).toBeDefined();
    expect(settlement.optionSettlementAt!('2026-07-17', 'SPY').toISOString()).toBe(
      '2026-07-17T20:00:00.000Z',
    );
    expect(settlement.optionSettlementAt!('2026-01-16', 'SPY').toISOString()).toBe(
      '2026-01-16T21:00:00.000Z',
    );
    expect(settlement.optionSettlementAt!('2026-07-17', 'SPX', 'SPXW').toISOString()).toBe(
      '2026-07-17T20:00:00.000Z',
    );
  });

  it('uses the 13:00 America/New_York close on scheduled early-close sessions', () => {
    expect(settlement.optionSettlementAt).toBeDefined();
    expect(settlement.optionSettlementAt!('2026-11-27', 'SPY').toISOString()).toBe(
      '2026-11-27T18:00:00.000Z',
    );
  });

  it.each([
    ['2025-07-03', true],
    ['2026-07-02', false],
    ['2027-07-02', false],
    ['2028-07-03', true],
    ['2026-07-01', false],
    ['2021-12-24', false],
    ['2022-12-23', false],
    ['2026-12-24', true],
  ] as const)('classifies %s early-close status as %s', (date, expected) => {
    expect(expirationCalendar.isEarlyCloseTradingDay(new Date(`${date}T12:00:00Z`))).toBe(expected);
  });

  it('keeps July 2 2026 at the regular close because the published early close is not shifted', () => {
    expect(settlement.optionSettlementAt!('2026-07-02', 'SPY').toISOString()).toBe(
      '2026-07-02T20:00:00.000Z',
    );
  });

  it('settles standard SPX contracts at the 09:30 America/New_York opening print', () => {
    expect(settlement.optionSettlementAt).toBeDefined();
    expect(settlement.optionSettlementAt!('2026-07-17', 'SPX', 'SPX').toISOString()).toBe(
      '2026-07-17T13:30:00.000Z',
    );
    expect(settlement.optionSettlementAt!('2026-01-16', 'SPX', 'SPX').toISOString()).toBe(
      '2026-01-16T14:30:00.000Z',
    );
  });

  it('reports the regular market session using the same New York calendar', () => {
    expect(settlement.isRegularMarketSessionOpen).toBeDefined();
    expect(settlement.isRegularMarketSessionOpen!(new Date('2026-07-20T15:00:00Z'))).toBe(true);
    expect(settlement.isRegularMarketSessionOpen!(new Date('2026-07-20T20:01:00Z'))).toBe(false);
    expect(settlement.isRegularMarketSessionOpen!(new Date('2026-11-27T18:01:00Z'))).toBe(false);
  });
});
