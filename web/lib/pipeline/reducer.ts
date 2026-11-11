/**
 * Folds the event log into the state of every node of the pipeline graph.
 *
 * `reduce` is pure and reads time only from the events themselves, so reducing
 * the first N events of a run reproduces the graph exactly as it was after
 * event N. The live view and the time scrubber both rely on that.
 */
import type { PipelineEvent } from '@/lib/types';

export type NodeStatus = 'idle' | 'running' | 'waiting' | 'done' | 'failed';
export type RunPhase = 'idle' | 'running' | 'finished';

/** How many recent events each node keeps for the side panel. */
export const MAX_NODE_EVENTS = 50;

export interface NodeState {
  status: NodeStatus;
  /** Items that entered the node. */
  in: number;
  /** Items the node finished, forwarded downstream or not. */
  out: number;
  dropped: number;
  failed: number;
  /** Source nodes only: postings the source returned. */
  count: number | null;
  /** job id -> title of the items being processed right now. */
  active: Record<string, string>;
  /** job id -> title of the items blocked on the human. */
  waiting: Record<string, string>;
  /** Title of the item shown on the card; '' when nothing is in progress. */
  current: string;
  lastDurationMs: number | null;
  /** Epoch ms of the last item handed downstream; lights the outgoing edges. */
  lastForwardAt: number | null;
  /** Whether the most recent item ended in failure. */
  lastFailed: boolean;
  /** Newest first, at most MAX_NODE_EVENTS. */
  events: PipelineEvent[];
}

export interface PipelineState {
  nodes: Record<string, NodeState>;
  run: RunPhase;
  /** Epoch ms of the last event reduced. */
  lastTs: number | null;
}

export const EMPTY_NODE: NodeState = {
  status: 'idle',
  in: 0,
  out: 0,
  dropped: 0,
  failed: 0,
  count: null,
  active: {},
  waiting: {},
  current: '',
  lastDurationMs: null,
  lastForwardAt: null,
  lastFailed: false,
  events: [],
};

export const INITIAL_STATE: PipelineState = { nodes: {}, run: 'idle', lastTs: null };

export const sourceNodeId = (source: string) => `source:${source}`;

const hasKeys = (record: Record<string, string>) => Object.keys(record).length > 0;

function without(record: Record<string, string>, key: string): Record<string, string> {
  if (!(key in record)) return record;
  const rest = { ...record };
  delete rest[key];
  return rest;
}

function itemStatus(node: NodeState): NodeStatus {
  if (hasKeys(node.active)) return 'running';
  if (hasKeys(node.waiting)) return 'waiting';
  if (node.lastFailed) return 'failed';
  return node.events.length > 0 ? 'done' : 'idle';
}

/** Applies `change` to one node, appends the event to its log and re-derives what follows. */
function patchNode(
  state: PipelineState,
  id: string,
  event: PipelineEvent,
  change: (node: NodeState) => Partial<NodeState>,
): PipelineState {
  const before = state.nodes[id] ?? EMPTY_NODE;
  const node = { ...before, ...change(before) };
  node.events = [event, ...before.events].slice(0, MAX_NODE_EVENTS);
  const inProgress = Object.values(node.active).at(-1) ?? Object.values(node.waiting).at(-1);
  node.current = inProgress ?? '';
  if (!id.startsWith('source:')) node.status = itemStatus(node);
  return { ...state, nodes: { ...state.nodes, [id]: node } };
}

function reduceSource(state: PipelineState, event: PipelineEvent, ts: number): PipelineState {
  const name = typeof event.data.source === 'string' ? event.data.source : '';
  const id = sourceNodeId(name);
  const fetching = event.type === 'source.started';

  // The scout is busy for as long as any of its sources is being fetched.
  const next = patchNode(state, event.agent, event, (scout) => ({
    active: fetching ? { ...scout.active, [id]: `Fetching ${name}` } : without(scout.active, id),
  }));

  return patchNode(next, id, event, (source) => {
    if (fetching) return { status: 'running' };
    if (event.type === 'source.failed') return { status: 'failed', lastFailed: true };
    return {
      status: 'done',
      count: typeof event.data.count === 'number' ? event.data.count : source.count,
      lastDurationMs: event.duration_ms,
      lastForwardAt: ts,
    };
  });
}

function reduceItem(state: PipelineState, event: PipelineEvent, ts: number): PipelineState {
  const job = event.job_id;
  return patchNode(state, event.agent, event, (node) => {
    const known = job in node.active || job in node.waiting;
    const entered = node.in + (known ? 0 : 1);
    const settled = {
      in: entered,
      active: without(node.active, job),
      waiting: without(node.waiting, job),
    };

    switch (event.type) {
      case 'item.started':
        return { ...settled, active: { ...settled.active, [job]: event.title } };
      case 'item.waiting':
        return { ...settled, waiting: { ...settled.waiting, [job]: event.title } };
      case 'item.dropped':
        return { ...settled, dropped: node.dropped + 1, lastFailed: false };
      case 'item.failed':
        return { ...settled, failed: node.failed + 1, lastFailed: true };
      default:
        return {
          ...settled,
          out: node.out + 1,
          lastFailed: false,
          lastDurationMs: event.duration_ms,
          lastForwardAt: event.data.forwarded === false ? node.lastForwardAt : ts,
        };
    }
  });
}

export function reduce(state: PipelineState, event: PipelineEvent): PipelineState {
  const ts = Date.parse(event.ts);
  const timed = { ...state, lastTs: ts };

  switch (event.type) {
    case 'run.started':
      return { ...timed, run: 'running' };
    case 'run.finished':
      return { ...timed, run: 'finished' };
    case 'source.started':
    case 'source.finished':
    case 'source.failed':
      return reduceSource(timed, event, ts);
    case 'scout.done':
      return patchNode(timed, event.agent, event, () => ({ active: {} }));
    default:
      return reduceItem(timed, event, ts);
  }
}

export const reduceAll = (events: readonly PipelineEvent[]): PipelineState =>
  events.reduce(reduce, INITIAL_STATE);
