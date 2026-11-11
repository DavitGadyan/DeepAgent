'use client';
import { useEffect, useState } from 'react';
import { type ApiError, api, toApiError } from './api';
import { belongsToRun, mergeEvents, type RunWindow } from './pipeline/eventLog';
import type { PipelineEvent } from './types';
import { type StreamStatus, useEventStream } from './useEventStream';

export interface RunEvents {
  /**
   * The run's log so far, oldest first: its stored history, the applier's
   * work since the run started, and what the stream added.
   */
  events: PipelineEvent[];
  loading: boolean;
  error: ApiError | null;
  stream: StreamStatus;
  /** Orchestrator clock minus this browser's clock, from the latest streamed event. */
  clockSkewMs: number;
  retry: () => void;
}

/** The stored history of the run and the applier events since it started. */
async function fetchLog(run: RunWindow): Promise<PipelineEvent[]> {
  const [history, applier] = await Promise.all([
    api.runEvents(run.id),
    api.events({ agent: 'applier', since: run.started_at }),
  ]);
  return [...history, ...applier];
}

/**
 * The event log of one run, kept current over SSE. The stored events are
 * fetched again whenever the stream (re)connects, so nothing emitted during a
 * dropped connection is lost. `onRunBoundary` fires when any run starts or ends.
 */
export function useRunEvents(run: RunWindow | null, onRunBoundary: () => void): RunEvents {
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [loadedRun, setLoadedRun] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [clockSkewMs, setClockSkewMs] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const runId = run?.id ?? null;
  const startedAt = run?.started_at ?? null;

  const stream = useEventStream((event) => {
    setClockSkewMs(Date.parse(event.ts) - Date.now());
    if (event.type === 'run.started' || event.type === 'run.finished') onRunBoundary();
    if (belongsToRun(event, run)) setEvents((prev) => mergeEvents(prev, [event]));
  });

  useEffect(() => {
    if (runId === null || startedAt === null) return;
    const selected = { id: runId, started_at: startedAt };
    let stale = false;
    fetchLog(selected).then(
      (stored) => {
        if (stale) return;
        const inRun = stored.filter((event) => belongsToRun(event, selected));
        setEvents((streamed) => mergeEvents(streamed, inRun));
        setLoadedRun(runId);
        setError(null);
      },
      (reason: unknown) => !stale && setError(toApiError(reason)),
    );
    return () => {
      stale = true;
    };
  }, [runId, startedAt, attempt, stream]);

  return {
    events,
    loading: runId !== null && loadedRun !== runId && error === null,
    error,
    stream,
    clockSkewMs,
    retry: () => {
      setError(null);
      setAttempt((n) => n + 1);
    },
  };
}
