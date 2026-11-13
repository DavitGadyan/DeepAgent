'use client';
import { Table2 } from 'lucide-react';
import { useState } from 'react';
import { dayTotal } from '@/lib/cost';
import { formatUsd, formatWeekday } from '@/lib/format';
import type { CostDay } from '@/lib/types';
import { Segmented } from '@/components/ui/Segmented';
import { Empty } from '@/components/ui/States';
import { DailySpendChart } from './DailySpendChart';
import { SERIES, SeriesKey } from './series';

export const RANGES = [7, 30, 90] as const;
export type RangeDays = (typeof RANGES)[number];

const RANGE_OPTIONS = RANGES.map((days) => ({ value: days, label: `${days} days` }));

/** Says which fill is which; needed because two series share the bars. */
function Legend() {
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1 text-[0.76rem] text-soft">
      {SERIES.map((series) => (
        <li key={series.key} className="flex items-center gap-1.5">
          <SeriesKey series={series} />
          <span>
            <span className="font-semibold text-body">{series.label}</span>: {series.note}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The chart's figures as text, newest day first; days without spend are left out. */
function SpendTable({ days }: { days: CostDay[] }) {
  const spent = days.filter((day) => dayTotal(day) > 0).reverse();
  return (
    <div className="max-h-80 overflow-auto">
      <table className="tbl tabular-nums">
        <caption className="sr-only">Spend per day; days without spend are left out</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th className="!text-right">Console key (billed)</th>
            <th className="!text-right">Claude login</th>
            <th className="!text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {spent.map((day) => (
            <tr key={day.date}>
              <td className="whitespace-nowrap">{formatWeekday(day.date)}</td>
              <td className="text-right">{formatUsd(day.console_usd)}</td>
              <td className="text-right">{formatUsd(day.login_usd)}</td>
              <td className="text-right font-semibold text-fg">{formatUsd(dayTotal(day))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Spend per day for the chosen range, as a chart or as the same figures in a
 * table. The range belongs to this card only: the tiles above have their own
 * fixed periods and the breakdowns below are all-time.
 */
export function DailySpend({
  days,
  range,
  loading,
  onRange,
}: {
  days: CostDay[];
  range: RangeDays;
  /** A new range is on its way: the old chart stays, dimmed. */
  loading: boolean;
  onRange: (range: RangeDays) => void;
}) {
  const [asTable, setAsTable] = useState(false);
  const empty = days.every((day) => dayTotal(day) === 0);

  return (
    <section className="card grid gap-3" aria-busy={loading}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="card__title !mb-0">Daily spend</h2>
        <div className="flex items-center gap-2">
          <Segmented label="Days shown" value={range} options={RANGE_OPTIONS} onChange={onRange} />
          <button
            type="button"
            className="btn"
            aria-pressed={asTable}
            onClick={() => setAsTable(!asTable)}
          >
            <Table2 size={14} aria-hidden="true" />
            Table
          </button>
        </div>
      </div>
      <Legend />
      <div className={loading ? 'opacity-60' : undefined}>
        {empty ? (
          <Empty title={`No spend in the last ${range} days`}>
            Tailor CV and Apply start Claude Code sessions; what they cost shows up here.
          </Empty>
        ) : asTable ? (
          <SpendTable days={days} />
        ) : (
          <DailySpendChart days={days} />
        )}
      </div>
    </section>
  );
}
