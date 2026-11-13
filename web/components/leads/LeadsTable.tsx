'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatAgo, formatDate, formatDateTime, humanize } from '@/lib/format';
import { type SourceInfo, sourceLabel } from '@/lib/sources';
import type { LeadSummary } from '@/lib/types';
import { LeadStatusPill, ScoreBadge } from '@/components/ui/badges';

export const leadHref = (jobId: string) => `/leads/${encodeURIComponent(jobId)}`;

/**
 * One page of leads. The whole row is clickable; the title is the real link for
 * keyboards. Rows in `fresh` were just pushed in and carry a "New" mark.
 */
export function LeadsTable({
  leads,
  sources,
  fresh,
  now,
}: {
  leads: LeadSummary[];
  sources: SourceInfo[];
  /** Job ids of the rows that arrived a moment ago. */
  fresh: Record<string, number>;
  /** The current time (ms), for "3 h ago". */
  now: number;
}) {
  const router = useRouter();
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Score</th>
            <th>Title</th>
            <th>Company</th>
            <th>Location</th>
            <th>Remote</th>
            <th>Seniority</th>
            <th>Source</th>
            <th>Status</th>
            <th>Found</th>
            <th>Posted</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => (
            <tr
              key={lead.job_id}
              data-link
              data-new={lead.job_id in fresh ? '' : undefined}
              onClick={() => router.push(leadHref(lead.job_id))}
            >
              <td>
                <ScoreBadge score={lead.score} />
              </td>
              <td className="max-w-72">
                <span className="flex items-center gap-2">
                  <Link
                    href={leadHref(lead.job_id)}
                    className="min-w-0 truncate font-semibold text-fg hover:underline"
                    onClick={(click) => click.stopPropagation()}
                  >
                    {lead.title}
                  </Link>
                  {lead.job_id in fresh && (
                    <span className="chip shrink-0" data-tone="good">
                      New
                    </span>
                  )}
                </span>
              </td>
              <td className="max-w-44 truncate">{lead.company}</td>
              <td className="max-w-44 truncate text-soft">{lead.location || '—'}</td>
              <td className="text-soft">{humanize(lead.remote_policy)}</td>
              <td className="text-soft">{humanize(lead.seniority)}</td>
              <td className="text-soft">{sourceLabel(sources, lead.source)}</td>
              <td>
                <LeadStatusPill status={lead.status} />
              </td>
              <td className="whitespace-nowrap text-soft" title={formatDateTime(lead.created_at)}>
                {formatAgo(lead.created_at, now)}
              </td>
              <td className="whitespace-nowrap text-soft">{formatDate(lead.posted_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
