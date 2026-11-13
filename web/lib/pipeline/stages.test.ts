import { describe, expect, it } from 'vitest';
import {
  eventNodeId,
  eventWorker,
  holdsThread,
  nextStage,
  parseNodeId,
  pipelineWorkers,
  seenWorkers,
} from './stages';
import { makeEvents, makePipeline } from './testEvents';

describe('node ids', () => {
  it('gives a stage event the node of its worker', () => {
    const { item } = makeEvents();

    expect(eventNodeId(item('scorer', 'item.started', 'a', { worker: 3 }))).toBe('scorer#3');
    expect(eventNodeId(item('scorer', 'item.started', 'a'))).toBe('scorer#1');
  });

  it('gives the scout and the applier their own id', () => {
    const { item } = makeEvents();

    expect(eventNodeId(item('scout', 'item.finished', 'a'))).toBe('scout');
    expect(eventNodeId(item('applier', 'item.started', 'a', { worker: 2 }))).toBe('applier');
  });

  it('reads a worker number only when it is one', () => {
    const { item } = makeEvents();
    const worker = (value: unknown) =>
      eventWorker(item('filter', 'item.started', 'a', { worker: value }));

    expect([worker(2), worker(0), worker('2'), worker(undefined)]).toEqual([2, 1, 1, 1]);
  });

  it('splits a node id into agent and worker', () => {
    expect(parseNodeId('extractor#12')).toEqual({ agent: 'extractor', worker: 12 });
    expect(parseNodeId('scout')).toEqual({ agent: 'scout', worker: null });
    expect(parseNodeId('source:remoteok')).toEqual({ agent: 'source:remoteok', worker: null });
  });
});

describe('stage order', () => {
  it('hands an item from the scout through the stages, and no further', () => {
    expect(nextStage('scout')).toBe('filter');
    expect(nextStage('scorer')).toBe('researcher');
    expect(nextStage('researcher')).toBeNull();
    expect(nextStage('applier')).toBeNull();
  });

  it('knows which cards show a thread', () => {
    expect(['scout', 'filter', 'researcher', 'applier'].map(holdsThread)).toEqual([
      false,
      true,
      true,
      true,
    ]);
  });
});

describe('worker counts', () => {
  it('finds the highest worker number each stage used in a log', () => {
    const { item, event } = makeEvents();
    const events = [
      event('orchestrator', 'run.started'),
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('extractor', 'item.started', 'a', { worker: 3 }),
      item('extractor', 'item.progress', 'b', { worker: 2, node: 'facts' }),
      item('applier', 'item.started', 'a', { worker: 9 }),
    ];

    expect(seenWorkers(events)).toEqual({ filter: 1, extractor: 3 });
  });

  it('prefills the Start popover with the highest count of any stage', () => {
    expect(pipelineWorkers(makePipeline({ scorer: 4, filter: 2 }).nodes)).toBe(4);
    expect(pipelineWorkers(makePipeline().nodes)).toBe(1);
    expect(pipelineWorkers([])).toBe(1);
  });
});
