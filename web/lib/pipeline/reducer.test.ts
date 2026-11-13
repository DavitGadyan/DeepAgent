import { describe, expect, it } from 'vitest';
import { INITIAL_STATE, MAX_NODE_EVENTS, reduce, reduceAll, waitingCount } from './reducer';
import { T0, makeEvents } from './testEvents';

describe('reduce', () => {
  it('does not mutate the state it is given', () => {
    const { item } = makeEvents();
    const before = reduceAll([item('filter', 'item.started', 'a')]);
    const snapshot = structuredClone(before);

    reduce(before, item('filter', 'item.finished', 'a', { forwarded: true }, 12));

    expect(before).toEqual(snapshot);
    expect(INITIAL_STATE).toEqual({
      nodes: {},
      threads: {},
      queued: {},
      hops: {},
      rows: {},
      run: 'idle',
      lastTs: null,
    });
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

describe('reduce with parallel workers', () => {
  it('routes an item to the node of its worker and keeps the agent totals', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('extractor', 'item.started', 'a', { worker: 1 }),
      item('extractor', 'item.started', 'b', { worker: 2 }),
      item('extractor', 'item.finished', 'a', { worker: 1, forwarded: true }, 900),
    ]);

    expect(state.nodes['extractor#1']).toMatchObject({ status: 'done', in: 1, out: 1, job: 'a' });
    expect(state.nodes['extractor#2']).toMatchObject({
      status: 'running',
      in: 1,
      current: 'Job b',
    });
    expect(state.nodes.extractor).toMatchObject({ status: 'running', in: 2, out: 1 });
  });

  it('treats an event without a worker as worker 1', () => {
    const { item } = makeEvents();
    const state = reduceAll([item('filter', 'item.started', 'a')]);

    expect(state.nodes['filter#1']).toMatchObject({ status: 'running', in: 1 });
    expect(state.threads.a).toMatchObject({ agent: 'filter', worker: 1, path: ['filter#1'] });
  });

  it('keeps the scout as a single node and gives the applier the card of a row', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('scout', 'item.finished', 'a', { forwarded: true }),
      item('applier', 'item.started', 'a', { action: 'tailor' }),
    ]);

    expect(Object.keys(state.nodes).sort()).toEqual(['applier', 'applier#1', 'scout']);
    expect(state.threads.a).toMatchObject({ agent: 'applier', path: ['scout', 'applier#1'] });
  });

  it('counts the items a stage was handed and has not started', () => {
    const { item } = makeEvents();
    const events = [
      item('scout', 'item.finished', 'a', { forwarded: true }),
      item('scout', 'item.finished', 'b', { forwarded: true }),
      item('scout', 'item.finished', 'c', { forwarded: true }),
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true }),
      item('filter', 'item.started', 'b', { worker: 1 }),
      item('filter', 'item.dropped', 'b', { worker: 1, reason: 'no keyword' }),
    ];
    const queued = reduceAll(events.slice(0, 3));
    const working = reduceAll(events);

    expect(waitingCount(queued, 'filter')).toBe(3);
    expect(waitingCount(working, 'filter')).toBe(1);
    expect(waitingCount(working, 'extractor')).toBe(1);
    expect(waitingCount(working, 'scorer')).toBe(0);
  });

  it('does not queue an item that was not forwarded, or that the next stage already took', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('scorer', 'item.finished', 'low', { worker: 1, forwarded: false }),
      // Agents emit on their own: the extractor's start can overtake the filter's finish.
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('extractor', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true }),
    ]);

    expect(waitingCount(state, 'researcher')).toBe(0);
    expect(waitingCount(state, 'extractor')).toBe(0);
    expect(state.threads.a).toMatchObject({ agent: 'extractor', status: 'running' });
  });

  it('records the hop when a thread moves to the next worker, across rows too', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true }),
      item('extractor', 'item.started', 'a', { worker: 2 }),
    ]);

    expect(state.hops).toEqual({ 'filter#1->extractor#2': { at: T0 + 2000, job: 'a' } });
    expect(state.threads.a?.path).toEqual(['filter#1', 'extractor#2']);
  });

  it('remembers per row the thread a worker of that row took last', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.started', 'b', { worker: 2 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true }),
      item('extractor', 'item.started', 'a', { worker: 2 }),
    ]);

    expect(state.rows).toEqual({ 1: 'a', 2: 'a' });
  });

  it('gives the row to the thread the applier takes in it', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('researcher', 'item.started', 'b', { worker: 2 }),
      item('researcher', 'item.finished', 'b', { worker: 2, forwarded: false }),
      item('researcher', 'item.started', 'c', { worker: 2 }),
      item('applier', 'item.started', 'b', { action: 'tailor' }),
    ]);

    expect(state.rows).toEqual({ 1: 'a', 2: 'b' });
  });

  it('moves the thread, not the counters, on a progress event', () => {
    const { item } = makeEvents();
    const started = reduceAll([item('extractor', 'item.started', 'a', { worker: 1 })]);
    const state = reduce(
      started,
      item('extractor', 'item.progress', 'a', { worker: 1, node: 'facts' }),
    );

    expect(state.nodes).toEqual(started.nodes);
    expect(state.threads.a).toMatchObject({ status: 'running', graphNode: 'facts' });
  });

  it('sends an applier event, which has no worker, to the applier card in the row of its thread', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('researcher', 'item.started', 'a', { worker: 2 }),
      item('researcher', 'item.finished', 'a', { worker: 2, forwarded: false, brief: {} }),
      item('applier', 'item.started', 'a', { action: 'tailor' }),
    ]);

    expect(state.threads.a).toMatchObject({
      agent: 'applier',
      status: 'running',
      path: ['researcher#2', 'applier#2'],
    });
    expect(state.hops).toEqual({ 'researcher#2->applier#2': { at: T0 + 2000, job: 'a' } });
    expect(state.nodes['applier#2']).toMatchObject({ status: 'running', in: 1, job: 'a' });
    expect(state.nodes['applier#1']).toBeUndefined();
  });

  it('counts an applier event on the applier as a whole too', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('researcher', 'item.finished', 'a', { worker: 2, forwarded: false }),
      item('researcher', 'item.finished', 'b', { worker: 1, forwarded: false }),
      item('applier', 'item.started', 'a', { action: 'tailor' }),
      item('applier', 'item.finished', 'a', { action: 'tailor', forwarded: false }, 700),
      item('applier', 'item.started', 'b', { action: 'tailor' }),
    ]);

    expect(state.nodes['applier#2']).toMatchObject({ status: 'done', in: 1, out: 1, job: 'a' });
    expect(state.nodes['applier#1']).toMatchObject({ status: 'running', in: 1, out: 0, job: 'b' });
    expect(state.nodes.applier).toMatchObject({
      status: 'running',
      in: 2,
      out: 1,
      current: 'Job b',
    });
  });

  it('takes the row of the last stage a thread was in, not of the first', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true }),
      item('scorer', 'item.started', 'a', { worker: 3 }),
      item('scorer', 'item.finished', 'a', { worker: 3, forwarded: false }),
      item('applier', 'item.started', 'a', { action: 'tailor' }),
    ]);

    expect(state.threads.a?.path).toEqual(['filter#1', 'scorer#3', 'applier#3']);
  });

  it('keeps the applier on the card that already holds the job', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('researcher', 'item.finished', 'a', { worker: 2, forwarded: false }),
      item('applier', 'item.started', 'a', { action: 'tailor' }),
      item('applier', 'item.finished', 'a', { action: 'tailor', forwarded: false }),
      item('applier', 'item.started', 'a', { action: 'fill_form' }),
      item('applier', 'item.waiting', 'a', { action: 'fill_form', reason: 'Review the form.' }),
    ]);

    expect(state.threads.a?.path).toEqual(['researcher#2', 'applier#2']);
    expect(state.nodes['applier#2']).toMatchObject({ status: 'waiting', in: 2, out: 1, job: 'a' });
    expect(Object.keys(state.nodes).filter((id) => id.startsWith('applier#'))).toEqual([
      'applier#2',
    ]);
  });

  it('keeps the order of the pipeline when the scout reports a job after the filter took it', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      // The filter is fast: its events can be recorded before the scout's.
      item('filter', 'item.started', 'a', { worker: 2 }),
      item('filter', 'item.finished', 'a', { worker: 2, forwarded: true }),
      item('scout', 'item.finished', 'a', { forwarded: true, source: 'jobicy' }),
      item('extractor', 'item.started', 'a', { worker: 2 }),
    ]);

    expect(state.threads.a?.path).toEqual(['scout', 'filter#2', 'extractor#2']);
    // No link from the scout straight to the extractor, and nothing left waiting for the filter.
    expect(Object.keys(state.hops)).toEqual(['filter#2->extractor#2']);
    expect(state.queued.filter ?? {}).toEqual({});
  });

  it('frees a worker that was cut off when its job turns up at another worker', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('extractor', 'item.started', 'a', { worker: 2 }),
      // Worker 2 was stopped; after the restart worker 1 takes the redelivered job.
      item('extractor', 'item.started', 'a', { worker: 1 }),
    ]);

    expect(state.nodes['extractor#2']).toMatchObject({ status: 'done', active: {}, current: '' });
    expect(state.nodes['extractor#1']).toMatchObject({ status: 'running', job: 'a' });
    expect(state.nodes.extractor).toMatchObject({ status: 'running', in: 1 });
  });

  it('puts a lead from an earlier run, which has no row in this one, in row 1', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('applier', 'item.started', 'old', { action: 'tailor' }),
    ]);

    expect(state.threads.old).toMatchObject({ agent: 'applier', path: ['applier#1'] });
    expect(state.nodes['applier#1']).toMatchObject({ status: 'running', job: 'old' });
    // The JSON card of row 1 keeps the thread that runs there.
    expect(state.rows).toEqual({ 1: 'a' });
    expect(state.hops).toEqual({});
  });

  it('replays threads and queues to an earlier moment from a prefix of the log', () => {
    const { item } = makeEvents();
    const events = [
      item('scout', 'item.finished', 'a', { forwarded: true }),
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true }),
      item('extractor', 'item.started', 'a', { worker: 1 }),
      item('extractor', 'item.progress', 'a', { worker: 1, node: 'facts' }),
      item('extractor', 'item.progress', 'a', { worker: 1, node: 'highlights' }),
    ];
    const midway = reduceAll(events.slice(0, 3));

    expect(midway.threads.a).toMatchObject({ agent: 'filter', status: 'waiting' });
    expect(waitingCount(midway, 'extractor')).toBe(1);
    expect(reduceAll(events.slice(0, 5)).threads.a?.graphNode).toBe('facts');
    expect(reduceAll(events).threads.a).toMatchObject({
      graphNode: 'highlights',
      graphDone: ['facts'],
    });
  });
});
