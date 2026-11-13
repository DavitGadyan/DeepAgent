import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatUsd } from '@/lib/format';
import type { CostReport, CostSlice } from '@/lib/types';
import { leadHref } from '@/components/leads/LeadsTable';

function BreakdownCard({
  title,
  empty,
  children,
}: {
  title: string;
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <h3 className="card__title">{title}</h3>
      {empty ? (
        <p className="text-[0.8rem] text-muted">No sessions yet.</p>
      ) : (
        <div className="overflow-x-auto">{children}</div>
      )}
    </section>
  );
}

function SliceTable({ heading, slices }: { heading: string; slices: CostSlice[] }) {
  return (
    <table className="tbl tabular-nums">
      <thead>
        <tr>
          <th>{heading}</th>
          <th className="!text-right">Sessions</th>
          <th className="!text-right">Total</th>
          <th className="!text-right">Billed</th>
        </tr>
      </thead>
      <tbody>
        {slices.map((slice) => (
          <tr key={slice.key}>
            <td className="text-fg">{slice.label}</td>
            <td className="text-right">{slice.sessions}</td>
            <td className="text-right font-semibold text-fg">{formatUsd(slice.usd)}</td>
            <td className="text-right">{formatUsd(slice.billed_usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TopLeads({ leads }: { leads: CostReport['top_leads'] }) {
  return (
    <table className="tbl tabular-nums">
      <thead>
        <tr>
          <th>Lead</th>
          <th className="!text-right">Sessions</th>
          <th className="!text-right">Total</th>
        </tr>
      </thead>
      <tbody>
        {leads.map((lead) => (
          <tr key={lead.job_id}>
            <td className="max-w-64">
              <Link
                href={leadHref(lead.job_id)}
                className="block truncate font-semibold text-fg hover:underline"
              >
                {lead.title || lead.job_id}
              </Link>
            </td>
            <td className="text-right">{lead.sessions}</td>
            <td className="text-right font-semibold text-fg">{formatUsd(lead.usd)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Where the money went, over all time: per action, model and sign-in, and per lead. */
export function Breakdowns({ report }: { report: CostReport }) {
  return (
    <section className="grid gap-3" aria-labelledby="cost-breakdown">
      <h2 id="cost-breakdown" className="mt-4 text-[1rem] font-semibold text-fg">
        Where it went <span className="font-normal text-muted">(all time)</span>
      </h2>
      <div className="grid gap-3 md:grid-cols-2">
        <BreakdownCard title="By action" empty={report.by_action.length === 0}>
          <SliceTable heading="Action" slices={report.by_action} />
        </BreakdownCard>
        <BreakdownCard title="By access" empty={report.by_access.length === 0}>
          <SliceTable heading="Sign-in" slices={report.by_access} />
        </BreakdownCard>
        <BreakdownCard title="By model" empty={report.by_model.length === 0}>
          <SliceTable heading="Model" slices={report.by_model} />
        </BreakdownCard>
        <BreakdownCard title="Most expensive leads" empty={report.top_leads.length === 0}>
          <TopLeads leads={report.top_leads} />
        </BreakdownCard>
      </div>
    </section>
  );
}
