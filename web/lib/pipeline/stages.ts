/**
 * The pipeline agents that run a pool of parallel workers, and the ids of the
 * graph nodes that stand for one worker (`extractor#2`). The graph has one row
 * per worker, and every row is a whole pipeline: filter, extractor, scorer,
 * researcher, applier. The applier itself works on one application at a time;
 * its card in a row shows what it does for that row's thread (`applier#2`).
 * The scout stands in front of all rows, so its node id is the agent id.
 */
import type { PipelineEvent, PipelineStage } from '@/lib/types';

/** In the order a posting passes through them. */
export const STAGES: readonly PipelineStage[] = ['filter', 'extractor', 'scorer', 'researcher'];

/** The automatic part of the pipeline; the applier follows only when the user asks. */
const FLOW: readonly string[] = ['scout', ...STAGES];

/** Every agent a thread can be in, in the order it passes them. */
const ORDER: readonly string[] = [...FLOW, 'applier'];

/** Where `agent` is in the pipeline: lower is earlier; -1 for an agent that is not part of it. */
export const flowIndex = (agent: string): number => ORDER.indexOf(agent);

export const isStage = (agent: string): agent is PipelineStage =>
  (STAGES as readonly string[]).includes(agent);

export const APPLIER = 'applier';

/** Whether the agent has a card in every row of the graph. */
export const isRowAgent = (agent: string): boolean => isStage(agent) || agent === APPLIER;

/**
 * Whether the agent's card shows a thread. The scout only announces postings;
 * it never works on one of them for longer than that.
 */
export const holdsThread = (agent: string): boolean => isRowAgent(agent);

/** The agent an item is handed to when `agent` forwards it; null after the last one. */
export function nextStage(agent: string): string | null {
  const at = FLOW.indexOf(agent);
  return at === -1 ? null : (FLOW[at + 1] ?? null);
}

export const workerNodeId = (agent: string, worker: number) => `${agent}#${worker}`;

/** 'extractor#2' -> { agent: 'extractor', worker: 2 }; 'scout' -> { agent: 'scout', worker: null }. */
export function parseNodeId(id: string): { agent: string; worker: number | null } {
  const at = id.lastIndexOf('#');
  if (at === -1) return { agent: id, worker: null };
  return { agent: id.slice(0, at), worker: Number(id.slice(at + 1)) };
}

/** Which parallel worker emitted the event; 1 for events stored before workers existed. */
export function eventWorker(event: PipelineEvent): number {
  const worker = event.data.worker;
  return typeof worker === 'number' && worker >= 1 ? Math.floor(worker) : 1;
}

/**
 * The graph node an item event belongs to. An applier event carries no worker:
 * its row is the row of its thread, which only the reducer knows.
 */
export const eventNodeId = (event: PipelineEvent): string =>
  isStage(event.agent) ? workerNodeId(event.agent, eventWorker(event)) : event.agent;

/**
 * The highest worker number each stage used in `events`. A run recorded with
 * more workers than the pipeline has now still needs a row for each of them.
 */
export function seenWorkers(events: readonly PipelineEvent[]): Record<string, number> {
  const seen: Record<string, number> = {};
  for (const event of events) {
    if (!isStage(event.agent) || !event.type.startsWith('item.')) continue;
    seen[event.agent] = Math.max(seen[event.agent] ?? 0, eventWorker(event));
  }
  return seen;
}

/** The worker count the Start popover shows: the highest of any stage. */
export const pipelineWorkers = (nodes: readonly { id: string; workers: number }[]): number =>
  Math.max(1, ...nodes.filter((node) => isStage(node.id)).map((node) => node.workers));
