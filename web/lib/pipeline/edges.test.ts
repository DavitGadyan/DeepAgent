import { describe, expect, it } from 'vitest';
import {
  FLOW_GLOW_MS,
  type FlowEdge,
  gridEdges,
  litEdgeIds,
  pathEdgeIds,
  withExtraEdges,
} from './edges';
import { layoutPipeline, pipelineGrid } from './layout';
import { reduceAll } from './reducer';
import { T0, makeEvents, makePipeline } from './testEvents';

const PIPELINE = makePipeline({ filter: 2, extractor: 2, scorer: 2 });
const GRID = pipelineGrid(PIPELINE);
const ids = (edges: FlowEdge[]) => edges.map((edge) => edge.id);

describe('gridEdges', () => {
  const edges = gridEdges(PIPELINE, GRID);
  const role = (id: string) => edges.find((edge) => edge.id === id)?.role;

  it('joins every source to the scout and the scout to every filter worker', () => {
    expect(ids(edges)).toEqual(
      expect.arrayContaining([
        'source:a->scout',
        'source:b->scout',
        'scout->filter#1',
        'scout->filter#2',
      ]),
    );
  });

  it('joins two stages row by row only', () => {
    const between = ids(edges).filter((id) => id.startsWith('filter#'));

    expect(between).toEqual(['filter#1->extractor#1', 'filter#2->extractor#2']);
  });

  it('joins a row to the end, also where an agent has fewer workers than rows', () => {
    const fromScorer = ids(edges).filter((id) => id.startsWith('scorer#'));
    const fromResearcher = ids(edges).filter((id) => id.startsWith('researcher#'));

    expect(fromScorer).toEqual(['scorer#1->researcher#1', 'scorer#2->researcher#2']);
    expect(fromResearcher).toEqual(['researcher#1->applier#1', 'researcher#2->applier#2']);
  });

  it('marks the edges into the human-gated applier, in every row', () => {
    expect(role('researcher#1->applier#1')).toBe('gate');
    expect(role('researcher#2->applier#2')).toBe('gate');
    expect(role('scout->filter#1')).toBe('flow');
    expect(role('scorer#2->researcher#2')).toBe('flow');
  });

  it('feeds the JSON card of every row from the applier card of that row', () => {
    const connectors = edges.filter((edge) => edge.role === 'json');

    expect(ids(connectors)).toEqual(['applier#1->json#1', 'applier#2->json#2']);
  });

  it('never ends an edge at a single applier card', () => {
    const ends = edges.flatMap((edge) => [edge.source, edge.target]);

    expect(ends).not.toContain('applier');
  });

  it('draws the single row of a pipeline with one worker', () => {
    const pipeline = makePipeline();

    expect(ids(gridEdges(pipeline, pipelineGrid(pipeline)))).toEqual([
      'scout->filter#1',
      'filter#1->extractor#1',
      'extractor#1->scorer#1',
      'scorer#1->researcher#1',
      'researcher#1->applier#1',
      'source:a->scout',
      'source:b->scout',
      'applier#1->json#1',
    ]);
  });
});

describe('withExtraEdges', () => {
  const base = gridEdges(PIPELINE, GRID);
  const known = new Set(layoutPipeline(GRID).map((cell) => cell.id));

  it('never joins two rows: a thread that changed rows in an older run gets no edge', () => {
    expect(withExtraEdges(base, ['filter#1->extractor#2'], GRID, known)).toBe(base);
    expect(withExtraEdges(base, ['scorer#2->applier#1'], GRID, known)).toBe(base);
  });

  it('draws no direct edge from the scout past the filter', () => {
    expect(withExtraEdges(base, ['scout->extractor#1'], GRID, known)).toBe(base);
  });

  it('adds a dashed edge inside a row for a thread that went to the applier without research', () => {
    const edges = withExtraEdges(base, ['scorer#2->applier#2'], GRID, known);

    expect(edges).toHaveLength(base.length + 1);
    expect(edges.at(-1)).toEqual({
      id: 'scorer#2->applier#2',
      source: 'scorer#2',
      target: 'applier#2',
      role: 'gate',
    });
  });

  it('skips an edge into the applier itself, which has no card of its own', () => {
    expect(withExtraEdges(base, ['scorer#2->applier'], GRID, known)).toBe(base);
  });

  it('returns the same edges when nothing is missing', () => {
    expect(withExtraEdges(base, ['scout->filter#1'], GRID, known)).toBe(base);
  });

  it('skips an edge whose worker is not on the graph', () => {
    expect(withExtraEdges(base, ['filter#1->extractor#9'], GRID, known)).toBe(base);
  });
});

describe('litEdgeIds', () => {
  it('lights the edge a thread moved along while the next worker has it', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true }),
      item('extractor', 'item.started', 'a', { worker: 2 }),
    ]);

    expect(litEdgeIds(state, PIPELINE, T0 + 60_000)).toEqual(['filter#1->extractor#2']);
  });

  it('keeps the edge lit for a moment after the worker is done with the thread', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('scout', 'item.finished', 'a', { forwarded: true }),
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.dropped', 'a', { worker: 1, reason: 'no keyword' }),
    ]);
    const movedAt = T0 + 1000;

    expect(litEdgeIds(state, PIPELINE, movedAt + FLOW_GLOW_MS - 1)).toEqual(['scout->filter#1']);
    expect(litEdgeIds(state, PIPELINE, movedAt + FLOW_GLOW_MS)).toEqual([]);
  });

  it('stays dark while a forwarded thread waits for a free worker', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true }),
    ]);

    expect(litEdgeIds(state, PIPELINE, T0 + 1000)).toEqual([]);
  });

  it('lights the dashed edge of the row when the applier takes a thread', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('researcher', 'item.finished', 'a', { worker: 2, forwarded: false }),
      item('applier', 'item.started', 'a', { action: 'tailor' }),
    ]);

    expect(litEdgeIds(state, PIPELINE, T0 + 60_000)).toEqual(['researcher#2->applier#2']);
  });

  it('lights a source edge only while that source is being fetched', () => {
    const { source } = makeEvents();
    const state = reduceAll([
      source('source.started', 'a'),
      source('source.started', 'b'),
      source('source.finished', 'a', { count: 3 }),
    ]);
    const finishedAt = T0 + 2000;

    expect(litEdgeIds(state, PIPELINE, finishedAt)).toEqual(['source:a->scout', 'source:b->scout']);
    expect(litEdgeIds(state, PIPELINE, finishedAt + FLOW_GLOW_MS)).toEqual(['source:b->scout']);
  });
});

describe('pathEdgeIds', () => {
  it('names the edges between the nodes a thread visited', () => {
    expect(pathEdgeIds(['source:a', 'scout', 'filter#2'])).toEqual([
      'source:a->scout',
      'scout->filter#2',
    ]);
    expect(pathEdgeIds(['scout'])).toEqual([]);
  });
});
