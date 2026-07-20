/**
 * Real U.S. option expiration calendar.
 *
 * Expirations fall only on trading days: weekends and NYSE holidays are never
 * offered, and a weekly/monthly expiry whose Friday is a holiday moves to the
 * preceding trading day (e.g. Good Friday week expires Thursday). Which
 * expirations exist depends on the underlying: a few ETFs list Mon–Fri daily
 * expirations; everything else gets weekly Fridays plus the monthly
 * (third-Friday) cycle.
 *
 * All date math is UTC for timezone independence (dates are yyyy-MM-dd
 * strings on the wire).
 */

/** Underlyings with Mon–Fri daily (0DTE) expirations listed. */
const DAILY_EXPIRY_UNDERLYINGS = new Set(['SPY', 'QQQ', 'IWM']);

const DAILY_COUNT = 5;
const WEEKLY_COUNT = 4;
const MONTHLY_COUNT = 3;

// ---------------------------------------------------------------------------
// Date helpers (shared with the broker gateways)
// ---------------------------------------------------------------------------

export function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function todayUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Third Friday of the given month (options monthly cycle; month is 1-12). */
export function thirdFriday(year: number, month: number): Date {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const firstFriday = 1 + ((5 - first.getUTCDay() + 7) % 7);
  return new Date(Date.UTC(year, month - 1, firstFriday + 14));
}

/** nth weekday (0=Sun..6=Sat) of a month; month is 1-12, n is 1-based. */
function nthWeekday(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month - 1, 1 + offset + (n - 1) * 7));
}

function lastWeekday(year: number, month: number, weekday: number): Date {
  const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return addDays(last, -offset);
}

/** Easter Sunday (Gregorian, anonymous algorithm); Good Friday is 2 days prior. */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

// ---------------------------------------------------------------------------
// NYSE holidays
// ---------------------------------------------------------------------------

/** Sat → preceding Friday, Sun → following Monday (standard NYSE observance). */
function observed(d: Date): Date {
  if (d.getUTCDay() === 6) return addDays(d, -1);
  if (d.getUTCDay() === 0) return addDays(d, 1);
  return d;
}

const holidayCache = new Map<number, Set<string>>();

/** Full-day NYSE market holidays for a year, as yyyy-MM-dd strings. */
export function marketHolidays(year: number): Set<string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const days: Date[] = [];
  const newYears = new Date(Date.UTC(year, 0, 1));
  // NYSE rule: New Year's falling on Saturday is NOT observed the prior Friday
  // (that Friday belongs to the old year); Sunday is observed Monday.
  if (newYears.getUTCDay() === 0) days.push(addDays(newYears, 1));
  else if (newYears.getUTCDay() !== 6) days.push(newYears);
  days.push(nthWeekday(year, 1, 1, 3)); // MLK Day: 3rd Monday of January
  days.push(nthWeekday(year, 2, 1, 3)); // Washington's Birthday: 3rd Monday of February
  days.push(addDays(easterSunday(year), -2)); // Good Friday
  days.push(lastWeekday(year, 5, 1)); // Memorial Day: last Monday of May
  if (year >= 2022) days.push(observed(new Date(Date.UTC(year, 5, 19)))); // Juneteenth
  days.push(observed(new Date(Date.UTC(year, 6, 4)))); // Independence Day
  days.push(nthWeekday(year, 9, 1, 1)); // Labor Day: 1st Monday of September
  days.push(nthWeekday(year, 11, 4, 4)); // Thanksgiving: 4th Thursday of November
  days.push(observed(new Date(Date.UTC(year, 11, 25)))); // Christmas

  const set = new Set(days.map(ymd));
  holidayCache.set(year, set);
  return set;
}

export function isTradingDay(d: Date): boolean {
  const weekday = d.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !marketHolidays(d.getUTCFullYear()).has(ymd(d));
}

/** Previous full trading day, excluding the supplied date. */
export function previousTradingDay(d: Date): Date {
  let day = addDays(todayUtc(d), -1);
  while (!isTradingDay(day)) day = addDays(day, -1);
  return day;
}

/** Scheduled 13:00 ET equity-market closes relevant to PM-settled options. */
export function isEarlyCloseTradingDay(d: Date): boolean {
  if (!isTradingDay(d)) return false;
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();

  // Day after Thanksgiving.
  if (month === 11 && d.getUTCDay() === 5) {
    const thanksgiving = nthWeekday(d.getUTCFullYear(), 11, 4, 4);
    if (ymd(d) === ymd(addDays(thanksgiving, 1))) return true;
  }

  // Published U.S. market calendars schedule the pre-Independence-Day early
  // close on July 3 only when July 3 is itself a trading day. It is not shifted
  // to July 2 when July 3 is the observed holiday (2026) or when July 5 is the
  // observed holiday (2027).
  if (month === 7 && day === 3) return true;

  // Christmas Eve closes early only when December 24 itself is a trading day;
  // it is not shifted when December 24 is a weekend or the observed holiday.
  return month === 12 && day === 24;
}

function zonedDateTime(date: string, hour: number, minute: number, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Malformed expiration date: ${date}`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(localAsUtc));
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const representedAsUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  );
  return new Date(localAsUtc - (representedAsUtc - localAsUtc));
}

/** Settlement instant for AM-settled SPX and PM-settled equity/ETF/SPXW options. */
export function optionSettlementAt(
  expiration: string,
  underlying: string,
  rootSymbol?: string,
): Date {
  const day = new Date(`${expiration}T12:00:00Z`);
  if (!Number.isFinite(day.getTime()) || ymd(day) !== expiration) {
    throw new Error(`Malformed expiration date: ${expiration}`);
  }
  if (!isTradingDay(day)) {
    throw new Error(`Option expiration is not a trading day: ${expiration}`);
  }

  const normalizedUnderlying = underlying.trim().toUpperCase();
  const normalizedRoot = rootSymbol?.trim().toUpperCase();
  if (normalizedUnderlying === 'SPX' && normalizedRoot !== 'SPXW') {
    return zonedDateTime(expiration, 9, 30, 'America/New_York');
  }

  const closeHour = isEarlyCloseTradingDay(day) ? 13 : 16;
  return zonedDateTime(expiration, closeHour, 0, 'America/New_York');
}

/** True only during the regular New York cash session, excluding the close. */
export function isRegularMarketSessionOpen(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const text = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const day = new Date(
    Date.UTC(Number(text('year')), Number(text('month')) - 1, Number(text('day'))),
  );
  if (!isTradingDay(day)) return false;
  const minutes = Number(text('hour')) * 60 + Number(text('minute'));
  const closeMinutes = isEarlyCloseTradingDay(day) ? 13 * 60 : 16 * 60;
  return minutes >= 9 * 60 + 30 && minutes < closeMinutes;
}

function precedingTradingDay(d: Date): Date {
  let day = d;
  while (!isTradingDay(day)) day = addDays(day, -1);
  return day;
}

// ---------------------------------------------------------------------------
// Expirations
// ---------------------------------------------------------------------------

/**
 * Upcoming option expirations for an underlying, ascending and deduped:
 * - daily-listed ETFs: the next 5 trading days;
 * - all underlyings: the next 4 weekly Friday expirations and the next 3
 *   monthly (third-Friday) expirations, each moved to the preceding trading
 *   day when the Friday is a holiday.
 */
export function optionExpirations(underlying: string, now: Date): string[] {
  const today = todayUtc(now);
  const out = new Set<string>();

  if (DAILY_EXPIRY_UNDERLYINGS.has(underlying.toUpperCase())) {
    let day = today;
    let added = 0;
    while (added < DAILY_COUNT) {
      if (isTradingDay(day)) {
        out.add(ymd(day));
        added += 1;
      }
      day = addDays(day, 1);
    }
  }

  let friday = addDays(today, (5 - today.getUTCDay() + 7) % 7);
  let weeklies = 0;
  while (weeklies < WEEKLY_COUNT) {
    const expiry = precedingTradingDay(friday);
    if (expiry.getTime() >= today.getTime()) {
      out.add(ymd(expiry));
      weeklies += 1;
    }
    friday = addDays(friday, 7);
  }

  let year = today.getUTCFullYear();
  let month = today.getUTCMonth() + 1;
  let monthlies = 0;
  while (monthlies < MONTHLY_COUNT) {
    const expiry = precedingTradingDay(thirdFriday(year, month));
    if (expiry.getTime() >= today.getTime()) {
      out.add(ymd(expiry));
      monthlies += 1;
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return [...out].sort();
}
