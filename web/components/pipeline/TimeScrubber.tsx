import { Pause, Play, Radio } from 'lucide-react';
import { formatTime } from '@/lib/format';
import type { PipelineEvent } from '@/lib/types';
import type { StreamStatus } from '@/lib/useEventStream';
import type { Replay } from '@/lib/useReplay';

/** 'scorer · item.finished · ML Engineer @ Acme' for the event the cursor sits on. */
function describe(event: PipelineEvent | undefined): string {
  if (!event) return 'Start of the run';
  return [event.agent, event.type, event.title].filter(Boolean).join(' · ');
}

/**
 * Range slider over the run's event log. Dragging pins the graph to that
 * moment; Play steps forward from there; Live follows the end of the log.
 */
export function TimeScrubber({
  events,
  replay,
  stream,
}: {
  events: PipelineEvent[];
  replay: Replay;
  stream: StreamStatus;
}) {
  const shown = events[replay.position - 1];
  const empty = events.length === 0;

  return (
    <div className="card flex flex-wrap items-center gap-3 !py-2.5">
      <button
        type="button"
        className="btn btn--icon"
        onClick={replay.togglePlay}
        disabled={empty}
        aria-label={
          replay.playing ? 'Pause replay' : replay.live ? 'Replay from the start' : 'Play from here'
        }
      >
        {replay.playing ? (
          <Pause size={14} aria-hidden="true" />
        ) : (
          <Play size={14} aria-hidden="true" />
        )}
      </button>
      <input
        type="range"
        className="min-w-40 flex-1"
        min={0}
        max={events.length}
        value={replay.position}
        disabled={empty}
        onChange={(change) => replay.seek(Number(change.target.value))}
        aria-label="Moment of the run"
        aria-valuetext={shown ? `${formatTime(shown.ts)}, ${describe(shown)}` : describe(shown)}
      />
      <div className="w-64 min-w-0 text-[0.74rem] leading-tight">
        <p className="font-semibold text-fg tabular-nums">
          {shown ? formatTime(shown.ts) : '--:--:--'}
          <span className="ml-2 font-normal text-muted">
            event {replay.position} of {events.length}
          </span>
        </p>
        <p className="truncate text-muted" title={describe(shown)}>
          {empty ? 'No events yet' : describe(shown)}
        </p>
      </div>
      <button
        type="button"
        className="btn"
        aria-pressed={replay.live}
        onClick={replay.goLive}
        title={
          stream === 'open'
            ? 'Follow new events as they arrive'
            : 'Event stream disconnected; reconnecting'
        }
      >
        <Radio size={14} className={stream === 'open' ? 'text-accent' : 'text-warn'} aria-hidden />
        {stream === 'open' ? 'Live' : 'Live (reconnecting)'}
      </button>
    </div>
  );
}
