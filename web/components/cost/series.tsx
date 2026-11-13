/**
 * The two kinds of spend the daily chart stacks, in drawing order from the
 * baseline up: what is really billed sits on the baseline, where the days
 * compare best.
 */
export const SERIES = [
  { key: 'console', field: 'console_usd', label: 'Console API key', note: 'billed' },
  {
    key: 'login',
    field: 'login_usd',
    label: 'Claude login',
    note: 'API-price equivalent, counts against your plan',
  },
] as const;

export type Series = (typeof SERIES)[number];

/** The colour-and-fill key of a series; the legend and the tooltip use the bar's own look. */
export function SeriesKey({ series }: { series: Series }) {
  return <span className="series series-key" data-series={series.key} aria-hidden="true" />;
}
