'use client';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { Braces } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { type JsonLine, jsonLines } from '@/lib/pipeline/jsonLines';
import { jsonCellId } from '@/lib/pipeline/layout';
import { shortId, threadJson } from '@/lib/pipeline/threads';
import { type JsonNode, pathAttrs, useFlowView, useThreadAnchor } from './FlowView';

/** Indentation of one nesting level, in `ch`. */
const INDENT_CH = 2;

/**
 * One line of the object. A line is keyed by what it says, so React mounts a
 * new element when a key is appended or its value changes, and the CSS
 * animation of a newly mounted line is the flash.
 */
function Line({ line }: { line: JsonLine }) {
  return (
    <span className="tj__line" style={{ paddingLeft: `${line.depth * INDENT_CH}ch` }}>
      {line.key && <span className="tj__key">{JSON.stringify(line.key)}: </span>}
      <span data-kind={line.kind} title={line.full || undefined}>
        {line.text}
      </span>
      {line.comma && ','}
    </span>
  );
}

/**
 * The card at the end of a row: the thread that row took last, as a small JSON
 * object that gets a key each time an agent adds a fact. A click on the header
 * keeps the thread's path highlighted.
 */
export function ThreadJson({ data }: NodeProps<JsonNode>) {
  const { row } = data;
  const view = useFlowView();
  const thread = view.state.threads[view.state.rows[row] ?? ''];
  const rank = thread ? view.ranks[thread.id] : undefined;
  const anchor = useThreadAnchor(thread?.id);
  const lines = useMemo(() => (thread ? jsonLines(threadJson(thread, rank)) : []), [thread, rank]);
  const body = useRef<HTMLPreElement>(null);

  // Keep the newest key in view: the card is shorter than a finished thread.
  useEffect(() => {
    const box = body.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [lines.length, thread?.id]);

  return (
    <div
      className="tj"
      data-status={thread?.status}
      {...pathAttrs(view.path, jsonCellId(row))}
      {...anchor}
    >
      <Handle type="target" position={Position.Left} className="mm__handle" isConnectable={false} />
      <button
        type="button"
        className="tj__head"
        disabled={!thread}
        aria-pressed={thread ? view.pinned === thread.id : undefined}
        title={thread ? 'Highlight the path of this thread' : undefined}
        onClick={() => thread && view.togglePinned(thread.id)}
      >
        <Braces size={12} aria-hidden="true" />
        <span>Row {row}</span>
        {thread && <code title={thread.id}>{shortId(thread.id)}</code>}
      </button>
      {thread ? (
        <pre
          className="tj__body nodrag nowheel"
          ref={body}
          tabIndex={0}
          aria-label="Thread as JSON"
        >
          {lines.map((line) => (
            <Line key={line.id} line={line} />
          ))}
        </pre>
      ) : (
        <p className="tj__empty">No thread on this row yet</p>
      )}
    </div>
  );
}
