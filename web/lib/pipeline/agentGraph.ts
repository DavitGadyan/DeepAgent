/**
 * What an agent does inside, and where a thread is in it. An agent that is a
 * LangGraph graph has nodes and edges and reports the node a job enters; the
 * others have fixed steps. The picture itself is drawn by orbit.ts.
 */
import type { GraphShape, PipelineNode } from '@/lib/types';
import type { NodeState } from './reducer';
import type { Thread } from './threads';

export const START = '__start__';
export const END = '__end__';

const LABELS: Record<string, string> = { [START]: 'Start', [END]: 'End' };

/** The shape with a node for every edge end, and plain names for start and end. */
export function completeNodes(shape: GraphShape): GraphShape['nodes'] {
  const nodes = new Map(shape.nodes.map((node) => [node.id, node.label]));
  for (const edge of shape.edges) {
    for (const id of [edge.source, edge.target]) if (!nodes.has(id)) nodes.set(id, id);
  }
  return [...nodes].map(([id, label]) => ({ id, label: LABELS[id] ?? label }));
}

export type GraphNodeState = 'pending' | 'active' | 'done' | 'failed';

/** Every node from which `target` can be reached: what ran before a resumed thread's node. */
function ancestors(shape: GraphShape, target: string): Set<string> {
  const found = new Set<string>();
  const queue = [target];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    for (const edge of shape.edges) {
      if (edge.target !== id || found.has(edge.source) || edge.source === target) continue;
      found.add(edge.source);
      queue.push(edge.source);
    }
  }
  return found;
}

/**
 * The state of every node of the agent's graph for the thread shown on the
 * card `nodeId`. A thread that already left the card finished here, so every
 * node is done; one that never reached it has done nothing yet.
 */
export function graphNodeStates(
  shape: GraphShape,
  thread: Thread | undefined,
  nodeId: string,
): Record<string, GraphNodeState> {
  const ids = completeNodes(shape).map((node) => node.id);
  const all = (state: GraphNodeState) => Object.fromEntries(ids.map((id) => [id, state]));
  if (!thread || !thread.path.includes(nodeId)) return all('pending');

  const here = thread.path.at(-1) === nodeId;
  const inside = here && (thread.status === 'running' || thread.status === 'failed');
  if (!inside) return all('done');

  const states = all('pending');
  const before = thread.resumedAt ? ancestors(shape, thread.resumedAt) : [];
  for (const id of [START, ...before, ...thread.graphDone]) if (id in states) states[id] = 'done';
  if (thread.graphNode !== null && thread.graphNode in states) {
    states[thread.graphNode] = thread.status === 'failed' ? 'failed' : 'active';
  }
  return states;
}

/** Where the thread shown on the card `nodeId` is inside the agent's graph, in words. */
export function threadPlace(shape: GraphShape, thread: Thread | undefined, nodeId: string): string {
  if (!thread || !thread.path.includes(nodeId)) return 'No thread yet';
  if (thread.path.at(-1) !== nodeId) return 'Finished here';

  const labels = new Map(completeNodes(shape).map((node) => [node.id, node.label]));
  const name = (id: string) => labels.get(id) ?? id;
  const { graphNode, resumedAt, status } = thread;
  const resumed = resumedAt ? `Resumed at ${name(resumedAt)}` : '';

  if (status === 'failed') return graphNode ? `Failed in ${name(graphNode)}` : 'Failed';
  if (status !== 'running') return resumed ? `${resumed}, finished` : 'Finished here';
  if (!graphNode) return resumed || 'Starting';
  if (!resumed) return `In ${name(graphNode)}`;
  return graphNode === resumedAt ? resumed : `${resumed}, now in ${name(graphNode)}`;
}

export type StepState = GraphNodeState;

/** The applier's fixed steps, by the action its events name. */
const APPLIER_STEP: Record<string, number> = { tailor: 0, fill_form: 1 };

/**
 * States of the fixed steps of an agent that is not a graph. Only the applier
 * has a live position: its events say which of its two actions it is doing.
 * For the others every step is `pending`: they report no step.
 */
export function fixedStepStates(node: PipelineNode, state: NodeState): StepState[] {
  const steps = node.steps.map((): StepState => 'pending');
  const last = state.events.find((event) => typeof event.data.action === 'string');
  const at = last ? APPLIER_STEP[String(last.data.action)] : undefined;
  if (at === undefined || !last) return steps;

  const ended: StepState | null =
    last.type === 'item.finished' ? 'done' : last.type === 'item.failed' ? 'failed' : null;
  return steps.map((_, index) => {
    if (index < at) return 'done';
    if (index === at) return ended ?? 'active';
    // After the form is filled the applier has stopped before Submit: its last step.
    return ended === 'done' && at === APPLIER_STEP.fill_form ? 'done' : 'pending';
  });
}
