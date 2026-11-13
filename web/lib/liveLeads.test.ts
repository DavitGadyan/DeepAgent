import { describe, expect, it } from 'vitest';
import { type LeadFilterValues, NO_FILTERS } from './leadFilters';
import { type LiveList, type LiveView, expireFresh, mergeLead, startLive } from './liveLeads';
import type { LeadSummary } from './types';

const LOADED_AT = Date.parse('2026-11-12T10:00:00Z');
/** A push arrives a minute after the list was loaded. */
const NOW = LOADED_AT + 60_000;

const lead = (id: string, changes: Partial<LeadSummary> = {}): LeadSummary => ({
  job_id: id,
  status: 'new',
  score: null,
  title: `Role ${id}`,
  company: 'Acme',
  location: '',
  source: 'remoteok',
  url: `https://example.com/${id}`,
  remote_policy: 'unknown',
  seniority: '',
  role_family: '',
  posted_at: null,
  created_at: '2026-11-12T09:00:00Z',
  updated_at: '2026-11-12T09:00:00Z',
  ...changes,
});

/** Found `minutes` before the list was loaded (negative: after it). */
const foundBefore = (minutes: number) => new Date(LOADED_AT - minutes * 60_000).toISOString();

const view = (changes: Partial<LiveView> = {}): LiveView => ({
  filters: NO_FILTERS,
  sort: 'newest',
  page: 0,
  pageSize: 3,
  loadedAt: LOADED_AT,
  ...changes,
});
const filters = (changes: Partial<LeadFilterValues>): LeadFilterValues => ({
  ...NO_FILTERS,
  ...changes,
});

/** Three leads, newest first: a (10 min old), b (20), c (30). */
const A = lead('a', { created_at: foundBefore(10), score: 60, status: 'scored' });
const B = lead('b', { created_at: foundBefore(20), score: 90, status: 'scored' });
const C = lead('c', { created_at: foundBefore(30), score: 75, status: 'scored' });
const list = (items: LeadSummary[], total = items.length): LiveList => startLive({ items, total });
const ids = (live: LiveList) => live.items.map((row) => row.job_id);

describe('mergeLead: a new lead', () => {
  const fresh = lead('n', { created_at: foundBefore(-0.5) });

  it('goes to the top of the first page when sorted by newest', () => {
    const next = mergeLead(list([A, B], 2), fresh, view(), NOW);
    expect(ids(next)).toEqual(['n', 'a', 'b']);
    expect(next.total).toBe(3);
    expect(next.fresh).toEqual({ n: NOW });
    expect(next.unseen).toEqual([]);
  });

  it('keeps the page at its size: the last row moves to the next page, still counted', () => {
    const next = mergeLead(list([A, B, C], 40), fresh, view(), NOW);
    expect(ids(next)).toEqual(['n', 'a', 'b']);
    expect(next.total).toBe(41);
    expect(next.offPage).toEqual(['c']);
  });

  it('goes to its score position when sorted by score', () => {
    const scored = { ...fresh, score: 80, status: 'scored' as const };
    const next = mergeLead(list([B, C, A], 3), scored, view({ sort: 'score', pageSize: 10 }), NOW);
    expect(ids(next)).toEqual(['b', 'n', 'c', 'a']);
    expect(next.total).toBe(4);
  });

  it('is counted but not shown when it sorts past a full first page', () => {
    // Unscored leads rank last, and 37 more leads follow this page.
    const next = mergeLead(list([B, C, A], 40), fresh, view({ sort: 'score' }), NOW);
    expect(ids(next)).toEqual(['b', 'c', 'a']);
    expect(next.total).toBe(41);
    expect(next.offPage).toEqual(['n']);
    expect(next.unseen).toEqual([]);
    expect(next.fresh).toEqual({});
  });

  it('is not shown or counted when it does not match the filters', () => {
    const start = list([A, B], 2);
    for (const active of [
      filters({ status: 'researched' }),
      filters({ source: 'hn' }),
      filters({ remoteOnly: true }),
      filters({ minScore: 50 }),
      filters({ search: 'globex' }),
      filters({ found: 'custom', from: '2026-01-01', to: '2026-01-31' }),
    ]) {
      expect(mergeLead(start, fresh, view({ filters: active }), NOW)).toBe(start);
    }
  });

  it('is shown when it matches every active filter', () => {
    const active = filters({ source: 'remoteok', search: 'role', found: '24h' });
    const next = mergeLead(list([A, B], 2), fresh, view({ filters: active }), NOW);
    expect(ids(next)).toEqual(['n', 'a', 'b']);
  });
});

describe('mergeLead: on a later page', () => {
  const second = view({ page: 1 });

  it('does not insert the row; it counts it for the "N new leads" pill', () => {
    const start = list([A, B, C], 9);
    const one = mergeLead(start, lead('n1', { created_at: foundBefore(-1) }), second, NOW);
    const two = mergeLead(one, lead('n2', { created_at: foundBefore(-2) }), second, NOW);
    expect(ids(two)).toEqual(['a', 'b', 'c']);
    expect(two.total).toBe(11);
    expect(two.unseen).toEqual(['n1', 'n2']);
    expect(two.fresh).toEqual({});
  });

  it('counts a lead once, however often it is pushed', () => {
    const fresh = lead('n', { created_at: foundBefore(-1) });
    const one = mergeLead(list([A, B, C], 9), fresh, second, NOW);
    const again = mergeLead(one, { ...fresh, score: 88, status: 'scored' }, second, NOW);
    expect(again.total).toBe(10);
    expect(again.unseen).toEqual(['n']);
  });

  it('still updates a row of this page in place', () => {
    const next = mergeLead(list([A, B, C], 9), { ...B, status: 'researched' }, second, NOW);
    expect(ids(next)).toEqual(['a', 'b', 'c']);
    expect(next.items[1]?.status).toBe('researched');
    expect(next.unseen).toEqual([]);
  });

  it('takes a lead out of the pill when it stops matching', () => {
    const scored = view({ page: 1, filters: filters({ minScore: 50 }) });
    const fresh = lead('n', { created_at: foundBefore(-1), score: 70 });
    const one = mergeLead(list([A, B, C], 9), fresh, scored, NOW);
    const gone = mergeLead(one, { ...fresh, score: 20 }, scored, NOW);
    expect(gone.total).toBe(9);
    expect(gone.unseen).toEqual([]);
  });
});

describe('mergeLead: a lead already on the page', () => {
  it('is updated in place, without moving or changing the total', () => {
    const start = list([A, B, C], 3);
    const next = mergeLead(start, { ...B, status: 'researched', score: 95 }, view(), NOW);
    expect(ids(next)).toEqual(['a', 'b', 'c']);
    expect(next.items[1]).toMatchObject({ status: 'researched', score: 95 });
    expect(next.total).toBe(3);
    expect(next.fresh).toEqual({});
  });

  it('moves to its new score position when the list is ranked by score', () => {
    const ranked = view({ sort: 'score' });
    const next = mergeLead(list([B, C, A], 3), { ...A, score: 99 }, ranked, NOW);
    expect(ids(next)).toEqual(['a', 'b', 'c']);
    expect(next.total).toBe(3);
  });

  it('stays where it is under a score sort when only the status changed', () => {
    const ranked = view({ sort: 'score' });
    const next = mergeLead(list([B, C, A], 3), { ...C, status: 'applied' }, ranked, NOW);
    expect(ids(next)).toEqual(['b', 'c', 'a']);
  });

  it('leaves the page when its new score ranks below it, and stays counted', () => {
    const ranked = view({ sort: 'score' });
    const next = mergeLead(list([B, C, A], 40), { ...B, score: 10 }, ranked, NOW);
    expect(ids(next)).toEqual(['c', 'a']);
    expect(next.total).toBe(40);
    expect(next.offPage).toEqual(['b']);
  });

  it('is removed when it stops matching the filters', () => {
    const scored = view({ filters: filters({ status: 'scored' }) });
    const next = mergeLead(list([A, B, C], 3), { ...B, status: 'researched' }, scored, NOW);
    expect(ids(next)).toEqual(['a', 'c']);
    expect(next.total).toBe(2);
  });
});

describe('mergeLead: an older lead that is not on the page', () => {
  it('appears when it starts to match and sorts into the first page', () => {
    // Found before the list was loaded but unscored then, so the server did not count it.
    const scored = view({ filters: filters({ minScore: 50 }), pageSize: 10 });
    const late = lead('late', { created_at: foundBefore(15), score: 70, status: 'scored' });
    const next = mergeLead(list([A, B, C], 3), late, scored, NOW);
    expect(ids(next)).toEqual(['a', 'late', 'b', 'c']);
    expect(next.total).toBe(4);
    expect(next.stale).toBe(false);
  });

  it('changes nothing without a filter on a changing field: it was counted at load', () => {
    const start = list([A, B, C], 40);
    const older = lead('old', { created_at: foundBefore(600), status: 'researched' });
    expect(mergeLead(start, older, view(), NOW)).toBe(start);
    expect(mergeLead(start, older, view({ filters: filters({ search: 'role' }) }), NOW)).toBe(
      start,
    );
  });

  it('asks for a reload when it cannot tell whether the lead was counted', () => {
    const start = list([A, B, C], 40);
    const older = lead('old', { created_at: foundBefore(600), score: 70, status: 'scored' });
    // Matches now: was it already among the 37 leads on later pages?
    const matching = mergeLead(start, older, view({ filters: filters({ minScore: 50 }) }), NOW);
    expect(matching).toMatchObject({ stale: true, total: 40 });
    // Does not match now: did it until this change?
    const leaving = mergeLead(start, older, view({ filters: filters({ status: 'new' }) }), NOW);
    expect(leaving).toMatchObject({ stale: true, total: 40 });
  });

  it('comes onto the first page once its score ranks there', () => {
    const ranked = view({ sort: 'score' });
    const fresh = lead('n', { created_at: foundBefore(-1) });
    const counted = mergeLead(list([B, C, A], 40), fresh, ranked, NOW);
    const shown = mergeLead(counted, { ...fresh, score: 80, status: 'scored' }, ranked, NOW);
    expect(ids(shown)).toEqual(['b', 'n', 'c']);
    expect(shown.total).toBe(41);
    expect(shown.offPage).toEqual(['a']);
    expect(shown.fresh).toEqual({ n: NOW });
  });
});

describe('expireFresh', () => {
  it('drops the marks that are old enough and keeps the rest', () => {
    const marked = { ...list([A, B]), fresh: { a: 1000, b: 5000 } };
    expect(expireFresh(marked, 1000).fresh).toEqual({ b: 5000 });
  });

  it('returns the same list when nothing expired', () => {
    const marked = { ...list([A, B]), fresh: { a: 1000 } };
    expect(expireFresh(marked, 999)).toBe(marked);
  });
});
