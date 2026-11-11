import { describe, expect, it } from 'vitest';
import { FLOW_GLOW_MS, flowingEdgeIds, isFlowing } from './edges';
import { reduceAll } from './reducer';
import { T0, makeEvents } from './testEvents';

const FILTER_TO_EXTRACTOR = { source: 'filter', target: 'extractor' };
const JOBICY_TO_SCOUT = { source: 'source:jobicy', target: 'scout' };

describe('isFlowing', () => {
  it('lights an edge while the downstream node is working', () => {
    const { item } = makeEvents();
    const state = reduceAll([item('extractor', 'item.started', 'a')]);

    expect(isFlowing(state, FILTER_TO_EXTRACTOR, T0 + 60_000)).toBe(true);
  });

  it('lights an edge for a moment after the upstream node forwards an item', () => {
    const { item } = makeEvents();
    const state = reduceAll([item('filter', 'item.finished', 'a', { forwarded: true })]);

    expect(isFlowing(state, FILTER_TO_EXTRACTOR, T0 + FLOW_GLOW_MS - 1)).toBe(true);
    expect(isFlowing(state, FILTER_TO_EXTRACTOR, T0 + FLOW_GLOW_MS)).toBe(false);
  });

  it('stays dark for an item that was not forwarded', () => {
    const { item } = makeEvents();
    const state = reduceAll([item('filter', 'item.finished', 'a', { forwarded: false })]);

    expect(isFlowing(state, FILTER_TO_EXTRACTOR, T0)).toBe(false);
  });

  it('lights a source edge only while that source is being fetched', () => {
    const { source } = makeEvents();
    const state = reduceAll([
      source('source.started', 'jobicy'),
      source('source.started', 'remoteok'),
      source('source.finished', 'jobicy', { count: 3 }),
    ]);
    const finishedAt = T0 + 2000;

    expect(isFlowing(state, JOBICY_TO_SCOUT, finishedAt + FLOW_GLOW_MS)).toBe(false);
    expect(isFlowing(state, { source: 'source:remoteok', target: 'scout' }, finishedAt)).toBe(true);
  });
});

describe('flowingEdgeIds', () => {
  it('returns the ids of the lit edges in edge order', () => {
    const { item } = makeEvents();
    const state = reduceAll([item('extractor', 'item.started', 'a')]);
    const edges = [{ source: 'scout', target: 'filter' }, FILTER_TO_EXTRACTOR];

    expect(flowingEdgeIds(state, edges, T0)).toEqual(['filter->extractor']);
  });
});
