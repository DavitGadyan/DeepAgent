/**
 * Left-to-right layout of the pipeline graph with dagre: sources in a column on
 * the left, then the agents in the order the edges give. Pure and deterministic.
 */
import dagre from '@dagrejs/dagre';
import type { Pipeline, PipelineEdge, PipelineNode } from '@/lib/types';

// Mirrored in app/pipeline.css (.mm__card, .mm__card--source).
export const AGENT_W = 184;
export const AGENT_H = 100;
export const SOURCE_W = 208;
export const SOURCE_H = 44;
const GAP_X = 56;
const GAP_Y = 12;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export const nodeSize = (node: PipelineNode): Size =>
  node.kind === 'source'
    ? { width: SOURCE_W, height: SOURCE_H }
    : { width: AGENT_W, height: AGENT_H };

/**
 * The edges to draw: the ones the API lists (between known nodes), plus an edge
 * from every node into its `parent` when the API left that implicit.
 */
export function pipelineEdges(pipeline: Pipeline): PipelineEdge[] {
  const ids = new Set(pipeline.nodes.map((node) => node.id));
  const edges = pipeline.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const listed = new Set(edges.map((edge) => `${edge.source}->${edge.target}`));

  for (const node of pipeline.nodes) {
    if (!node.parent || !ids.has(node.parent)) continue;
    if (!listed.has(`${node.id}->${node.parent}`)) {
      edges.push({ source: node.id, target: node.parent });
    }
  }
  return edges;
}

/** Top-left corner of every node, in React Flow coordinates. */
export function layoutPipeline(pipeline: Pipeline): Record<string, Point> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', ranksep: GAP_X, nodesep: GAP_Y });
  graph.setDefaultEdgeLabel(() => ({}));

  for (const node of pipeline.nodes) graph.setNode(node.id, nodeSize(node));
  for (const edge of pipelineEdges(pipeline)) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);

  const positions: Record<string, Point> = {};
  for (const node of pipeline.nodes) {
    const { x, y, width, height } = graph.node(node.id);
    positions[node.id] = { x: x - width / 2, y: y - height / 2 };
  }
  return positions;
}
