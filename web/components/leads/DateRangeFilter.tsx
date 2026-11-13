import {
  FOUND_RANGES,
  type FoundRange,
  type LeadFilterValues,
  rangeError,
} from '@/lib/leadFilters';

/**
 * When LeadScout found the posting: a window ending now, or a custom range of
 * days. Many sources give no posting date, so the found date is what filters.
 */
export function DateRangeFilter({
  values,
  onChange,
}: {
  values: LeadFilterValues;
  onChange: (values: LeadFilterValues) => void;
}) {
  const error = rangeError(values);
  /** Leaving "Custom" drops its days, so they do not count as a filter that is still set. */
  const choose = (found: FoundRange) =>
    onChange(found === 'custom' ? { ...values, found } : { ...values, found, from: '', to: '' });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2">
        <span className="label">Found</span>
        <select
          className="field"
          value={values.found}
          onChange={(change) => choose(change.target.value as FoundRange)}
        >
          {FOUND_RANGES.map((range) => (
            <option key={range.value} value={range.value}>
              {range.label}
            </option>
          ))}
        </select>
      </label>
      {values.found === 'custom' && (
        <>
          <label className="flex items-center gap-2">
            <span className="label">From</span>
            <input
              type="date"
              className="field"
              max={values.to || undefined}
              aria-invalid={error ? true : undefined}
              value={values.from}
              onChange={(change) => onChange({ ...values, from: change.target.value })}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="label">To</span>
            <input
              type="date"
              className="field"
              min={values.from || undefined}
              aria-invalid={error ? true : undefined}
              value={values.to}
              onChange={(change) => onChange({ ...values, to: change.target.value })}
            />
          </label>
          {error && (
            <p role="alert" className="text-[0.76rem] text-danger">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
