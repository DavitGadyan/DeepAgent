'use client';
import { createPortal } from 'react-dom';
import type { Placement } from '@/lib/pipeline/placement';
import {
  describeThread,
  type Rank,
  shortId,
  type Thread,
  threadFields,
  type ThreadStatus,
} from '@/lib/pipeline/threads';
import { THREAD_CARD_ID } from './FlowView';

const TONE: Record<ThreadStatus, string> = {
  running: 'busy',
  waiting: 'warn',
  done: 'good',
  dropped: 'neutral',
  failed: 'bad',
};

/**
 * The hover card of a thread: its id, title and company, where it is, and the
 * facts the agents added so far, each with the agent that added it.
 *
 * Rendered into <body> with a fixed position: inside the canvas it would be
 * scaled with the zoom and cut off at the edge of the stage. It is read-only
 * (the pointer passes through it), so it can never keep itself open.
 */
export function ThreadCard({
  thread,
  rank,
  place,
  labelOf,
}: {
  thread: Thread;
  rank: Rank | undefined;
  place: Placement;
  /** Agent id -> its name on the graph. */
  labelOf: (agent: string) => string;
}) {
  const fields = threadFields(thread, rank);
  return createPortal(
    <div id={THREAD_CARD_ID} role="tooltip" className="tc" style={place}>
      <div className="tc__head">
        <code className="tc__id" title={thread.id}>
          {shortId(thread.id)}
        </code>
        <span className="pill" data-tone={TONE[thread.status]}>
          {thread.status}
        </span>
      </div>
      <p className="tc__title">{thread.title}</p>
      {thread.company && <p className="tc__company">{thread.company}</p>}
      <p className="tc__where">{describeThread(thread, labelOf)}</p>
      {fields.length > 0 ? (
        <dl className="tc__fields">
          {fields.map((field) => (
            <div key={field.label}>
              <dt>{field.label}</dt>
              <dd>
                {field.value}
                <span className="tc__by">{labelOf(field.agent)}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="tc__hint">No agent has added facts yet.</p>
      )}
    </div>,
    document.body,
  );
}
