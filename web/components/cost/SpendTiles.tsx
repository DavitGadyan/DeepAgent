import { formatUsd } from '@/lib/format';
import type { CostAmount, CostReport } from '@/lib/types';

type Period = 'today' | 'last_7_days' | 'this_month' | 'all_time';

const TILES: { period: Period; label: string }[] = [
  { period: 'today', label: 'Today' },
  { period: 'last_7_days', label: 'Last 7 days' },
  { period: 'this_month', label: 'This month' },
  { period: 'all_time', label: 'All time' },
];

const sessions = (count: number) => `${count} ${count === 1 ? 'session' : 'sessions'}`;

function Tile({ label, amount }: { label: string; amount: CostAmount }) {
  return (
    <li className="card">
      <p className="label">{label}</p>
      {/* Proportional figures: equal-width digits look loose at this size. */}
      <p className="mt-1 text-2xl font-semibold text-fg">{formatUsd(amount.usd)}</p>
      <p className="mt-1 text-[0.76rem] text-muted tabular-nums">
        {formatUsd(amount.billed_usd)} billed · {sessions(amount.sessions)}
      </p>
    </li>
  );
}

/** The four headline figures, and what "billed" means next to them. */
export function SpendTiles({ report }: { report: CostReport }) {
  return (
    <section aria-label="Spend" className="grid gap-2">
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map(({ period, label }) => (
          <Tile key={period} label={label} amount={report[period]} />
        ))}
      </ul>
      <p className="text-[0.76rem] leading-relaxed text-muted">
        Every amount is Claude Code&apos;s own figure for its sessions, at API prices.{' '}
        <span className="font-semibold text-soft">Billed</span> is the part paid with your Console
        API key. The rest ran on your Claude login: an API-price equivalent that counts against your
        plan, not a charge.
      </p>
    </section>
  );
}
