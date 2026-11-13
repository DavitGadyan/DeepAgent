import { X } from 'lucide-react';
import { formatDuration, formatTime } from '@/lib/format';
import { eventNote, eventScore, eventSubject } from '@/lib/pipeline/eventData';
import { KIND_LABEL } from '@/lib/pipeline/kinds';
import type { NodeState } from '@/lib/pipeline/reducer';
import type { Thread } from '@/lib/pipeline/threads';
import type { PipelineEvent, PipelineNode } from '@/lib/types';
import { ScoreBadge } from '@/components/ui/badges';
import { OrbitGraph } from './OrbitGraph';

/** 'item.finished' -> 'finished', 'scout.done' -> 'done'. */
const shortType = (type: string) => type.slice(type.indexOf('.') + 1);

function EventRow({ event }: { event: PipelineEvent }) {
  const score = eventScore(event);
  const note = eventNote(event);
  return (
    <li className="tg__event" data-type={event.type}>
      <time dateTime={event.ts}>{formatTime(event.ts)}</time>
      <span className="tg__subject" title={eventSubject(event)}>
        <b className="font-semibold">{shortType(event.type)}</b> {eventSubject(event)}
      </span>
      <span className="tg__dur">
        {score !== null && <ScoreBadge score={score} />}{' '}
        {event.duration_ms !== null && formatDuration(event.duration_ms)}
      </span>
      {note && <span className="tg__note">{note}</span>}
    </li>
  );
}

const COUNTERS = ['in', 'out', 'dropped', 'failed'] as const;

/** "in 12 · out 9 · dropped 2 · failed 1" for all workers of the agent together. */
const totalsLine = (totals: NodeState) =>
  COUNTERS.map((counter) => `${counter} ${totals[counter]}`).join(' · ');

function Counters({
  node,
  state,
  totals,
  waiting,
}: {
  node: PipelineNode;
  state: NodeState;
  totals: NodeState | null;
  waiting: number | null;
}) {
  if (node.kind === 'source') {
    return (
      <dl className="tg__dl">
        <div className="tg__wide">
          <dt>Postings found</dt>
          <dd>{state.count ?? '—'}</dd>
        </div>
      </dl>
    );
  }
  return (
    <dl className="tg__dl">
      {COUNTERS.map((counter) => (
        <div key={counter}>
          <dt>{counter}</dt>
          <dd>{state[counter]}</dd>
        </div>
      ))}
      {totals && (
        <div className="tg__wide">
          <dt>All workers</dt>
          <dd>{totalsLine(totals)}</dd>
        </div>
      )}
      {waiting !== null && (
        <div className="tg__wide">
          <dt>Waiting for a free worker</dt>
          <dd>{waiting}</dd>
        </div>
      )}
      <div className="tg__wide">
        <dt>Model</dt>
        <dd>{node.model || 'None: this node does not call a model'}</dd>
      </div>
      <div className="tg__wide">
        <dt>Current item</dt>
        <dd>{state.current || 'Nothing in progress'}</dd>
      </div>
      <div className="tg__wide">
        <dt>Last duration</dt>
        <dd>{formatDuration(state.lastDurationMs)}</dd>
      </div>
    </dl>
  );
}

/**
 * Details of the selected card, over the right edge of the stage: what it is,
 * what it does inside (its graph, with the step its thread is in), its
 * counters and its past events. For one worker of an agent with several, the
 * counters and events are that worker's and `totals` adds the agent's.
 */
export function NodePanel({
  node,
  nodeId,
  worker,
  state,
  totals,
  waiting,
  thread,
  onClose,
}: {
  node: PipelineNode;
  /** Id of the selected card. */
  nodeId: string;
  /** Which worker of the agent the card stands for; null for a single card. */
  worker: number | null;
  state: NodeState;
  /** All workers of the agent together. */
  totals: NodeState;
  /** Items in front of the agent that no worker has started; null for agents without a queue. */
  waiting: number | null;
  /** The thread the card holds, or held last. */
  thread: Thread | undefined;
  onClose: () => void;
}) {
  const oneOfMany = worker !== null && node.workers > 1;
  return (
    <aside className="tg__panel" aria-labelledby="node-panel-title" data-kind={node.kind}>
      <p className="tg__group">
        {KIND_LABEL[node.kind]} · {state.status}
        {!node.enabled && ' · disabled'}
      </p>
      <h2 id="node-panel-title" className="tg__ptitle">
        {node.label}
        {oneOfMany && <span className="text-muted"> · worker {worker}</span>}
      </h2>
      <p className="tg__psub">{node.description}</p>
      {/* One scroll area for everything under the title: the graph must not push the events out. */}
      <div className="tg__scroll">
        {node.kind !== 'source' && (
          <OrbitGraph node={node} nodeId={nodeId} state={state} thread={thread} />
        )}
        <Counters node={node} state={state} totals={oneOfMany ? totals : null} waiting={waiting} />
        <h3 className="label mt-4">Past events ({state.events.length})</h3>
        {state.events.length ? (
          <ol className="tg__log">
            {state.events.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </ol>
        ) : (
          <p className="tg__hint py-3">No events at this point of the run.</p>
        )}
      </div>
      <button type="button" className="tg__close" aria-label="Close details" onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
