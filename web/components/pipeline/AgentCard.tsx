'use client';
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
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
  UserRound,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { createContext, useContext } from 'react';
import { formatDuration } from '@/lib/format';
import { EMPTY_NODE, type NodeState, type NodeStatus } from '@/lib/pipeline/reducer';
import type { NodeKind, PipelineNode } from '@/lib/types';

export type AgentNode = Node<{ node: PipelineNode }, 'agent'>;
export type SourceNode = Node<{ node: PipelineNode }, 'source'>;
export type FlowNode = AgentNode | SourceNode;

/** Live state of every node, keyed by node id; the cards read their own entry. */
export const PipelineCtx = createContext<Record<string, NodeState>>({});

const useNodeState = (id: string) => useContext(PipelineCtx)[id] ?? EMPTY_NODE;

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

export function AgentCard({ data, selected }: NodeProps<AgentNode>) {
  const { node } = data;
  const state = useNodeState(node.id);
  return (
    <div
      className="mm__card"
      data-kind={node.kind}
      data-status={state.status}
      data-selected={selected || undefined}
      data-disabled={node.enabled ? undefined : ''}
    >
      <Handle type="target" position={Position.Left} className="mm__handle" isConnectable={false} />
      <div className="mm__head">
        <KindIcon kind={node.kind} />
        <span className="mm__title">{node.label}</span>
        <StatusGlyph status={state.status} />
      </div>
      <p className="mm__short">{subtitle(node, state)}</p>
      <ul className="mm__counts">
        <li>
          <b>{state.in}</b>in
        </li>
        <li>
          <b>{state.out}</b>out
        </li>
        <li data-tone={state.dropped ? 'warn' : undefined}>
          <b>{state.dropped}</b>drop
        </li>
        <li data-tone={state.failed ? 'bad' : undefined}>
          <b>{state.failed}</b>fail
        </li>
      </ul>
      <Handle
        type="source"
        position={Position.Right}
        className="mm__handle"
        isConnectable={false}
      />
    </div>
  );
}

export function SourceCard({ data, selected }: NodeProps<SourceNode>) {
  const { node } = data;
  const state = useNodeState(node.id);
  return (
    <div
      className="mm__card mm__card--source"
      data-kind={node.kind}
      data-status={state.status}
      data-selected={selected || undefined}
      data-disabled={node.enabled ? undefined : ''}
    >
      <div className="mm__head">
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
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="mm__handle"
        isConnectable={false}
      />
    </div>
  );
}

export const nodeTypes = { agent: AgentCard, source: SourceCard };
