/**
 * The Leads page's filters, sort and page: how they are kept in the page
 * address, turned into an API query, and applied to one lead in the browser
 * (for leads pushed over the event stream).
 */
import {
  LEAD_STATUSES,
  type LeadQuery,
  type LeadSort,
  type LeadStatus,
  type LeadSummary,
} from './types';

/** When LeadScout found the posting: a window ending now, or a range of days. */
export type FoundRange = 'all' | '24h' | '3d' | '7d' | 'custom';

export const FOUND_RANGES: { value: FoundRange; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: '24h', label: 'Last 24 hours' },
  { value: '3d', label: 'Last 3 days' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'custom', label: 'Custom…' },
];

const HOUR_MS = 3_600_000;
const WINDOW_HOURS: Partial<Record<FoundRange, number>> = { '24h': 24, '3d': 72, '7d': 168 };

export interface LeadFilterValues {
  minScore: number;
  status: LeadStatus | '';
  source: string;
  remoteOnly: boolean;
  search: string;
  found: FoundRange;
  /** Custom range only: the viewer's own days as YYYY-MM-DD, both included; '' = open. */
  from: string;
  to: string;
}

export const NO_FILTERS: LeadFilterValues = {
  minScore: 0,
  status: '',
  source: '',
  remoteOnly: false,
  search: '',
  found: 'all',
  from: '',
  to: '',
};

export interface LeadListState {
  filters: LeadFilterValues;
  sort: LeadSort;
  /** 0-based. */
  page: number;
}

export const DEFAULT_LIST: LeadListState = { filters: NO_FILTERS, sort: 'newest', page: 0 };

export const PAGE_SIZE = 25;

// ---------- Date range ----------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Local midnight of a YYYY-MM-DD day, `addDays` later; null when it is not a real day. */
function localDay(day: string, addDays = 0): Date | null {
  const match = DAY.exec(day);
  if (!match) return null;
  const [year = 0, month = 1, date = 1] = match.slice(1).map(Number);
  const start = new Date(year, month - 1, date);
  // `new Date` rolls 31 February over to March: reject it instead.
  if (start.getMonth() !== month - 1 || start.getDate() !== date) return null;
  // Date arithmetic, not +24 h: a day is 23 or 25 hours long when the clocks change.
  return new Date(year, month - 1, date + addDays);
}

/** A custom range is wrong when both ends are set and "from" is after "to". */
export const rangeError = ({ found, from, to }: LeadFilterValues): string | null =>
  found === 'custom' && from && to && from > to
    ? '"From" is after "To", so the range is not applied.'
    : null;

export interface FoundBounds {
  found_after?: string;
  /** Exclusive. */
  found_before?: string;
}

/**
 * The API's bounds for the chosen range. Relative choices count back from
 * `now`, so call this when the request is made, not once at first render.
 * "To" includes its whole day: the bound is the start of the day after.
 */
export function foundBounds(filters: LeadFilterValues, now: Date): FoundBounds {
  const hours = WINDOW_HOURS[filters.found];
  if (hours) return { found_after: new Date(now.getTime() - hours * HOUR_MS).toISOString() };
  if (filters.found !== 'custom' || rangeError(filters)) return {};
  return {
    found_after: localDay(filters.from)?.toISOString(),
    found_before: localDay(filters.to, 1)?.toISOString(),
  };
}

// ---------- API query ----------

export function toLeadQuery({ filters, sort, page }: LeadListState, now: Date): LeadQuery {
  return {
    min_score: filters.minScore || undefined,
    status: filters.status || undefined,
    source: filters.source || undefined,
    remote: filters.remoteOnly || undefined,
    q: filters.search.trim() || undefined,
    ...foundBounds(filters, now),
    sort,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
}

/** The same test the API applies, for a lead that arrives over the event stream. */
export function matchesFilters(lead: LeadSummary, filters: LeadFilterValues, now: Date): boolean {
  if (filters.minScore && (lead.score ?? -1) < filters.minScore) return false;
  if (filters.status && lead.status !== filters.status) return false;
  if (filters.source && lead.source !== filters.source) return false;
  if (filters.remoteOnly && lead.remote_policy !== 'remote') return false;
  const text = filters.search.trim().toLowerCase();
  if (text && !`${lead.title}\n${lead.company}`.toLowerCase().includes(text)) return false;
  const { found_after: after, found_before: before } = foundBounds(filters, now);
  const found = Date.parse(lead.created_at);
  if (after && found < Date.parse(after)) return false;
  if (before && found >= Date.parse(before)) return false;
  return true;
}

/**
 * Whether a lead can start or stop matching after it was found. Source, title,
 * company and the found date never change; score, status and the remote policy
 * are filled in by later agents.
 */
export const hasChangingFilter = (filters: LeadFilterValues) =>
  filters.minScore > 0 || filters.status !== '' || filters.remoteOnly;

// ---------- Page address ----------

const isStatus = (value: string): value is LeadStatus =>
  (LEAD_STATUSES as readonly string[]).includes(value);
const isFoundRange = (value: string): value is FoundRange =>
  FOUND_RANGES.some((range) => range.value === value);
const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;

/** The query string for a list state; defaults are left out, so the plain page has none. */
export function listToParams({ filters, sort, page }: LeadListState): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.search) params.set('q', filters.search);
  if (filters.minScore) params.set('min_score', String(filters.minScore));
  if (filters.status) params.set('status', filters.status);
  if (filters.source) params.set('source', filters.source);
  if (filters.remoteOnly) params.set('remote', '1');
  if (filters.found !== 'all') params.set('found', filters.found);
  if (filters.found === 'custom') {
    if (filters.from) params.set('from', filters.from);
    if (filters.to) params.set('to', filters.to);
  }
  if (sort !== 'newest') params.set('sort', sort);
  if (page > 0) params.set('page', String(page + 1));
  return params;
}

/** The reverse of `listToParams`; anything unknown or malformed falls back to the default. */
export function listFromParams(params: URLSearchParams): LeadListState {
  const get = (name: string) => params.get(name) ?? '';
  const range = get('found');
  const found = isFoundRange(range) ? range : 'all';
  const day = (name: string) => (found === 'custom' && localDay(get(name)) ? get(name) : '');
  const status = get('status');
  return {
    filters: {
      search: get('q'),
      minScore: clamp(Number(get('min_score')), 0, 100),
      status: isStatus(status) ? status : '',
      source: get('source'),
      remoteOnly: get('remote') === '1',
      found,
      from: day('from'),
      to: day('to'),
    },
    sort: get('sort') === 'score' ? 'score' : 'newest',
    page: clamp(Number(get('page')) - 1, 0, Number.MAX_SAFE_INTEGER),
  };
}
