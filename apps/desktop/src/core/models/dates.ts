/**
 * Date helpers for the backend's JSON payloads (DateParsing.swift analog).
 * Timestamps are ISO-8601 date-times; expirations are `yyyy-MM-dd` calendar
 * dates which sort chronologically as plain strings.
 */

/** Parses an ISO-8601 date-time string; returns epoch milliseconds or null. */
export function parseDateTime(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Formats a date as local `yyyy-MM-dd`, comparable with API expiration strings. */
export function dayString(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** True when `value` looks like a valid `yyyy-MM-dd` date. */
export function isDayString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}
