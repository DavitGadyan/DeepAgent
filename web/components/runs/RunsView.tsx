'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { formatDateTime, formatDuration, formatLimitPerSource } from '@/lib/format';
import type { Run } from '@/lib/types';
import { useApi } from '@/lib/useApi';
import { RunStatusPill } from '@/components/ui/badges';
import { PageHeader } from '@/components/ui/PageHeader';
import { Empty, ErrorState, Loading } from '@/components/ui/States';

const runHref = (run: Run) => `/?run=${encodeURIComponent(run.id)}`;

/** A finished run's length; a running one has none yet. */
const runDuration = (run: Run) =>
  run.finished_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : null;

function RunsTable({ runs }: { runs: Run[] }) {
  const router = useRouter();
  return (
    <div className="overflow-x-auto">
      <table className="tbl tabular-nums">
        <thead>
          <tr>
            <th>Started</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Discovered</th>
            <th>Dropped</th>
            <th>Failed</th>
            <th>Scored</th>
            <th>Researched</th>
            <th>In flight</th>
            <th>Options</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id} data-link onClick={() => router.push(runHref(run))}>
              <td>
                <Link
                  href={runHref(run)}
                  className="font-semibold text-fg hover:underline"
                  onClick={(click) => click.stopPropagation()}
                >
                  {formatDateTime(run.started_at)}
                </Link>
              </td>
              <td>
                <RunStatusPill status={run.status} />
              </td>
              <td>{formatDuration(runDuration(run))}</td>
              <td>{run.stats.discovered}</td>
              <td>{run.stats.dropped}</td>
              <td className={run.stats.failed ? 'text-danger' : undefined}>{run.stats.failed}</td>
              <td>{run.stats.scored}</td>
              <td>{run.stats.researched}</td>
              <td>{run.stats.in_flight}</td>
              <td className="text-muted">
                {formatLimitPerSource(run.options.limit_per_source)}
                {run.options.force ? ', forced' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The Runs page: every run, newest first; a row opens the Pipeline page on that run. */
export function RunsView() {
  const runs = useApi('runs', api.runs);
  return (
    <div className="p-4">
      <PageHeader title="Runs" detail="Open a run to replay it on the pipeline graph." />
      <div className="card !p-0">
        {runs.error && !runs.data ? (
          <ErrorState error={runs.error} onRetry={runs.reload} />
        ) : !runs.data ? (
          <Loading label="Loading runs…" />
        ) : runs.data.length === 0 ? (
          <Empty title="No runs yet">Start the first one from the Pipeline page.</Empty>
        ) : (
          <RunsTable runs={runs.data} />
        )}
      </div>
    </div>
  );
}
