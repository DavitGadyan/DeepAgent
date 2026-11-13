'use client';
import { useEffect, useState } from 'react';
import { type ApiError, api } from './api';
import { type LeadListState, PAGE_SIZE, listToParams, toLeadQuery } from './leadFilters';
import { type LiveList, type LiveView, expireFresh, mergeLead, startLive } from './liveLeads';
import type { LeadSummary } from './types';
import { useApi } from './useApi';
import { useEventStream } from './useEventStream';

/** How long a row that was just pushed in keeps its "new" mark. */
export const NEW_MARK_MS = 6000;
/** A list whose total became uncertain is loaded again, at most this often. */
const STALE_RELOAD_MS = 2000;

/** One response, with what it was asked for: pushed leads are judged against that. */
interface Loaded {
  key: string;
  view: LiveView;
  list: LiveList;
}

export interface LiveLeads {
  /** The page on screen, kept current by pushes; undefined until the first load. */
  list: LiveList | undefined;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * The leads for `state` (filters, sort, page), loaded once and then kept
 * current from the event stream: no polling. The list is loaded again only
 * when `state` changes, after the stream reconnects, or when a push leaves
 * the total uncertain.
 */
export function useLiveLeads(state: LeadListState): LiveLeads {
  const key = listToParams(state).toString();
  const fetched = useApi(`leads:${key}`, async (): Promise<Loaded> => {
    // "Last 24 hours" counts back from the moment of this request.
    const page = await api.leads(toLeadQuery(state, new Date()));
    const view = { ...state, pageSize: PAGE_SIZE, loadedAt: Date.now() };
    return { key, view, list: startLive(page) };
  });

  // The loaded page plus every push since. A newer response replaces it; the
  // pill's count survives a reload of the same page, which the user has not left.
  const [live, setLive] = useState<{ from: Loaded; list: LiveList } | null>(null);
  if (fetched.data && live?.from !== fetched.data) {
    const unseen = live?.from.key === fetched.data.key ? live.list.unseen : [];
    setLive({ from: fetched.data, list: { ...fetched.data.list, unseen } });
  }

  const { refresh } = fetched;
  useEventStream({
    onLead: (lead: LeadSummary) =>
      setLive(
        (prev) => prev && { ...prev, list: mergeLead(prev.list, lead, prev.from.view, Date.now()) },
      ),
    // Whatever was pushed while the stream was down is lost: load the list again, once.
    onReconnect: refresh,
  });

  const stale = live?.list.stale ?? false;
  useEffect(() => {
    if (!stale) return;
    const timer = window.setTimeout(refresh, STALE_RELOAD_MS);
    return () => window.clearTimeout(timer);
  }, [stale, refresh]);

  const fresh = live?.list.fresh;
  useEffect(() => {
    const marks = Object.values(fresh ?? {});
    if (marks.length === 0) return;
    // A little late on purpose: a timer that fires a moment early would expire nothing.
    const wait = Math.max(0, Math.min(...marks) + NEW_MARK_MS - Date.now()) + 50;
    const timer = window.setTimeout(
      () =>
        setLive(
          (prev) => prev && { ...prev, list: expireFresh(prev.list, Date.now() - NEW_MARK_MS) },
        ),
      wait,
    );
    return () => window.clearTimeout(timer);
  }, [fresh]);

  return {
    list: live?.list,
    error: fetched.error,
    loading: fetched.loading,
    reload: fetched.reload,
  };
}
