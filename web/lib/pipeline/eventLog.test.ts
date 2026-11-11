import { describe, expect, it } from 'vitest';
import { belongsToRun, mergeEvents } from './eventLog';
import { reduceAll } from './reducer';
import { T0, makeEvents } from './testEvents';

const RUN = { id: 'run-1', started_at: new Date(T0).toISOString() };

describe('belongsToRun', () => {
  const { event, item } = makeEvents();
  const started = event('orchestrator', 'run.started');
  const applier = item('applier', 'item.started', 'a');
  const before = { ...applier, run_id: '', ts: new Date(T0 - 1000).toISOString() };

  it("keeps the run's own events and drops other runs'", () => {
    expect(belongsToRun(started, RUN)).toBe(true);
    expect(belongsToRun({ ...started, run_id: 'run-2' }, RUN)).toBe(false);
  });

  it('keeps applier events from the start of the run onwards', () => {
    expect(belongsToRun({ ...applier, run_id: '' }, RUN)).toBe(true);
    expect(belongsToRun(before, RUN)).toBe(false);
  });

  it('keeps every applier event when no run is selected', () => {
    expect(belongsToRun(before, null)).toBe(true);
    expect(belongsToRun(started, null)).toBe(false);
  });

  it('ignores run-less events of other agents', () => {
    expect(belongsToRun({ ...item('scorer', 'item.started', 'b'), run_id: '' }, RUN)).toBe(false);
  });
});

describe('mergeEvents', () => {
  it('interleaves applier events with the run history by time', () => {
    const { event, item } = makeEvents();
    const started = event('orchestrator', 'run.started');
    const tailor = { ...item('applier', 'item.started', 'a'), run_id: '' };
    const scored = item('scorer', 'item.finished', 'b');

    const merged = mergeEvents([started, scored], [tailor]);

    expect(merged.map((e) => e.id)).toEqual([started.id, tailor.id, scored.id]);
  });

  it('skips events it already has, including duplicates within the batch', () => {
    const { item } = makeEvents();
    const a = item('applier', 'item.started', 'a');
    const b = item('applier', 'item.finished', 'a');

    expect(mergeEvents([a], [a, b, b]).map((e) => e.id)).toEqual([a.id, b.id]);
  });

  it('returns the same array when nothing is new', () => {
    const { item } = makeEvents();
    const log = [item('applier', 'item.started', 'a')];

    expect(mergeEvents(log, [...log])).toBe(log);
  });

  it('keeps the order of events with the same time', () => {
    const { item } = makeEvents();
    const first = item('filter', 'item.started', 'a');
    const second = { ...item('filter', 'item.finished', 'a'), ts: first.ts };

    expect(mergeEvents([], [first, second])).toEqual([first, second]);
  });

  it('places a fetched event that is older than the streamed ones', () => {
    const { item } = makeEvents();
    const older = item('applier', 'item.started', 'a');
    const newer = item('applier', 'item.finished', 'a');

    expect(mergeEvents([newer], [older])).toEqual([older, newer]);
  });
});

describe('the merged log', () => {
  it('shows the applier running after a reload, from the fetched applier events', () => {
    const { event, item } = makeEvents();
    const history = [event('orchestrator', 'run.started'), event('orchestrator', 'run.finished')];
    const applier = [{ ...item('applier', 'item.started', 'a'), run_id: '' }];

    const state = reduceAll(mergeEvents(history, applier).filter((e) => belongsToRun(e, RUN)));

    expect(state.nodes.applier).toMatchObject({ status: 'running', current: 'Job a' });
  });
});
