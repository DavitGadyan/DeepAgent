/**
 * The edges of the pipeline graph: which ones are always drawn, which ones are
 * drawn only while a thread uses them, and which ones are lit right now.
 */
import type { NodeKind, Pipeline } from '@/lib/types';
import { columnCellIds, type Column, type Grid, jsonCellId, pipelineEdges } from './layout';
import { EMPTY_NODE, type PipelineState } from './reducer';
import { APPLIER, parseNodeId } from './stages';

/** How long an edge stays lit after a thread moved along it. */
export const FLOW_GLOW_MS = 2000;

/**
 * `flow`: the automatic hand-over between two agents. `gate`: into the agent
 * that acts only when the human asks. `json`: the connector to a row's JSON card.
 */
export type EdgeRole = 'flow' | 'gate' | 'json';

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  role: EdgeRole;
}

export const edgeId = (source: string, target: string) => `${source}->${target}`;

const flowRole = (targetKind: NodeKind | undefined): EdgeRole =>
  targetKind === 'human' ? 'gate' : 'flow';

/**
 * One pipeline edge spread over the worker cards of its two agents. Between two
 * stages only workers of the same row are joined: any worker can pass a thread
 * to any other, and drawing all of those edges would hide the flow.
 */
function spread(from: Column, to: Column): [string, string][] {
  const sources = columnCellIds(from);
  const targets = columnCellIds(to);
  if (from.workers === null) return targets.map((target) => [sources[0] ?? '', target]);
  if (to.workers === null) return sources.map((source) => [source, targets[0] ?? '']);
  return sources.flatMap((source, row) => {
    const target = targets[row];
    return target ? [[source, target] as [string, string]] : [];
  });
}

/** The connectors to the JSON cards: from the last agent of the pipeline to every row. */
function jsonEdges(grid: Grid): FlowEdge[] {
  const last = grid.columns.at(-1);
  if (!last || !grid.hasThreads) return [];
  const ends = columnCellIds(last);
  return Array.from({ length: grid.rows }, (_, index) => {
    const source = last.workers === null ? ends[0] : ends[index];
    const target = jsonCellId(index + 1);
    return source ? [{ id: edgeId(source, target), source, target, role: 'json' as const }] : [];
  }).flat();
}

/** The edges that are always drawn. */
export function gridEdges(pipeline: Pipeline, grid: Grid): FlowEdge[] {
  const columns = new Map(grid.columns.map((column) => [column.node.id, column]));
  const flow = pipelineEdges(pipeline).flatMap((edge): FlowEdge[] => {
    const from = columns.get(edge.source);
    const to = columns.get(edge.target);
    // An edge that starts at a source: the source card is not part of a column.
    if (!to) return [];
    const pairs = from ? spread(from, to) : columnCellIds(to).map((id) => [edge.source, id]);
    const role = flowRole(to.node.kind);
    return pairs.map(([source = '', target = '']) => ({
      id: edgeId(source, target),
      source,
      target,
      role,
    }));
  });
  return [...flow, ...jsonEdges(grid)];
}

/**
 * `base` plus an edge for every id of `extra` it lacks that stays inside one
 * row and ends at the applier: a thread that was not researched goes to the
 * applier from an earlier stage, and gets that edge only for as long as it is
 * lit or highlighted. Rows are never joined: no edge leads from one row to
 * another, also for a run recorded before jobs kept to their row.
 */
export function withExtraEdges(
  base: FlowEdge[],
  extra: readonly string[],
  grid: Grid,
  known: ReadonlySet<string>,
): FlowEdge[] {
  const drawn = new Set(base.map((edge) => edge.id));
  const kinds = new Map(grid.columns.map(({ node }) => [node.id, node.kind]));
  const added: FlowEdge[] = [];
  for (const id of extra) {
    const [source = '', target = ''] = id.split('->');
    if (drawn.has(id) || !known.has(source) || !known.has(target)) continue;
    const from = parseNodeId(source);
    const to = parseNodeId(target);
    if (to.agent !== APPLIER || from.worker === null || from.worker !== to.worker) continue;
    drawn.add(id);
    added.push({ id, source, target, role: flowRole(kinds.get(parseNodeId(target).agent)) });
  }
  return added.length > 0 ? [...base, ...added] : base;
}

/** A source feeds the scout while it is being fetched, and for a moment after it returned. */
function isFetching(state: PipelineState, sourceId: string, now: number): boolean {
  const source = state.nodes[sourceId] ?? EMPTY_NODE;
  const justForwarded = source.lastForwardAt !== null && now - source.lastForwardAt < FLOW_GLOW_MS;
  return source.status === 'running' || justForwarded;
}

/**
 * The edge a thread moved along is lit for FLOW_GLOW_MS after the move, and
 * for as long as the node it moved into is still working on that thread.
 */
function isHopLit(state: PipelineState, id: string, now: number): boolean {
  const hop = state.hops[id];
  if (!hop) return false;
  if (now - hop.at < FLOW_GLOW_MS) return true;
  const thread = state.threads[hop.job];
  return thread?.status === 'running' && id.endsWith(`->${thread.path.at(-1)}`);
}

/**
 * Ids of the edges to light at `now`, in a stable order so the result can be
 * compared cheaply: source edges first, then the hops in the order they were
 * first taken.
 */
export function litEdgeIds(state: PipelineState, pipeline: Pipeline, now: number): string[] {
  const sources = pipeline.nodes
    .filter((node) => node.kind === 'source' && node.parent)
    .filter((node) => isFetching(state, node.id, now))
    .map((node) => edgeId(node.id, node.parent ?? ''));
  const hops = Object.keys(state.hops).filter((id) => isHopLit(state, id, now));
  return [...sources, ...hops];
}

/** The edges between the consecutive nodes of a thread's path. */
export const pathEdgeIds = (path: readonly string[]): string[] =>
  path.slice(1).map((target, index) => edgeId(path[index] ?? '', target));
