/**
 * Keeps one loaded page of leads current as the orchestrator pushes lead rows
 * over the event stream. Pure: the hook in useLiveLeads.ts holds the state.
 *
 * The page knows only its own rows, so for a pushed lead that is not on it
 * the question is always "was this lead already counted in `total`?". Three
 * things answer it: the lead was counted by an earlier push (`offPage`), it
 * was found after the list was loaded (so the server cannot have counted it),
 * or it sorts between the rows of the first page (so it would be on screen if
 * the server had counted it). When none of them does, `stale` asks for a reload.
 */
import { type LeadListState, hasChangingFilter, matchesFilters } from './leadFilters';
import type { LeadPage, LeadSort, LeadSummary } from './types';

export interface LiveList {
  items: LeadSummary[];
  total: number;
  /** Job ids counted in `total` since the list was loaded that are not among `items`. */
  offPage: string[];
  /** Of those, the ones that arrived while a later page was shown: the "N new leads" pill. */
  unseen: string[];
  /** Rows a push put on screen: job id -> when (ms), for the short "new" mark. */
  fresh: Record<string, number>;
  /** `total` may be wrong, because a lead this page cannot place has changed. */
  stale: boolean;
}

/** What the rows on screen were loaded with. */
export interface LiveView extends LeadListState {
  pageSize: number;
  /** When the list arrived (ms). */
  loadedAt: number;
}

export const startLive = (page: LeadPage, unseen: string[] = []): LiveList => ({
  items: page.items,
  total: page.total,
  offPage: [],
  unseen,
  fresh: {},
  stale: false,
});

// ---------- Order (the same as the API's) ----------

const foundAt = (lead: LeadSummary) => Date.parse(lead.created_at);

const byNewest = (a: LeadSummary, b: LeadSummary) =>
  foundAt(b) - foundAt(a) || (a.job_id < b.job_id ? -1 : 1);

/** Unscored leads go last. */
const byScore = (a: LeadSummary, b: LeadSummary) =>
  (b.score ?? -1) - (a.score ?? -1) || byNewest(a, b);

const ORDER: Record<LeadSort, (a: LeadSummary, b: LeadSummary) => number> = {
  newest: byNewest,
  score: byScore,
};

/**
 * Where `lead` belongs among `rows`, or null when that is past the end of the
 * page: after the last row while more leads follow on later pages.
 */
function placeOnPage(
  rows: LeadSummary[],
  lead: LeadSummary,
  sort: LeadSort,
  morePages: boolean,
): number | null {
  const index = rows.findIndex((row) => ORDER[sort](lead, row) < 0);
  if (index >= 0) return index;
  return morePages ? null : rows.length;
}

const without = (ids: string[], id: string) => ids.filter((other) => other !== id);

function withoutKey(fresh: Record<string, number>, id: string): Record<string, number> {
  const rest = { ...fresh };
  delete rest[id];
  return rest;
}

// ---------- The merge ----------

/** Puts a row on the first page; the row it pushes off the end stays counted. */
function insertRow(
  list: LiveList,
  lead: LeadSummary,
  index: number,
  view: LiveView,
  now: number,
): LiveList {
  const items = [...list.items.slice(0, index), lead, ...list.items.slice(index)];
  const pushedOff = items.length > view.pageSize ? items.pop() : undefined;
  const fresh = { ...list.fresh, [lead.job_id]: now };
  return {
    ...list,
    items,
    offPage: pushedOff ? [...list.offPage, pushedOff.job_id] : list.offPage,
    fresh: pushedOff ? withoutKey(fresh, pushedOff.job_id) : fresh,
  };
}

/** A row on screen changed. It keeps its place, unless the list is ranked by a score that moved. */
function updateRow(list: LiveList, index: number, lead: LeadSummary, view: LiveView): LiveList {
  const replaced = list.items.map((row, at) => (at === index ? lead : row));
  // Later pages are left alone: moving rows there would shift what the user is reading.
  if (view.sort !== 'score' || view.page > 0 || list.items[index]?.score === lead.score) {
    return { ...list, items: replaced };
  }
  const others = list.items.filter((_, at) => at !== index);
  const place = placeOnPage(others, lead, 'score', list.total > list.items.length);
  if (place === null) {
    return { ...list, items: others, offPage: [...list.offPage, lead.job_id] };
  }
  return { ...list, items: [...others.slice(0, place), lead, ...others.slice(place)] };
}

/** A lead that was counted no longer matches the filters. */
function dropLead(list: LiveList, jobId: string): LiveList {
  return {
    ...list,
    items: list.items.filter((row) => row.job_id !== jobId),
    total: Math.max(0, list.total - 1),
    offPage: without(list.offPage, jobId),
    unseen: without(list.unseen, jobId),
    fresh: withoutKey(list.fresh, jobId),
  };
}

/** A matching lead that is not on screen. */
function addLead(list: LiveList, lead: LeadSummary, view: LiveView, now: number): LiveList {
  const counted = list.offPage.includes(lead.job_id);
  const firstPage = view.page === 0;
  const place = firstPage
    ? placeOnPage(list.items, lead, view.sort, list.total > list.items.length)
    : null;

  if (place !== null) {
    const base = counted
      ? { ...list, offPage: without(list.offPage, lead.job_id) }
      : { ...list, total: list.total + 1 };
    return insertRow(base, lead, place, view, now);
  }
  if (counted) return list;
  if (foundAt(lead) > view.loadedAt) {
    return {
      ...list,
      total: list.total + 1,
      offPage: [...list.offPage, lead.job_id],
      unseen: firstPage ? list.unseen : [...list.unseen, lead.job_id],
    };
  }
  // An older lead on some other page. Without a filter on a field that changes
  // it matched before too, so it is already counted; with one, nobody knows.
  return hasChangingFilter(view.filters) ? { ...list, stale: true } : list;
}

/** The list after the orchestrator pushed `lead` (a new row, or a changed one). */
export function mergeLead(
  list: LiveList,
  lead: LeadSummary,
  view: LiveView,
  now: number,
): LiveList {
  const matches = matchesFilters(lead, view.filters, new Date(now));
  const index = list.items.findIndex((row) => row.job_id === lead.job_id);
  if (index >= 0) return matches ? updateRow(list, index, lead, view) : dropLead(list, lead.job_id);
  if (matches) return addLead(list, lead, view, now);
  if (list.offPage.includes(lead.job_id)) return dropLead(list, lead.job_id);
  // It does not match now. If it is older than the list and a filter is on a
  // field that changes, it may have been counted on another page until now.
  const older = foundAt(lead) <= view.loadedAt;
  return older && hasChangingFilter(view.filters) ? { ...list, stale: true } : list;
}

/** Drops the "new" marks set at or before `before` (ms). */
export function expireFresh(list: LiveList, before: number): LiveList {
  const kept = Object.entries(list.fresh).filter(([, since]) => since > before);
  if (kept.length === Object.keys(list.fresh).length) return list;
  return { ...list, fresh: Object.fromEntries(kept) };
}
