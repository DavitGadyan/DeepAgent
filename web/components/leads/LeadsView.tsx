'use client';
import { ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { type LeadFilterValues, NO_FILTERS, PAGE_SIZE } from '@/lib/leadFilters';
import { pipelineSources } from '@/lib/sources';
import type { LeadSort } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { useLeadListState } from '@/lib/useLeadListState';
import { useLiveLeads } from '@/lib/useLiveLeads';
import { useNow } from '@/lib/useNow';
import { PageHeader } from '@/components/ui/PageHeader';
import { Empty, ErrorBanner, ErrorState, Loading } from '@/components/ui/States';
import { LeadFilters } from './LeadFilters';
import { LeadsTable } from './LeadsTable';

const ORDER_NOTE: Record<LeadSort, string> = {
  newest: 'newest first',
  score: 'best fit first',
};

function Pagination({
  page,
  total,
  onPage,
}: {
  page: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const first = page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);
  return (
    <div className="flex items-center justify-end gap-2 px-3 py-2 text-[0.78rem] text-muted">
      <span className="tabular-nums">
        {first}–{last} of {total}
      </span>
      <button
        type="button"
        className="btn btn--icon"
        aria-label="Previous page"
        disabled={page === 0}
        onClick={() => onPage(page - 1)}
      >
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="btn btn--icon"
        aria-label="Next page"
        disabled={last >= total}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Leads that arrived while a later page is open. They are not put into that
 * page (the rows would move under the reader); this takes the user to them.
 */
function NewLeadsPill({ count, onShow }: { count: number; onShow: () => void }) {
  if (count === 0) return null;
  return (
    <button type="button" className="btn" aria-live="polite" onClick={onShow}>
      <ArrowUp size={14} className="text-accent" aria-hidden="true" />
      {count} new {count === 1 ? 'lead' : 'leads'}
    </button>
  );
}

/**
 * The Leads page: every posting the pipeline kept, newest first or best fit
 * first, with filters and paging. New and changed leads arrive over the event
 * stream, so the list is current without a reload.
 */
export function LeadsView() {
  const { state, settled, change } = useLeadListState();
  const leads = useLiveLeads(settled);
  const pipeline = useApi('pipeline', api.pipeline);
  const sources = pipelineSources(pipeline.data);
  const now = useNow();
  const { list } = leads;
  const filtered = JSON.stringify(state.filters) !== JSON.stringify(NO_FILTERS);

  const changeFilters = (filters: LeadFilterValues) => change({ ...state, filters, page: 0 });
  const toFirstPage = () => change({ ...state, page: 0 });

  return (
    <div className="p-4">
      <PageHeader
        title="Leads"
        detail={list ? `${list.total} postings, ${ORDER_NOTE[settled.sort]}` : undefined}
      >
        {state.page > 0 && <NewLeadsPill count={list?.unseen.length ?? 0} onShow={toFirstPage} />}
      </PageHeader>
      <LeadFilters
        values={state.filters}
        sort={state.sort}
        sources={sources}
        onChange={changeFilters}
        onSort={(sort) => change({ ...state, sort, page: 0 })}
      />
      {/* A failed request keeps the rows of the last one that worked: dimmed and labelled. */}
      {leads.error && list && (
        <div className="mb-3">
          <ErrorBanner error={leads.error} onRetry={leads.reload}>
            The rows below are from the last list that loaded and may not match these filters.
          </ErrorBanner>
        </div>
      )}
      <div className="card !p-0" aria-busy={leads.loading}>
        {leads.error && !list ? (
          <ErrorState error={leads.error} onRetry={leads.reload} />
        ) : !list ? (
          <Loading label="Loading leads…" />
        ) : list.items.length > 0 ? (
          <div className={leads.loading || leads.error ? 'opacity-60' : undefined}>
            <LeadsTable leads={list.items} sources={sources} fresh={list.fresh} now={now} />
            <Pagination
              page={state.page}
              total={list.total}
              onPage={(page) => change({ ...state, page })}
            />
          </div>
        ) : state.page > 0 ? (
          <Empty title="No leads on this page">
            <button type="button" className="btn" onClick={toFirstPage}>
              Go to the first page
            </button>
          </Empty>
        ) : (
          <Empty title={filtered ? 'No leads match these filters' : 'No leads yet'}>
            {filtered ? (
              <button type="button" className="btn" onClick={() => changeFilters(NO_FILTERS)}>
                Clear filters
              </button>
            ) : (
              'Start a run from the Pipeline page; postings show up here as soon as they pass the filter.'
            )}
          </Empty>
        )}
      </div>
    </div>
  );
}
