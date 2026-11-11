import { X } from 'lucide-react';
import { formatDuration, formatTime } from '@/lib/format';
import { eventNote, eventScore, eventSubject } from '@/lib/pipeline/eventData';
import { KIND_LABEL } from '@/lib/pipeline/kinds';
import type { NodeState } from '@/lib/pipeline/reducer';
import type { PipelineEvent, PipelineNode } from '@/lib/types';
import { ScoreBadge } from '@/components/ui/badges';

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

function Counters({ node, state }: { node: PipelineNode; state: NodeState }) {
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
      {(['in', 'out', 'dropped', 'failed'] as const).map((counter) => (
        <div key={counter}>
          <dt>{counter}</dt>
          <dd>{state[counter]}</dd>
        </div>
      ))}
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

/** Details of the selected node, over the right edge of the stage: what it is, its counters, its latest events. */
export function NodePanel({
  node,
  state,
  onClose,
}: {
  node: PipelineNode;
  state: NodeState;
  onClose: () => void;
}) {
  return (
    <aside className="tg__panel" aria-labelledby="node-panel-title" data-kind={node.kind}>
      <p className="tg__group">
        {KIND_LABEL[node.kind]} · {state.status}
        {!node.enabled && ' · disabled'}
      </p>
      <h2 id="node-panel-title" className="tg__ptitle">
        {node.label}
      </h2>
      <p className="tg__psub">{node.description}</p>
      <Counters node={node} state={state} />
      <h3 className="label mt-4">Recent events ({state.events.length})</h3>
      {state.events.length ? (
        <ol className="tg__log">
          {state.events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </ol>
      ) : (
        <p className="tg__hint py-3">No events at this point of the run.</p>
      )}
      <button type="button" className="tg__close" aria-label="Close details" onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
