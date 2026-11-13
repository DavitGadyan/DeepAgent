/** Display formatting shared by the pages. All dates render in the viewer's locale. */
import type { PipelineError } from './types';

const TIME = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const DATE = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

export const formatTime = (iso: string) => TIME.format(new Date(iso));
export const formatDateTime = (iso: string) => DATE_TIME.format(new Date(iso));
export const formatDate = (iso: string | null) => (iso ? DATE.format(new Date(iso)) : '—');

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const WEEKDAY = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
});

/** A calendar day 'YYYY-MM-DD' as that day in the viewer's zone (not UTC midnight). */
const calendarDay = (day: string) => {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(year, month - 1, date);
};
/** '2026-11-12' -> '12 Nov'. */
export const formatDay = (day: string) => DAY.format(calendarDay(day));
/** '2026-11-12' -> 'Thu, 12 Nov'. */
export const formatWeekday = (day: string) => WEEKDAY.format(calendarDay(day));

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How long ago: 'just now', '5 min ago', '3 h ago', '2 d ago'; the date after 30 days. */
export function formatAgo(iso: string, now: number): string {
  const age = now - Date.parse(iso);
  // Also a time slightly in the future, when the two clocks differ.
  if (age < MINUTE_MS) return 'just now';
  if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)} min ago`;
  if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)} h ago`;
  if (age < 30 * DAY_MS) return `${Math.floor(age / DAY_MS)} d ago`;
  return formatDate(iso);
}

/** 840 -> '840 ms', 2300 -> '2.3 s', 95000 -> '1m 35s'. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** 'full_time' -> 'Full time'; '' and 'unknown' -> '—'. */
export function humanize(value: string): string {
  if (!value || value === 'unknown') return '—';
  const words = value.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Yearly amounts in thousands: (70000, 95000, 'EUR') -> 'EUR 70k–95k'.
 * '' when there is no amount, or when one is below 1000 (an hourly or daily
 * rate, or a misread figure), so the caller can fall back to the posting's text.
 */
export function formatSalary(min: number | null, max: number | null, currency: string): string {
  const amounts = [min, max].filter((value) => value !== null);
  if (amounts.length === 0 || amounts.some((value) => value < 1000)) return '';
  const amount = (value: number) => `${Math.round(value / 1000)}k`;
  const range =
    min !== null && max !== null && min !== max
      ? `${amount(min)}–${amount(max)}`
      : amount(max ?? (min as number));
  return currency ? `${currency} ${range}` : range;
}

/** What a card shows instead of "not done yet" when its pipeline step failed. */
export function failureNote({ agent, error }: PipelineError): string {
  const sentence = /[.!?]$/.test(error.trim()) ? error.trim() : `${error.trim()}.`;
  return `The ${agent} failed on this posting: ${sentence} It is retried on the next run with 'force'.`;
}

/** 1.249 -> '$1.25'. A real amount below half a cent is '<$0.01', not '$0.00'. */
export const formatUsd = (amount: number) =>
  amount > 0 && amount < 0.005 ? '<$0.01' : `$${amount.toFixed(2)}`;

/** A run's per-source limit; 0 (older runs) meant the value from Setup. */
export const formatLimitPerSource = (limit: number) =>
  limit > 0 ? `${limit} per source` : 'Setup default';
