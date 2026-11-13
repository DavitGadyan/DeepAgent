'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { pipelineWorkers } from '@/lib/pipeline/stages';
import { useApi } from '@/lib/useApi';
import { ErrorState, Loading } from '@/components/ui/States';
import { RunBar } from './RunBar';
import { RunStage } from './RunStage';

/** How often the selected run's stats are re-read while it is running. */
const STATS_POLL_MS = 2000;

/**
 * The Pipeline page: run bar, live graph with its side panel, time scrubber.
 * The run shown is `?run=<id>`, or the latest run when the URL names none, in
 * which case a newly started run takes over the view.
 */
export function PipelineView() {
  const router = useRouter();
  const requestedRun = useSearchParams().get('run');
  const pipeline = useApi('pipeline', api.pipeline);
  const runs = useApi('runs', api.runs);

  const selected = runs.data?.find((run) => run.id === requestedRun) ?? runs.data?.[0];
  const running = selected?.status === 'running';
  const refreshRuns = runs.refresh;
  const refreshPipeline = pipeline.refresh;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(refreshRuns, STATS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, refreshRuns]);

  const error = pipeline.error ?? runs.error;
  if (error && (!pipeline.data || !runs.data)) {
    const retry = () => {
      pipeline.reload();
      runs.reload();
    };
    return <ErrorState error={error} onRetry={retry} />;
  }
  if (!pipeline.data || !runs.data) return <Loading label="Loading the pipeline…" />;

  return (
    <div className="flex h-full min-h-[38rem] flex-col gap-3 p-3">
      <RunBar
        runs={runs.data}
        selected={selected}
        workers={pipelineWorkers(pipeline.data.nodes)}
        onSelect={(runId) => router.push(`/?run=${encodeURIComponent(runId)}`)}
        onStopped={refreshRuns}
        onStarted={() => {
          refreshRuns();
          // A run can change the worker count: the graph needs the new rows.
          refreshPipeline();
          router.push('/');
        }}
      />
      <RunStage
        key={selected?.id ?? 'no-run'}
        pipeline={pipeline.data}
        run={selected ?? null}
        onRunBoundary={refreshRuns}
      />
    </div>
  );
}
