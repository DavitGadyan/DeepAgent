'use client';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import type { RunWindow } from '@/lib/pipeline/eventLog';
import { EMPTY_NODE, reduceAll } from '@/lib/pipeline/reducer';
import type { Pipeline } from '@/lib/types';
import { useNow, useReplay } from '@/lib/useReplay';
import { useRunEvents } from '@/lib/useRunEvents';
import { InlineError } from '@/components/ui/States';
import { NodePanel } from './NodePanel';
import { TimeScrubber } from './TimeScrubber';

/** React Flow measures the DOM, so the canvas is loaded on the client only. */
const PipelineFlow = dynamic(() => import('./PipelineFlow'), {
  ssr: false,
  loading: () => <div className="mm__stage" aria-hidden="true" />,
});

/**
 * The graph, side panel and time scrubber for one run. Mounted with
 * `key={run.id}` so switching runs starts from a clean log and a live cursor.
 */
export function RunStage({
  pipeline,
  run,
  onRunBoundary,
}: {
  pipeline: Pipeline;
  run: RunWindow | null;
  onRunBoundary: () => void;
}) {
  const log = useRunEvents(run, onRunBoundary);
  const replay = useReplay(log.events.length);
  const [selected, setSelected] = useState<string | null>(null);
  const wallClock = useNow(500, replay.live);

  const state = useMemo(
    () => reduceAll(log.events.slice(0, replay.position)),
    [log.events, replay.position],
  );
  const now = replay.live ? wallClock + log.clockSkewMs : (state.lastTs ?? 0);

  const selectedNode = pipeline.nodes.find((node) => node.id === selected);

  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setSelected(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  return (
    <>
      <div className="mm relative min-h-0 flex-1">
        <PipelineFlow
          pipeline={pipeline}
          state={state}
          now={now}
          selected={selected}
          onSelect={setSelected}
        />
        {selectedNode && (
          <NodePanel
            node={selectedNode}
            state={state.nodes[selectedNode.id] ?? EMPTY_NODE}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
      {log.error && (
        <div className="flex items-center gap-3">
          <InlineError error={log.error} />
          <button type="button" className="btn" onClick={log.retry}>
            Retry
          </button>
        </div>
      )}
      <TimeScrubber events={log.events} replay={replay} stream={log.stream} />
    </>
  );
}
