'use client';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import {
  Bot,
  Check,
  CircleDashed,
  CirclePause,
  CircleX,
  Database,
  LoaderCircle,
  Rss,
  Sparkles,
  type LucideIcon,
  UserRound,
  Wrench,
} from 'lucide-react';
import { formatDuration } from '@/lib/format';
import { EMPTY_NODE, type NodeState, type NodeStatus, waitingCount } from '@/lib/pipeline/reducer';
import { holdsThread, isStage } from '@/lib/pipeline/stages';
import type { NodeKind, PipelineNode } from '@/lib/types';
import {
  type AgentNode,
  type HeaderNode,
  pathAttrs,
  type SourceNode,
  useFlowView,
  useThreadAnchor,
} from './FlowView';
import { ThreadJson } from './ThreadJson';

const KIND_ICON: Record<NodeKind, LucideIcon> = {
  source: Rss,
  tool: Wrench,
  llm: Sparkles,
  deep: Bot,
  human: UserRound,
  store: Database,
};

const STATUS_ICON: Record<NodeStatus, LucideIcon> = {
  idle: CircleDashed,
  running: LoaderCircle,
  waiting: CirclePause,
  done: Check,
  failed: CircleX,
};

function StatusGlyph({ status }: { status: NodeStatus }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className="mm__status" data-status={status} role="img" aria-label={status}>
      <Icon size={14} className={status === 'running' ? 'spin' : undefined} aria-hidden="true" />
    </span>
  );
}

function KindIcon({ kind }: { kind: NodeKind }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className="mm__icon">
      <Icon size={13} aria-hidden="true" />
    </span>
  );
}

/** What the second line of an agent card says, most urgent first. */
function subtitle(node: PipelineNode, state: NodeState): string {
  if (state.current) return state.current;
  if (state.lastDurationMs !== null)
    return `Last item took ${formatDuration(state.lastDurationMs)}`;
  return node.model || 'No model';
}

/** Spans, not a list: the counters sit inside the card's button. */
function Counts({ state }: { state: NodeState }) {
  return (
    <span className="mm__counts">
      <span>
        <b>{state.in}</b>in
      </span>
      <span>
        <b>{state.out}</b>out
      </span>
      <span data-tone={state.dropped ? 'warn' : undefined}>
        <b>{state.dropped}</b>drop
      </span>
      <span data-tone={state.failed ? 'bad' : undefined}>
        <b>{state.failed}</b>fail
      </span>
    </span>
  );
}

/**
 * One agent in one row of the graph (or the scout, in front of all rows). A
 * click opens the side panel: the agent's graph with the step its thread is
 * in, its counters and its past events. While the card holds a thread,
 * pointing at it shows the thread's hover card.
 */
export function AgentCard({ id, data }: NodeProps<AgentNode>) {
  const { node, worker, workers } = data;
  const view = useFlowView();
  const state = view.state.nodes[id] ?? EMPTY_NODE;
  const thread = holdsThread(node.id) ? view.state.threads[state.job] : undefined;
  // The panel of the selected card already shows its thread; a hover card would cover it.
  const anchor = useThreadAnchor(view.selected === id ? undefined : thread?.id);
  const numbered = worker !== null && workers > 1;

  return (
    <div
      className="mm__card"
      data-kind={node.kind}
      data-status={state.status}
      data-selected={view.selected === id || undefined}
      data-disabled={node.enabled ? undefined : ''}
      {...pathAttrs(view.path, id)}
      {...anchor}
    >
      <Handle type="target" position={Position.Left} className="mm__handle" isConnectable={false} />
      <button
        type="button"
        className="mm__main"
        aria-pressed={view.selected === id}
        title="The agent's graph, counters and past events"
        onClick={() => view.openDetails(id)}
      >
        <span className="mm__head">
          <KindIcon kind={node.kind} />
          <span className="mm__title">
            {node.label}
            {numbered && <span className="mm__worker"> #{worker}</span>}
          </span>
          <StatusGlyph status={state.status} />
        </span>
        <span className="mm__short">{subtitle(node, state)}</span>
        <Counts state={state} />
      </button>
      <Handle
        type="source"
        position={Position.Right}
        className="mm__handle"
        isConnectable={false}
      />
    </div>
  );
}

/** A source: a click opens its details. */
export function SourceCard({ id, data }: NodeProps<SourceNode>) {
  const { node } = data;
  const view = useFlowView();
  const state = view.state.nodes[id] ?? EMPTY_NODE;
  return (
    <div
      className="mm__card mm__card--source"
      data-kind={node.kind}
      data-status={state.status}
      data-selected={view.selected === id || undefined}
      data-disabled={node.enabled ? undefined : ''}
      {...pathAttrs(view.path, id)}
    >
      <button
        type="button"
        className="mm__main"
        aria-pressed={view.selected === id}
        title="Details and recent events"
        onClick={() => view.openDetails(id)}
      >
        <span className="mm__head">
          <KindIcon kind={node.kind} />
          <span className="mm__title" title={node.label}>
            {node.label}
          </span>
          {!node.enabled ? (
            <span className="mm__short" title="Disabled in Setup">
              off
            </span>
          ) : state.count !== null ? (
            <span className="mm__badge" title={`${state.count} postings found`}>
              {state.count}
            </span>
          ) : (
            <StatusGlyph status={state.status} />
          )}
        </span>
      </button>
      <Handle
        type="source"
        position={Position.Right}
        className="mm__handle"
        isConnectable={false}
      />
    </div>
  );
}

/** Above a column of the grid: the agent, and how many items wait for a free worker. */
export function StageHeader({ data }: NodeProps<HeaderNode>) {
  const { node, width } = data;
  const waiting = waitingCount(useFlowView().state, node.id);
  return (
    <div
      className="mm__colhead"
      data-kind={node.kind}
      data-busy={waiting > 0 || undefined}
      style={{ width }}
    >
      <span className="mm__colname">{node.label}</span>
      {isStage(node.id) ? (
        <span className="mm__wait" title="Handed over by the previous agent, not started yet">
          <b>{waiting}</b> waiting
        </span>
      ) : (
        // The applier has no queue: it starts when you press a button on a lead.
        <span className="mm__wait" title="Starts when you press Tailor CV or Apply on a lead">
          on your approval
        </span>
      )}
    </div>
  );
}

export const nodeTypes = {
  agent: AgentCard,
  source: SourceCard,
  json: ThreadJson,
  header: StageHeader,
};
