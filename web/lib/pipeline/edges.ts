import type { PipelineEdge } from '@/lib/types';
import { EMPTY_NODE, type PipelineState } from './reducer';

/** How long an edge stays lit after its upstream node hands an item over. */
export const FLOW_GLOW_MS = 2000;

export const edgeId = (edge: PipelineEdge) => `${edge.source}->${edge.target}`;

/**
 * Items are flowing across an edge while the upstream node handed one over in
 * the last FLOW_GLOW_MS, or while the downstream node is working on one. A
 * source feeds the scout only while that source itself is being fetched.
 */
export function isFlowing(state: PipelineState, edge: PipelineEdge, now: number): boolean {
  const source = state.nodes[edge.source] ?? EMPTY_NODE;
  const target = state.nodes[edge.target] ?? EMPTY_NODE;
  const justForwarded = source.lastForwardAt !== null && now - source.lastForwardAt < FLOW_GLOW_MS;

  if (edge.source.startsWith('source:')) return source.status === 'running' || justForwarded;
  return justForwarded || target.status === 'running';
}

/** Ids of the edges to light, in a stable order so the result can be compared cheaply. */
export function flowingEdgeIds(
  state: PipelineState,
  edges: readonly PipelineEdge[],
  now: number,
): string[] {
  return edges.filter((edge) => isFlowing(state, edge, now)).map(edgeId);
}
