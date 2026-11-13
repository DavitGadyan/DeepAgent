import { Search } from 'lucide-react';
import type { LeadFilterValues } from '@/lib/leadFilters';
import type { SourceInfo } from '@/lib/sources';
import { LEAD_STATUSES, type LeadSort, type LeadStatus } from '@/lib/types';
import { leadStatusLabel } from '@/components/ui/badges';
import { Segmented } from '@/components/ui/Segmented';
import { DateRangeFilter } from './DateRangeFilter';

const SORTS: { value: LeadSort; label: string }[] = [
  { value: 'newest', label: 'Newest' },
  { value: 'score', label: 'Best score' },
];

/** The filter bar of the Leads page, with the sort switch at its end. */
export function LeadFilters({
  values,
  sort,
  sources,
  onChange,
  onSort,
}: {
  values: LeadFilterValues;
  sort: LeadSort;
  sources: SourceInfo[];
  onChange: (values: LeadFilterValues) => void;
  onSort: (sort: LeadSort) => void;
}) {
  const set = <K extends keyof LeadFilterValues>(key: K, value: LeadFilterValues[K]) =>
    onChange({ ...values, [key]: value });

  return (
    <div className="card mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 !py-2.5">
      <label className="relative min-w-48 flex-1">
        <span className="sr-only">Search title or company</span>
        <Search
          size={14}
          className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
          aria-hidden="true"
        />
        <input
          type="search"
          className="field w-full !pl-8"
          placeholder="Search title or company"
          value={values.search}
          onChange={(change) => set('search', change.target.value)}
        />
      </label>
      <label className="flex items-center gap-2">
        <span className="label">Min score</span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={values.minScore}
          onChange={(change) => set('minScore', Number(change.target.value))}
        />
        <output className="w-6 text-right font-semibold tabular-nums">{values.minScore}</output>
      </label>
      <label className="flex items-center gap-2">
        <span className="label">Status</span>
        <select
          className="field"
          value={values.status}
          onChange={(change) => set('status', change.target.value as LeadStatus | '')}
        >
          <option value="">Any</option>
          {LEAD_STATUSES.map((status) => (
            <option key={status} value={status}>
              {leadStatusLabel(status)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="label">Source</span>
        <select
          className="field"
          value={values.source}
          onChange={(change) => set('source', change.target.value)}
        >
          <option value="">Any</option>
          {sources.map((source) => (
            <option key={source.name} value={source.name}>
              {source.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-[0.8rem]">
        <input
          type="checkbox"
          checked={values.remoteOnly}
          onChange={(change) => set('remoteOnly', change.target.checked)}
        />
        Remote only
      </label>
      <DateRangeFilter values={values} onChange={onChange} />
      <div className="ml-auto">
        <Segmented label="Sort leads by" value={sort} options={SORTS} onChange={onSort} />
      </div>
    </div>
  );
}
