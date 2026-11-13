/**
 * Folds the event log into the state of every node of the pipeline graph and
 * of every thread (job) travelling through it.
 *
 * `reduce` is pure and reads time only from the events themselves, so reducing
 * the first N events of a run reproduces the graph exactly as it was after
 * event N. The live view and the time scrubber both rely on that.
 *
 * Node states are kept under three kinds of id: 'source:<name>', the agent id
 * (all of the agent's workers together) and '<agent>#<worker>' (one worker, or
 * for the applier the row of the thread it works on).
 */
import type { PipelineEvent } from '@/lib/types';
import {
  APPLIER,
  eventNodeId,
  isRowAgent,
  isStage,
  nextStage,
  parseNodeId,
  workerNodeId,
} from './stages';
import { applyEvent, isLate, type Thread } from './threads';

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
  /** Job id of the item the node works on, or worked on last; '' before the first one. */
  job: string;
  lastDurationMs: number | null;
  /** Epoch ms of the last item handed downstream; lights the outgoing edges. */
  lastForwardAt: number | null;
  /** Whether the most recent item ended in failure. */
  lastFailed: boolean;
  /** Newest first, at most MAX_NODE_EVENTS. */
  events: PipelineEvent[];
}

/** A thread moving from one graph node to the next. */
export interface Hop {
  /** Epoch ms of the moment the downstream node took the thread. */
  at: number;
  job: string;
}

export interface PipelineState {
  nodes: Record<string, NodeState>;
  /** job id -> the job's thread. */
  threads: Record<string, Thread>;
  /**
   * agent -> job id -> title of the items the previous stage handed over that
   * no worker of this agent has started: the queue in front of the agent.
   */
  queued: Record<string, Record<string, string>>;
  /** '<from>-><to>' node ids -> the last thread that moved along that edge. */
  hops: Record<string, Hop>;
  /** Worker number (the grid row) -> job id of the thread a worker of that row took last. */
  rows: Record<number, string>;
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
  job: '',
  lastDurationMs: null,
  lastForwardAt: null,
  lastFailed: false,
  events: [],
};

export const INITIAL_STATE: PipelineState = {
  nodes: {},
  threads: {},
  queued: {},
  hops: {},
  rows: {},
  run: 'idle',
  lastTs: null,
};

/** How many items wait in front of `agent` for a free worker. */
export const waitingCount = (state: PipelineState, agent: string): number =>
  Object.keys(state.queued[agent] ?? {}).length;

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

/** What one item event changes on a node; the same for a worker and for its agent's totals. */
function itemChange(node: NodeState, event: PipelineEvent, ts: number): Partial<NodeState> {
  const job = event.job_id;
  const known = job in node.active || job in node.waiting;
  const settled = {
    in: node.in + (known ? 0 : 1),
    job,
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
}

/** The queues after `event`: its job left this agent's queue and may have joined the next one. */
function requeue(
  queued: PipelineState['queued'],
  event: PipelineEvent,
  late: boolean,
): PipelineState['queued'] {
  const next = { ...queued, [event.agent]: without(queued[event.agent] ?? {}, event.job_id) };
  const target = nextStage(event.agent);
  const handedOn = event.type === 'item.finished' && event.data.forwarded !== false;
  // A late "finished" means the next stage already took the item: nothing waits.
  if (!handedOn || late || target === null) return next;
  return { ...next, [target]: { ...next[target], [event.job_id]: event.title } };
}

/** Moves the event's thread, and records the hop when it entered a new node. */
function reduceThread(
  state: PipelineState,
  event: PipelineEvent,
  nodeId: string,
  ts: number,
): PipelineState {
  const job = event.job_id;
  const before = state.threads[job];
  const late = isLate(before, event, nodeId);
  const thread = applyEvent(before, event, nodeId);
  const from = before?.path.at(-1);
  // A late event may add the node it tells of to the path; the thread did not move there now.
  const entered = !late && thread.path.length > (before?.path.length ?? 0);
  // The applier may work on a lead of an earlier run, which has no thread here:
  // that must not replace the thread a row's JSON card shows.
  const ownsRow = isStage(event.agent) || (isRowAgent(event.agent) && before !== undefined);
  const row = ownsRow ? parseNodeId(nodeId).worker : null;

  return {
    ...state,
    threads: { ...state.threads, [job]: thread },
    queued: requeue(state.queued, event, late),
    hops:
      entered && from !== undefined
        ? { ...state.hops, [`${from}->${nodeId}`]: { at: ts, job } }
        : state.hops,
    rows: entered && row !== null ? { ...state.rows, [row]: job } : state.rows,
  };
}

/**
 * The card an applier event belongs to. The applier is one worker; in the graph
 * it has a card in every row and works in the row of its thread: where it
 * already holds the thread, else the row of the thread's last stage, else row 1
 * (a lead from an earlier run has no row in this one).
 */
function applierNodeId(state: PipelineState, job: string): string {
  const held = Object.keys(state.nodes).find((id) => {
    const { agent, worker } = parseNodeId(id);
    return agent === APPLIER && worker !== null && state.nodes[id]?.job === job;
  });
  if (held) return held;
  const lastStage = state.threads[job]?.path.findLast((id) => isStage(parseNodeId(id).agent));
  return workerNodeId(APPLIER, (lastStage && parseNodeId(lastStage).worker) || 1);
}

/**
 * A worker that was cut off (its container was stopped) never reports the end
 * of its job. When the job turns up at another worker of the same agent, the
 * first one has let go of it; without this its card would glow for ever.
 */
function releaseElsewhere(state: PipelineState, event: PipelineEvent, nodeId: string) {
  const job = event.job_id;
  let nodes = state.nodes;
  for (const [id, node] of Object.entries(state.nodes)) {
    const { agent, worker } = parseNodeId(id);
    if (id === nodeId || worker === null || agent !== event.agent) continue;
    if (!(job in node.active) && !(job in node.waiting)) continue;
    const freed = {
      ...node,
      active: without(node.active, job),
      waiting: without(node.waiting, job),
    };
    freed.current = Object.values(freed.active).at(-1) ?? Object.values(freed.waiting).at(-1) ?? '';
    freed.status = itemStatus(freed);
    nodes = { ...nodes, [id]: freed };
  }
  return nodes === state.nodes ? state : { ...state, nodes };
}

function reduceItem(before: PipelineState, event: PipelineEvent, ts: number): PipelineState {
  const nodeId = event.agent === APPLIER ? applierNodeId(before, event.job_id) : eventNodeId(event);
  const state = releaseElsewhere(before, event, nodeId);
  // A step inside the agent's graph is neither a start nor an end: only the thread moves.
  if (event.type === 'item.progress') return reduceThread(state, event, nodeId, ts);

  // A worker's event also counts towards its agent's totals.
  const counted = nodeId === event.agent ? [nodeId] : [event.agent, nodeId];
  const next = counted.reduce(
    (acc, id) => patchNode(acc, id, event, (node) => itemChange(node, event, ts)),
    state,
  );
  return reduceThread(next, event, nodeId, ts);
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
