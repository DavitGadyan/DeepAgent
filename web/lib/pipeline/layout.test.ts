import { describe, expect, it } from 'vitest';
import type { Pipeline } from '@/lib/types';
import {
  AGENT_H,
  AGENT_W,
  type Cell,
  JSON_H,
  layoutPipeline,
  pipelineEdges,
  pipelineGrid,
  SOURCE_H,
} from './layout';
import { makeNode, makePipeline } from './testEvents';

const PIPELINE: Pipeline = {
  nodes: [
    makeNode('source:a', 'source', { parent: 'scout' }),
    makeNode('source:b', 'source', { parent: 'scout' }),
    makeNode('scout', 'tool'),
    makeNode('filter', 'tool'),
    makeNode('extractor', 'llm'),
  ],
  edges: [
    { source: 'scout', target: 'filter' },
    { source: 'filter', target: 'extractor' },
  ],
};

/** Looks cells up by id; a missing one fails the test with its name. */
function byId(cells: Cell[]) {
  const map = new Map(cells.map((cell) => [cell.id, cell]));
  return (id: string): Cell => {
    const cell = map.get(id);
    if (!cell) throw new Error(`No cell ${id}`);
    return cell;
  };
}

const middle = (cell: Cell) => cell.y + cell.height / 2;
const overlap = (a: Cell, b: Cell) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('pipelineEdges', () => {
  it('adds the edge from a source into its parent when the API leaves it out', () => {
    expect(pipelineEdges(PIPELINE)).toContainEqual({ source: 'source:a', target: 'scout' });
  });

  it('does not duplicate an edge the API already lists', () => {
    const listed = {
      ...PIPELINE,
      edges: [...PIPELINE.edges, { source: 'source:a', target: 'scout' }],
    };
    const intoScout = pipelineEdges(listed).filter((edge) => edge.source === 'source:a');

    expect(intoScout).toHaveLength(1);
  });

  it('ignores edges that point at unknown nodes', () => {
    const dangling = { ...PIPELINE, edges: [{ source: 'scout', target: 'nowhere' }] };

    expect(pipelineEdges(dangling).some((edge) => edge.target === 'nowhere')).toBe(false);
  });
});

describe('pipelineGrid', () => {
  const workersOf = (grid: ReturnType<typeof pipelineGrid>) =>
    Object.fromEntries(grid.columns.map(({ node, workers }) => [node.id, workers]));

  it('has a row per worker of the largest stage and a card of every row agent in each', () => {
    const grid = pipelineGrid(makePipeline({ filter: 3, extractor: 3, scorer: 2 }));

    expect(grid.rows).toBe(3);
    expect(workersOf(grid)).toEqual({
      scout: null,
      filter: 3,
      extractor: 3,
      scorer: 3,
      researcher: 3,
      applier: 3,
    });
  });

  it('keeps one row, with the scout single, when every stage has one worker', () => {
    const grid = pipelineGrid(makePipeline());

    expect(grid.rows).toBe(1);
    expect(workersOf(grid)).toEqual({
      scout: null,
      filter: 1,
      extractor: 1,
      scorer: 1,
      researcher: 1,
      applier: 1,
    });
  });

  it('does not count the workers of the scout or the applier as rows', () => {
    const pipeline = makePipeline({ filter: 2 });
    const nodes = pipeline.nodes.map((node) =>
      node.id === 'scout' || node.id === 'applier' ? { ...node, workers: 5 } : node,
    );

    expect(pipelineGrid({ ...pipeline, nodes }).rows).toBe(2);
  });

  it('adds the rows an older run used when the pipeline has fewer workers now', () => {
    const grid = pipelineGrid(makePipeline({ extractor: 2 }), { extractor: 4, scorer: 1 });

    expect(grid.rows).toBe(4);
    expect(workersOf(grid)).toEqual({
      scout: null,
      filter: 4,
      extractor: 4,
      scorer: 4,
      researcher: 4,
      applier: 4,
    });
  });
});

describe('layoutPipeline with one worker', () => {
  const cells = layoutPipeline(pipelineGrid(makePipeline()));
  const at = byId(cells);

  it('places the stages left to right, sources first and the JSON card last', () => {
    const order = ['source:a', 'scout', 'filter#1', 'extractor#1', 'scorer#1', 'researcher#1'];
    const xs = [...order, 'applier#1', 'json#1'].map((id) => at(id).x);

    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('keeps everything on one line, as before workers existed', () => {
    const line = [
      'scout',
      'filter#1',
      'extractor#1',
      'scorer#1',
      'researcher#1',
      'applier#1',
      'json#1',
    ];

    expect(new Set(line.map((id) => middle(at(id)))).size).toBe(1);
    expect(cells.filter((cell) => cell.kind === 'json')).toHaveLength(1);
  });

  it('stacks the sources in one column without overlap', () => {
    const [a, b] = [at('source:a'), at('source:b')];

    expect(a.x).toBe(b.x);
    expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(SOURCE_H);
  });

  it('puts a header above every row agent column, the applier too, and none above the scout', () => {
    const headers = cells.filter((cell) => cell.kind === 'header').map((cell) => cell.agent);

    expect(headers).toEqual(['filter', 'extractor', 'scorer', 'researcher', 'applier']);
    for (const agent of ['filter', 'applier']) {
      const header = at(`header:${agent}`);
      expect(header.x).toBe(at(`${agent}#1`).x);
      expect(header.y + header.height).toBeLessThanOrEqual(at(`${agent}#1`).y);
    }
  });

  it('draws the applier as the card of the row, not as a single card', () => {
    expect(cells.some((cell) => cell.id === 'applier')).toBe(false);
    expect(at('applier#1')).toMatchObject({ kind: 'agent', agent: 'applier', worker: 1 });
    expect(at('scout')).toMatchObject({ kind: 'agent', agent: 'scout', worker: null });
  });
});

describe('layoutPipeline with several workers', () => {
  const grid = pipelineGrid(makePipeline({ filter: 3, extractor: 3, scorer: 2 }));
  const cells = layoutPipeline(grid);
  const at = byId(cells);

  it('draws a row per worker, with a card in every row for an agent with fewer workers too', () => {
    const ids = cells.filter((cell) => cell.kind === 'agent').map((cell) => cell.id);

    expect(ids).toEqual([
      'scout',
      'filter#1',
      'filter#2',
      'filter#3',
      'extractor#1',
      'extractor#2',
      'extractor#3',
      'scorer#1',
      'scorer#2',
      'scorer#3',
      'researcher#1',
      'researcher#2',
      'researcher#3',
      'applier#1',
      'applier#2',
      'applier#3',
    ]);
    expect(cells.filter((cell) => cell.kind === 'json').map((cell) => cell.id)).toEqual([
      'json#1',
      'json#2',
      'json#3',
    ]);
  });

  it('lines the cards of one row up with each other and with the row JSON card', () => {
    for (const row of [1, 2, 3]) {
      const agents = ['filter', 'extractor', 'scorer', 'researcher', 'applier'];
      const line = [...agents.map((agent) => `${agent}#${row}`), `json#${row}`];
      expect(new Set(line.map((id) => middle(at(id)))).size).toBe(1);
    }
  });

  it('puts the rows under each other without overlap', () => {
    expect(at('filter#2').y).toBeGreaterThanOrEqual(at('filter#1').y + JSON_H);
    expect(at('filter#3').y).toBeGreaterThanOrEqual(at('filter#2').y + JSON_H);
    expect(at('filter#1').x).toBe(at('filter#3').x);
  });

  it('centres the scout beside the grid and stacks the applier cards in their column', () => {
    expect(middle(at('scout'))).toBe(middle(at('filter#2')));
    expect(at('applier#1').x).toBe(at('applier#3').x);
    expect(at('applier#1').x).toBeGreaterThan(at('researcher#1').x);
    expect(at('applier#1').x).toBeLessThan(at('json#1').x);
    expect(at('header:applier').x).toBe(at('applier#1').x);
  });

  it('never lets two cards overlap', () => {
    const clash = cells.flatMap((a, index) =>
      cells.slice(index + 1).flatMap((b) => (overlap(a, b) ? [`${a.id}/${b.id}`] : [])),
    );

    expect(clash).toEqual([]);
  });
});

describe('layoutPipeline with an expanded card', () => {
  const grid = pipelineGrid(makePipeline({ filter: 3, extractor: 3, scorer: 2 }));
  const collapsed = byId(layoutPipeline(grid));
  const size = { width: AGENT_W + 60, height: AGENT_H + 200 };
  const cells = layoutPipeline(grid, { 'extractor#2': size });
  const at = byId(cells);

  it('gives the expanded card its size', () => {
    expect(at('extractor#2')).toMatchObject(size);
  });

  it('makes the row higher and moves the rows below it down', () => {
    const grown = size.height - JSON_H;

    expect(at('filter#3').y - collapsed('filter#3').y).toBe(grown);
    expect(at('filter#1').y).toBe(collapsed('filter#1').y);
    expect(middle(at('filter#2'))).toBe(middle(at('extractor#2')));
    expect(middle(at('json#2'))).toBe(middle(at('extractor#2')));
  });

  it('makes the column wider and moves the columns after it to the right', () => {
    expect(at('scorer#1').x - collapsed('scorer#1').x).toBe(60);
    expect(at('json#1').x - collapsed('json#1').x).toBe(60);
    expect(at('filter#1').x).toBe(collapsed('filter#1').x);
    expect(at('header:extractor').width).toBe(size.width);
  });

  it('still lets no two cards overlap', () => {
    const clash = cells.flatMap((a, index) =>
      cells.slice(index + 1).flatMap((b) => (overlap(a, b) ? [`${a.id}/${b.id}`] : [])),
    );

    expect(clash).toEqual([]);
  });

  it('makes room for an expanded single agent too', () => {
    const tall = { width: AGENT_W + 40, height: 3 * JSON_H + 400 };
    const expanded = byId(layoutPipeline(grid, { scout: tall }));

    expect(expanded('scout')).toMatchObject(tall);
    expect(expanded('filter#1').x - collapsed('filter#1').x).toBe(40);
    expect(middle(expanded('scout'))).toBe(middle(expanded('filter#2')));
  });
});
