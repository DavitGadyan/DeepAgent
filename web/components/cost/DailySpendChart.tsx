'use client';
import { type KeyboardEvent, useState } from 'react';
import { axisScale, dayTotal, formatAxisUsd, labelledDays } from '@/lib/cost';
import { formatDay, formatUsd, formatWeekday } from '@/lib/format';
import type { CostDay } from '@/lib/types';
import { SERIES, SeriesKey } from './series';

const KEY_STEPS: Record<string, (index: number, last: number) => number> = {
  ArrowLeft: (index) => Math.max(0, index - 1),
  ArrowRight: (index, last) => Math.min(last, index + 1),
  Home: () => 0,
  End: (_, last) => last,
};

const readout = (day: CostDay) =>
  `${formatWeekday(day.date)}: ${formatUsd(dayTotal(day))} in total; ` +
  SERIES.map((series) => `${formatUsd(day[series.field])} ${series.label}`).join('; ');

/** One day's figures beside its bar; the total leads, then each series with its key. */
function DayTip({ day, index, count }: { day: CostDay; index: number; count: number }) {
  const centre = ((index + 0.5) / count) * 100;
  // On the side of the bar that has room, so the card never leaves the plot.
  const side =
    centre < 50
      ? { left: `${centre}%`, transform: 'translateX(0.75rem)' }
      : { right: `${100 - centre}%`, transform: 'translateX(-0.75rem)' };
  return (
    <div className="spend__tip" style={side} aria-hidden="true">
      <p className="text-muted">{formatWeekday(day.date)}</p>
      <p className="text-base font-semibold text-fg">{formatUsd(dayTotal(day))}</p>
      <ul className="mt-1 grid gap-0.5">
        {SERIES.map((series) => (
          <li key={series.key} className="flex items-center gap-1.5">
            <SeriesKey series={series} />
            <span className="font-semibold text-fg">{formatUsd(day[series.field])}</span>
            <span className="text-muted">{series.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Spend per day as stacked bars: Console-key spend on the baseline, Claude-login
 * spend (hatched) on top. Hover a day, or focus the chart and use the arrow
 * keys, for its figures; the table view next to the chart has them all.
 */
export function DailySpendChart({ days }: { days: CostDay[] }) {
  const [active, setActive] = useState<number | null>(null);
  const scale = axisScale(Math.max(...days.map(dayTotal)));
  const labelled = labelledDays(days.length);
  const tickLabels = scale.ticks.map((tick) => formatAxisUsd(tick, scale.step));
  const axisWidth = Math.max(...tickLabels.map((label) => label.length)) + 1.5;
  const share = (value: number) => `${(value / scale.max) * 100}%`;
  // The range can shrink while a day near the old end is still the active one.
  const shown = active === null ? undefined : days[active];
  const at = shown ? active : null;

  const onKey = (press: KeyboardEvent) => {
    const step = KEY_STEPS[press.key];
    if (!step) return;
    press.preventDefault();
    setActive(step(at ?? days.length - 1, days.length - 1));
  };

  return (
    <div className="spend">
      <div className="spend__axis" style={{ width: `${axisWidth}ch` }} aria-hidden="true">
        {scale.ticks.map((tick, index) => (
          <span key={tick} style={{ bottom: share(tick) }}>
            {tickLabels[index]}
          </span>
        ))}
      </div>
      <div
        className="spend__plot"
        role="group"
        aria-label="Daily spend chart. The left and right arrow keys read one day at a time."
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setActive((current) => current ?? days.length - 1)}
        onBlur={() => setActive(null)}
        onPointerLeave={() => setActive(null)}
      >
        {scale.ticks.map((tick) => (
          <div
            key={tick}
            className="spend__grid"
            data-baseline={tick === 0 ? '' : undefined}
            style={{ bottom: share(tick) }}
          />
        ))}
        <div className="spend__days">
          {days.map((day, index) => (
            <div
              key={day.date}
              className="spend__day"
              data-active={index === at ? '' : undefined}
              onPointerEnter={() => setActive(index)}
            >
              <div className="spend__bar">
                {SERIES.filter((series) => day[series.field] > 0).map((series) => (
                  <div
                    key={series.key}
                    className="series spend__seg"
                    data-series={series.key}
                    style={{ height: share(day[series.field]) }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        {shown && at !== null && <DayTip day={shown} index={at} count={days.length} />}
        <p className="sr-only" aria-live="polite">
          {shown ? readout(shown) : ''}
        </p>
      </div>
      <div className="spend__dates" aria-hidden="true">
        {days.map((day, index) => (
          <span key={day.date}>{labelled[index] && <i>{formatDay(day.date)}</i>}</span>
        ))}
      </div>
    </div>
  );
}
