import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIST,
  type LeadFilterValues,
  NO_FILTERS,
  PAGE_SIZE,
  foundBounds,
  hasChangingFilter,
  listFromParams,
  listToParams,
  matchesFilters,
  rangeError,
  toLeadQuery,
} from './leadFilters';
import type { LeadSummary } from './types';

const NOW = new Date('2026-11-12T10:00:00Z');
const filters = (changes: Partial<LeadFilterValues>): LeadFilterValues => ({
  ...NO_FILTERS,
  ...changes,
});

const lead = (changes: Partial<LeadSummary> = {}): LeadSummary => ({
  job_id: 'job-1',
  status: 'scored',
  score: 80,
  title: 'ML Engineer',
  company: 'Acme',
  location: 'Berlin',
  source: 'remoteok',
  url: 'https://example.com/1',
  remote_policy: 'remote',
  seniority: 'senior',
  role_family: 'ml',
  posted_at: null,
  created_at: '2026-11-12T09:00:00Z',
  updated_at: '2026-11-12T09:05:00Z',
  ...changes,
});

describe('foundBounds', () => {
  it('has no bounds for all time', () => {
    expect(foundBounds(NO_FILTERS, NOW)).toEqual({});
  });

  it('counts the relative choices back from now', () => {
    expect(foundBounds(filters({ found: '24h' }), NOW)).toEqual({
      found_after: '2026-11-11T10:00:00.000Z',
    });
    expect(foundBounds(filters({ found: '3d' }), NOW)).toEqual({
      found_after: '2026-11-09T10:00:00.000Z',
    });
    expect(foundBounds(filters({ found: '7d' }), NOW)).toEqual({
      found_after: '2026-11-05T10:00:00.000Z',
    });
  });

  it('moves a relative window with the clock', () => {
    const later = new Date('2026-11-12T12:30:00Z');
    expect(foundBounds(filters({ found: '24h' }), later).found_after).toBe(
      '2026-11-11T12:30:00.000Z',
    );
  });

  it('includes the whole "to" day: the upper bound is the start of the next day', () => {
    const bounds = foundBounds(
      filters({ found: 'custom', from: '2026-11-03', to: '2026-11-05' }),
      NOW,
    );
    // Days are the viewer's own, so the expected instants are built the same way.
    expect(bounds).toEqual({
      found_after: new Date(2026, 10, 3).toISOString(),
      found_before: new Date(2026, 10, 6).toISOString(),
    });
  });

  it('rolls the "to" day over a month end', () => {
    const bounds = foundBounds(
      filters({ found: 'custom', from: '2026-11-30', to: '2026-11-30' }),
      NOW,
    );
    expect(bounds.found_before).toBe(new Date(2026, 11, 1).toISOString());
  });

  it('leaves an open end unbounded', () => {
    expect(foundBounds(filters({ found: 'custom', from: '2026-11-03' }), NOW)).toEqual({
      found_after: new Date(2026, 10, 3).toISOString(),
      found_before: undefined,
    });
  });

  it('applies no bounds while "from" is after "to"', () => {
    const wrong = filters({ found: 'custom', from: '2026-11-09', to: '2026-11-03' });
    expect(rangeError(wrong)).toMatch(/after/);
    expect(foundBounds(wrong, NOW)).toEqual({});
  });

  it('accepts a one-day range and ignores the dates of another choice', () => {
    expect(
      rangeError(filters({ found: 'custom', from: '2026-11-03', to: '2026-11-03' })),
    ).toBeNull();
    expect(rangeError(filters({ found: '7d', from: '2026-11-09', to: '2026-11-03' }))).toBeNull();
  });
});

describe('toLeadQuery', () => {
  it('asks for the newest first page by default', () => {
    expect(toLeadQuery(DEFAULT_LIST, NOW)).toEqual({
      min_score: undefined,
      status: undefined,
      source: undefined,
      remote: undefined,
      q: undefined,
      sort: 'newest',
      limit: PAGE_SIZE,
      offset: 0,
    });
  });

  it('carries the filters, the sort, the page and the date bounds', () => {
    const state = {
      filters: filters({ minScore: 70, status: 'scored', search: '  acme ', found: '24h' }),
      sort: 'score' as const,
      page: 2,
    };
    expect(toLeadQuery(state, NOW)).toMatchObject({
      min_score: 70,
      status: 'scored',
      q: 'acme',
      found_after: '2026-11-11T10:00:00.000Z',
      sort: 'score',
      offset: 2 * PAGE_SIZE,
    });
  });
});

describe('matchesFilters', () => {
  it('matches everything without filters', () => {
    expect(matchesFilters(lead(), NO_FILTERS, NOW)).toBe(true);
  });

  it('applies the minimum score; an unscored lead fails it', () => {
    expect(matchesFilters(lead({ score: 70 }), filters({ minScore: 70 }), NOW)).toBe(true);
    expect(matchesFilters(lead({ score: 69 }), filters({ minScore: 70 }), NOW)).toBe(false);
    expect(matchesFilters(lead({ score: null }), filters({ minScore: 5 }), NOW)).toBe(false);
  });

  it('applies status, source and remote-only', () => {
    expect(matchesFilters(lead(), filters({ status: 'researched' }), NOW)).toBe(false);
    expect(matchesFilters(lead(), filters({ source: 'hn' }), NOW)).toBe(false);
    expect(
      matchesFilters(lead({ remote_policy: 'hybrid' }), filters({ remoteOnly: true }), NOW),
    ).toBe(false);
    expect(
      matchesFilters(
        lead(),
        filters({ status: 'scored', source: 'remoteok', remoteOnly: true }),
        NOW,
      ),
    ).toBe(true);
  });

  it('searches title and company, ignoring case', () => {
    expect(matchesFilters(lead(), filters({ search: 'ACME' }), NOW)).toBe(true);
    expect(matchesFilters(lead(), filters({ search: ' engineer ' }), NOW)).toBe(true);
    expect(matchesFilters(lead(), filters({ search: 'berlin' }), NOW)).toBe(false);
  });

  it('applies the found date: inside a relative window, and up to the end of the "to" day', () => {
    const old = lead({ created_at: '2026-11-10T09:00:00Z' });
    expect(matchesFilters(old, filters({ found: '24h' }), NOW)).toBe(false);
    expect(matchesFilters(old, filters({ found: '3d' }), NOW)).toBe(true);

    const range = filters({ found: 'custom', from: '2026-11-03', to: '2026-11-05' });
    const at = (date: Date) => lead({ created_at: date.toISOString() });
    expect(matchesFilters(at(new Date(2026, 10, 5, 23, 59)), range, NOW)).toBe(true);
    expect(matchesFilters(at(new Date(2026, 10, 6, 0, 0)), range, NOW)).toBe(false);
    expect(matchesFilters(at(new Date(2026, 10, 3, 0, 0)), range, NOW)).toBe(true);
    expect(matchesFilters(at(new Date(2026, 10, 2, 23, 59)), range, NOW)).toBe(false);
  });
});

describe('hasChangingFilter', () => {
  it('is true only for filters on fields the later agents fill in', () => {
    expect(hasChangingFilter(NO_FILTERS)).toBe(false);
    expect(hasChangingFilter(filters({ search: 'acme', source: 'hn', found: '7d' }))).toBe(false);
    expect(hasChangingFilter(filters({ minScore: 50 }))).toBe(true);
    expect(hasChangingFilter(filters({ status: 'scored' }))).toBe(true);
    expect(hasChangingFilter(filters({ remoteOnly: true }))).toBe(true);
  });
});

describe('page address', () => {
  it('is empty for the default list', () => {
    expect(listToParams(DEFAULT_LIST).toString()).toBe('');
    expect(listFromParams(new URLSearchParams(''))).toEqual(DEFAULT_LIST);
  });

  it('round-trips every filter, the sort and the page', () => {
    const state = {
      filters: {
        minScore: 65,
        status: 'cv_ready' as const,
        source: 'remoteok',
        remoteOnly: true,
        search: 'ml engineer',
        found: 'custom' as const,
        from: '2026-11-03',
        to: '2026-11-05',
      },
      sort: 'score' as const,
      page: 3,
    };
    const params = listToParams(state);
    expect(params.get('found')).toBe('custom');
    expect(params.get('page')).toBe('4');
    expect(listFromParams(new URLSearchParams(params.toString()))).toEqual(state);
  });

  it('keeps a relative choice as the choice, not as dates', () => {
    const params = listToParams({ ...DEFAULT_LIST, filters: filters({ found: '7d' }) });
    expect(params.toString()).toBe('found=7d');
  });

  it('falls back to the defaults for values it does not know', () => {
    const state = listFromParams(
      new URLSearchParams('status=nope&found=1y&sort=oldest&page=-4&min_score=900&from=2026-11-03'),
    );
    expect(state).toEqual({ ...DEFAULT_LIST, filters: filters({ minScore: 100 }) });
  });

  it('drops a custom day that is not a real date', () => {
    const state = listFromParams(new URLSearchParams('found=custom&from=2026-02-31&to=2026-03-02'));
    expect(state.filters).toMatchObject({ found: 'custom', from: '', to: '2026-03-02' });
  });
});
