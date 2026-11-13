'use client';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { startSync, syncAddress } from './addressSync';
import { type LeadListState, listFromParams, listToParams } from './leadFilters';

/** Typing and dragging the score slider wait this long before they take effect. */
const SETTLE_MS = 250;

const address = (state: LeadListState) => listToParams(state).toString();

/** Whether the change is one of a burst (a key stroke, a slider step). */
const isBurst = (from: LeadListState, to: LeadListState) =>
  from.filters.search !== to.filters.search || from.filters.minScore !== to.filters.minScore;

export interface LeadListControl {
  /** What the controls show: follows every key stroke. */
  state: LeadListState;
  /** What the list is loaded with and what the address says: `state` once it stops changing. */
  settled: LeadListState;
  change: (next: LeadListState) => void;
}

/**
 * The Leads page's filters, sort and page, kept in the page address so that a
 * reload or a shared link shows the same list.
 *
 * The state lives here and is written to the address, not read back from it
 * on every render: the router applies an address change a moment later, which
 * would make a text field lose key strokes. The address is read at the start
 * and when someone else changes it (a link to /leads, the Back button); see
 * addressSync.ts.
 */
export function useLeadListState(): LeadListControl {
  const url = useSearchParams().toString();
  const [state, setState] = useState(() => listFromParams(new URLSearchParams(url)));
  const [settled, setSettled] = useState(state);
  const written = address(settled);
  const [sync, setSync] = useState(() => startSync(url, written));

  const { next, follow } = syncAddress(sync, url, written);
  if (next !== sync) setSync(next);
  if (follow) {
    const followed = listFromParams(new URLSearchParams(url));
    setState(followed);
    setSettled(followed);
  }

  useEffect(() => {
    if (state === settled) return;
    const timer = window.setTimeout(() => setSettled(state), SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [state, settled]);

  useEffect(() => {
    if (written === window.location.search.slice(1)) return;
    // replaceState: a filter change is not a step the Back button should undo.
    window.history.replaceState(null, '', written ? `?${written}` : window.location.pathname);
  }, [written]);

  const change = (to: LeadListState) => {
    setState(to);
    if (!isBurst(state, to)) setSettled(to);
  };

  return { state, settled, change };
}
