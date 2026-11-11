'use client';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { pipelineSources } from '@/lib/sources';
import type { LeadQuery } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { useDebounced } from '@/lib/useDebounced';
import { PageHeader } from '@/components/ui/PageHeader';
import { Empty, ErrorBanner, ErrorState, Loading } from '@/components/ui/States';
import { LeadFilters, type LeadFilterValues, NO_FILTERS } from './LeadFilters';
import { LeadsTable } from './LeadsTable';

const PAGE_SIZE = 25;

const toQuery = (filters: LeadFilterValues, page: number): LeadQuery => ({
  min_score: filters.minScore || undefined,
  status: filters.status || undefined,
  source: filters.source || undefined,
  remote: filters.remoteOnly || undefined,
  q: filters.search.trim() || undefined,
  limit: PAGE_SIZE,
  offset: page * PAGE_SIZE,
});

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

/** The Leads page: every scored posting, best fit first, with filters and paging. */
export function LeadsView() {
  const [filters, setFilters] = useState(NO_FILTERS);
  const [page, setPage] = useState(0);
  const query = toQuery(useDebounced(filters, 250), page);
  const queryKey = JSON.stringify(query);

  const leads = useApi(`leads:${queryKey}`, () => api.leads(query));
  const pipeline = useApi('pipeline', api.pipeline);
  const sources = pipelineSources(pipeline.data);
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS);

  const changeFilters = (next: LeadFilterValues) => {
    setFilters(next);
    setPage(0);
  };

  return (
    <div className="p-4">
      <PageHeader
        title="Leads"
        detail={leads.data ? `${leads.data.total} postings, best fit first` : undefined}
      />
      <LeadFilters values={filters} sources={sources} onChange={changeFilters} />
      {/* A failed request keeps the rows of the last one that worked: dimmed and labelled. */}
      {leads.error && leads.data && (
        <div className="mb-3">
          <ErrorBanner error={leads.error} onRetry={leads.reload}>
            The rows below are from the last list that loaded and may not match these filters.
          </ErrorBanner>
        </div>
      )}
      <div className="card !p-0" aria-busy={leads.loading}>
        {leads.error && !leads.data ? (
          <ErrorState error={leads.error} onRetry={leads.reload} />
        ) : !leads.data ? (
          <Loading label="Loading leads…" />
        ) : leads.data.items.length === 0 ? (
          <Empty title={filtered ? 'No leads match these filters' : 'No leads yet'}>
            {filtered ? (
              <button type="button" className="btn" onClick={() => changeFilters(NO_FILTERS)}>
                Clear filters
              </button>
            ) : (
              'Start a run from the Pipeline page; postings show up here once they are scored.'
            )}
          </Empty>
        ) : (
          <div className={leads.loading || leads.error ? 'opacity-60' : undefined}>
            <LeadsTable leads={leads.data.items} sources={sources} />
            <Pagination page={page} total={leads.data.total} onPage={setPage} />
          </div>
        )}
      </div>
    </div>
  );
}
