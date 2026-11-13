/**
 * Where every card of the pipeline graph goes: the sources in a column on the
 * left, the scout, then a grid with one row per worker. Every row is a whole
 * pipeline (filter, extractor, scorer, researcher, applier) and ends with its
 * JSON card. Pure and deterministic.
 *
 * A row is as high as its highest card and a column as wide as its widest, so
 * an expanded card pushes its neighbours away instead of covering them.
 */
import type { Pipeline, PipelineEdge, PipelineNode } from '@/lib/types';
import { isRowAgent, isStage, workerNodeId } from './stages';

// Mirrored in app/pipeline.css (.mm__card, .mm__card--source, .tj, .mm__colhead).
export const AGENT_W = 184;
export const AGENT_H = 100;
export const SOURCE_W = 208;
export const SOURCE_H = 44;
export const JSON_W = 236;
export const JSON_H = 164;
export const HEADER_H = 26;
const GAP_X = 56;
/** Between two sources. */
const GAP_Y = 12;
/** Between two rows of workers. */
const ROW_GAP = 26;
const HEADER_GAP = 10;

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
 * The edges of the pipeline as the API describes it: the ones it lists
 * (between known nodes), plus an edge from every node into its `parent` when
 * the API left that implicit.
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

/** One agent of the grid. `workers` is null for an agent drawn as a single card. */
export interface Column {
  node: PipelineNode;
  workers: number | null;
}

export interface Grid {
  sources: PipelineNode[];
  /** The agents, in pipeline order. */
  columns: Column[];
  /** Rows of the grid: the highest worker count of any stage, at least 1. */
  rows: number;
  /** False for a pipeline without stages: there is no row to end with a JSON card. */
  hasThreads: boolean;
}

/**
 * The grid for `pipeline`. It has as many rows as the stage with the most
 * workers (as the API reports them, or as `seen` says an older run used), and
 * every row has a card of every row agent: a row is a whole pipeline, also
 * when one agent has fewer workers than another.
 */
export function pipelineGrid(pipeline: Pipeline, seen: Record<string, number> = {}): Grid {
  const agents = pipeline.nodes.filter((node) => node.kind !== 'source');
  const counts = agents
    .filter((node) => isStage(node.id))
    .map((node) => Math.max(1, node.workers, seen[node.id] ?? 0));
  const rows = Math.max(1, ...counts);
  return {
    sources: pipeline.nodes.filter((node) => node.kind === 'source'),
    columns: agents.map((node) => ({ node, workers: isRowAgent(node.id) ? rows : null })),
    rows,
    hasThreads: counts.length > 0,
  };
}

/** Ids of the cards of one column, top to bottom. */
export const columnCellIds = ({ node, workers }: Column): string[] =>
  workers === null
    ? [node.id]
    : Array.from({ length: workers }, (_, index) => workerNodeId(node.id, index + 1));

export const jsonCellId = (row: number) => `json#${row}`;
export const headerCellId = (agent: string) => `header:${agent}`;

export type CellKind = 'source' | 'agent' | 'json' | 'header';

/** One card with its top-left corner in React Flow coordinates. */
export interface Cell extends Point, Size {
  id: string;
  kind: CellKind;
  /** Id of the pipeline node the card stands for; '' for a JSON card. */
  agent: string;
  /** The worker of a stage card and the row of a JSON card; null for the others. */
  worker: number | null;
}

interface Band {
  top: number;
  height: number;
}

/** Stacks `heights` top to bottom with `gap` between them. */
function stack(heights: number[], gap: number): Band[] {
  let top = 0;
  return heights.map((height) => {
    const band = { top, height };
    top += height + gap;
    return band;
  });
}

const bottomOf = (bands: Band[]): number => {
  const last = bands.at(-1);
  return last ? last.top + last.height : 0;
};

/** The rows of the grid: each as high as its highest worker card. */
function rowBands(grid: Grid, sizeOf: (id: string) => Size): Band[] {
  // A single agent stands beside the grid, so its height does not stretch a row.
  const stages = grid.columns.filter((column) => column.workers !== null);
  const heights = Array.from({ length: grid.rows }, (_, row) => {
    const inRow = stages.flatMap((column) => columnCellIds(column)[row] ?? []);
    const lowest = grid.hasThreads ? JSON_H : AGENT_H;
    return Math.max(lowest, ...inRow.map((id) => sizeOf(id).height));
  });
  return stack(heights, ROW_GAP);
}

/**
 * Places every card. `sizes` overrides the size of single cards by id: an
 * expanded agent card is larger than a collapsed one.
 */
export function layoutPipeline(grid: Grid, sizes: Record<string, Size> = {}): Cell[] {
  const agentSize = { width: AGENT_W, height: AGENT_H };
  const sizeOf = (id: string) => sizes[id] ?? agentSize;
  const rows = rowBands(grid, sizeOf);
  const gridHeight = bottomOf(rows);
  const centred = (height: number) => (gridHeight - height) / 2;
  const cells: Cell[] = [];
  let x = 0;

  if (grid.sources.length > 0) {
    const bands = stack(
      grid.sources.map(() => SOURCE_H),
      GAP_Y,
    );
    const offset = centred(bottomOf(bands));
    grid.sources.forEach((node, index) => {
      const y = offset + (bands[index]?.top ?? 0);
      cells.push({
        id: node.id,
        kind: 'source',
        agent: node.id,
        worker: null,
        x,
        y,
        ...nodeSize(node),
      });
    });
    x += SOURCE_W + GAP_X;
  }

  for (const column of grid.columns) {
    const ids = columnCellIds(column);
    const width = Math.max(...ids.map((id) => sizeOf(id).width));
    const agent = column.node.id;
    ids.forEach((id, index) => {
      const size = sizeOf(id);
      const row = rows[index];
      // A single card sits beside the middle of the grid; a worker in the middle of its row.
      const y =
        column.workers === null || !row
          ? centred(size.height)
          : row.top + (row.height - size.height) / 2;
      cells.push({
        id,
        kind: 'agent',
        agent,
        worker: column.workers === null ? null : index + 1,
        x,
        y,
        ...size,
      });
    });
    if (column.workers !== null) {
      const y = -(HEADER_H + HEADER_GAP);
      cells.push({
        id: headerCellId(agent),
        kind: 'header',
        agent,
        worker: null,
        x,
        y,
        width,
        height: HEADER_H,
      });
    }
    x += width + GAP_X;
  }

  if (grid.hasThreads) {
    rows.forEach((row, index) => {
      const y = row.top + (row.height - JSON_H) / 2;
      cells.push({
        id: jsonCellId(index + 1),
        kind: 'json',
        agent: '',
        worker: index + 1,
        x,
        y,
        width: JSON_W,
        height: JSON_H,
      });
    });
  }
  return cells;
}
