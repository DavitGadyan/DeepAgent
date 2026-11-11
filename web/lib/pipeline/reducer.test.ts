import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, MAX_NODE_EVENTS, reduce, reduceAll } from './reducer';
import { T0, makeEvents } from './testEvents';

describe('reduce', () => {
  it('does not mutate the state it is given', () => {
    const { item } = makeEvents();
    const before = reduceAll([item('filter', 'item.started', 'a')]);
    const snapshot = structuredClone(before);

    reduce(before, item('filter', 'item.finished', 'a', { forwarded: true }, 12));

    expect(before).toEqual(snapshot);
    expect(INITIAL_STATE).toEqual({ nodes: {}, run: 'idle', lastTs: null });
  });

  it('tracks the run phase and the time of the last event', () => {
    const { event } = makeEvents();
    const started = reduce(INITIAL_STATE, event('orchestrator', 'run.started'));
    const finished = reduce(started, event('orchestrator', 'run.finished'));

    expect(started).toMatchObject({ run: 'running', lastTs: T0 });
    expect(finished).toMatchObject({ run: 'finished', lastTs: T0 + 1000 });
  });

  it('marks a node running with its current item while an item is in progress', () => {
    const { item } = makeEvents();
    const state = reduceAll([item('extractor', 'item.started', 'a')]);

    expect(state.nodes.extractor).toMatchObject({ status: 'running', in: 1, current: 'Job a' });
  });

  it('counts finished, dropped and failed items and settles the status', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('filter', 'item.started', 'a'),
      item('filter', 'item.finished', 'a', { forwarded: true }, 40),
      item('filter', 'item.started', 'b'),
      item('filter', 'item.dropped', 'b', { reason: 'no keyword' }),
      item('filter', 'item.started', 'c'),
      item('filter', 'item.failed', 'c', { error: 'boom' }),
    ]);

    expect(state.nodes.filter).toMatchObject({
      status: 'failed',
      in: 3,
      out: 1,
      dropped: 1,
      failed: 1,
      current: '',
      lastDurationMs: 40,
    });
  });

  it('returns to done when a later item succeeds after a failure', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('scorer', 'item.failed', 'a', { error: 'boom' }),
      item('scorer', 'item.started', 'b'),
      item('scorer', 'item.finished', 'b', { forwarded: true }),
    ]);

    expect(state.nodes.scorer).toMatchObject({ status: 'done', in: 2, out: 1, failed: 1 });
  });

  it('keeps running while another item is still in progress', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('extractor', 'item.started', 'a'),
      item('extractor', 'item.started', 'b'),
      item('extractor', 'item.finished', 'b', { forwarded: true }),
    ]);

    expect(state.nodes.extractor).toMatchObject({ status: 'running', current: 'Job a', out: 1 });
  });

  it('counts an item that finishes without a start event as having entered', () => {
    const { item } = makeEvents();
    const state = reduceAll([item('scout', 'item.finished', 'a', { forwarded: true })]);

    expect(state.nodes.scout).toMatchObject({ status: 'done', in: 1, out: 1 });
  });

  it('records the hand-over time only for forwarded items', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('scorer', 'item.finished', 'a', { forwarded: true }),
      item('scorer', 'item.finished', 'b', { forwarded: false }),
    ]);

    expect(state.nodes.scorer).toMatchObject({ out: 2, lastForwardAt: T0 });
  });

  it('shows a node as waiting while an item is blocked on the human', () => {
    const { item } = makeEvents();
    const waiting = reduceAll([
      item('applier', 'item.started', 'a'),
      item('applier', 'item.waiting', 'a', { reason: 'review the form' }),
    ]);
    const resumed = reduce(waiting, item('applier', 'item.finished', 'a', { forwarded: false }));

    expect(waiting.nodes.applier).toMatchObject({ status: 'waiting', in: 1, current: 'Job a' });
    expect(resumed.nodes.applier).toMatchObject({ status: 'done', in: 1, out: 1, current: '' });
  });

  it('drives source nodes and keeps the scout busy while a source is fetching', () => {
    const { source, event } = makeEvents();
    const fetching = reduceAll([
      source('source.started', 'jobicy'),
      source('source.started', 'remoteok'),
      source('source.finished', 'jobicy', { count: 14 }),
    ]);
    const settled = reduceAll([
      source('source.started', 'jobicy'),
      source('source.finished', 'jobicy', { count: 14 }),
      source('source.started', 'remoteok'),
      source('source.failed', 'remoteok', { error: 'HTTP 429' }),
      event('scout', 'scout.done'),
    ]);

    expect(fetching.nodes['source:jobicy']).toMatchObject({ status: 'done', count: 14 });
    expect(fetching.nodes['source:remoteok']).toMatchObject({ status: 'running' });
    expect(fetching.nodes.scout).toMatchObject({ status: 'running', current: 'Fetching remoteok' });
    expect(settled.nodes['source:remoteok']).toMatchObject({ status: 'failed' });
    expect(settled.nodes.scout).toMatchObject({ status: 'done', current: '' });
  });

  it('keeps only the most recent events per node, newest first', () => {
    const { item } = makeEvents();
    const events = Array.from({ length: MAX_NODE_EVENTS + 5 }, (_, i) =>
      item('filter', 'item.dropped', `j${i}`),
    );
    const log = reduceAll(events).nodes.filter?.events ?? [];

    expect(log).toHaveLength(MAX_NODE_EVENTS);
    expect(log[0]?.job_id).toBe(`j${MAX_NODE_EVENTS + 4}`);
  });

  it('reproduces an earlier moment when given a prefix of the log', () => {
    const { item } = makeEvents();
    const events = [
      item('filter', 'item.started', 'a'),
      item('filter', 'item.finished', 'a', { forwarded: true }),
      item('extractor', 'item.started', 'a'),
      item('extractor', 'item.finished', 'a', { forwarded: true }),
    ];
    const midway = reduceAll(events.slice(0, 3));

    expect(midway.nodes.filter?.status).toBe('done');
    expect(midway.nodes.extractor?.status).toBe('running');
    expect(reduceAll(events).nodes.extractor?.status).toBe('done');
  });
});
