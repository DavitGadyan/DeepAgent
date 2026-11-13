import { describe, expect, it } from 'vitest';
import type { EventType, PipelineEvent } from '@/lib/types';
import {
  completeNodes,
  END,
  fixedStepStates,
  graphNodeStates,
  START,
  threadPlace,
} from './agentGraph';
import { EMPTY_NODE, reduceAll } from './reducer';
import { CHAIN, LOOP, makeEvents, makeNode } from './testEvents';

const threadOf = (events: PipelineEvent[]) => reduceAll(events).threads.a;

describe('completeNodes', () => {
  it('names start and end plainly and keeps the other labels', () => {
    expect(completeNodes(CHAIN)).toEqual([
      { id: START, label: 'Start' },
      { id: 'facts', label: 'facts' },
      { id: 'highlights', label: 'highlights' },
      { id: 'tidy', label: 'tidy' },
      { id: END, label: 'End' },
    ]);
  });

  it('adds start and end when the shape lists them only as edge ends', () => {
    const nodes = completeNodes({
      nodes: [{ id: 'judge', label: 'Judge' }],
      edges: [
        { source: START, target: 'judge', conditional: false },
        { source: 'judge', target: END, conditional: false },
      ],
    });

    expect(nodes).toEqual([
      { id: 'judge', label: 'Judge' },
      { id: START, label: 'Start' },
      { id: END, label: 'End' },
    ]);
  });
});

describe('graphNodeStates', () => {
  const { item } = makeEvents();
  const events = [
    item('extractor', 'item.started', 'a', { worker: 2 }),
    item('extractor', 'item.progress', 'a', { worker: 2, node: 'facts' }),
    item('extractor', 'item.progress', 'a', { worker: 2, node: 'highlights' }),
    item('extractor', 'item.finished', 'a', { worker: 2, forwarded: true }),
    item('scorer', 'item.started', 'a', { worker: 1 }),
  ];

  it('is all pending on a card the thread never reached', () => {
    const states = graphNodeStates(CHAIN, threadOf(events), 'extractor#1');

    expect(new Set(Object.values(states))).toEqual(new Set(['pending']));
    expect(graphNodeStates(CHAIN, undefined, 'extractor#2').facts).toBe('pending');
  });

  it('glows the node the thread is in and ticks the ones before it', () => {
    expect(graphNodeStates(CHAIN, threadOf(events.slice(0, 1)), 'extractor#2')).toEqual({
      [START]: 'done',
      facts: 'pending',
      highlights: 'pending',
      tidy: 'pending',
      [END]: 'pending',
    });
    expect(graphNodeStates(CHAIN, threadOf(events.slice(0, 3)), 'extractor#2')).toEqual({
      [START]: 'done',
      facts: 'done',
      highlights: 'active',
      tidy: 'pending',
      [END]: 'pending',
    });
  });

  it('is all done once the thread finished here, and after it moved on', () => {
    for (const count of [4, 5]) {
      const states = graphNodeStates(CHAIN, threadOf(events.slice(0, count)), 'extractor#2');
      expect(new Set(Object.values(states))).toEqual(new Set(['done']));
    }
  });

  it('ticks what ran before the node a resumed thread continued at', () => {
    const { item: next } = makeEvents();
    const thread = threadOf([
      next('extractor', 'item.started', 'a'),
      next('extractor', 'item.progress', 'a', { node: 'highlights', resumed: true }),
    ]);

    expect(graphNodeStates(CHAIN, thread, 'extractor#1')).toMatchObject({
      [START]: 'done',
      facts: 'done',
      highlights: 'active',
      tidy: 'pending',
    });
  });

  it('shows the model active again when the loop comes back to it', () => {
    const { item: next } = makeEvents();
    const thread = threadOf([
      next('researcher', 'item.started', 'a'),
      next('researcher', 'item.progress', 'a', { node: 'model' }),
      next('researcher', 'item.progress', 'a', { node: 'tools' }),
      next('researcher', 'item.progress', 'a', { node: 'model' }),
    ]);

    expect(graphNodeStates(LOOP, thread, 'researcher#1')).toEqual({
      [START]: 'done',
      model: 'active',
      tools: 'done',
      [END]: 'pending',
    });
  });

  it('marks the node a thread failed in', () => {
    const { item: next } = makeEvents();
    const thread = threadOf([
      next('extractor', 'item.started', 'a'),
      next('extractor', 'item.progress', 'a', { node: 'facts' }),
      next('extractor', 'item.failed', 'a', { error: 'invalid JSON' }),
    ]);

    expect(graphNodeStates(CHAIN, thread, 'extractor#1').facts).toBe('failed');
    expect(threadPlace(CHAIN, thread, 'extractor#1')).toBe('Failed in facts');
  });
});

describe('threadPlace', () => {
  const { item } = makeEvents();
  const events = [
    item('extractor', 'item.started', 'a'),
    item('extractor', 'item.progress', 'a', { node: 'highlights', resumed: true }),
    item('extractor', 'item.progress', 'a', { node: 'tidy' }),
    item('extractor', 'item.finished', 'a', { forwarded: true }),
    item('scorer', 'item.started', 'a'),
  ];
  const place = (count: number, card = 'extractor#1') =>
    threadPlace(CHAIN, threadOf(events.slice(0, count)), card);

  it('says where the thread is inside the agent', () => {
    expect(place(0)).toBe('No thread yet');
    expect(place(1)).toBe('Starting');
    expect(place(2)).toBe('Resumed at highlights');
    expect(place(3)).toBe('Resumed at highlights, now in tidy');
    expect(place(4)).toBe('Resumed at highlights, finished');
    expect(place(5)).toBe('Finished here');
    expect(place(5, 'extractor#2')).toBe('No thread yet');
  });

  it('names the node of a thread that ran from the start', () => {
    const { item: next } = makeEvents();
    const thread = threadOf([next('scorer', 'item.progress', 'a', { node: 'model' })]);

    expect(threadPlace(LOOP, thread, 'scorer#1')).toBe('In model');
  });
});

describe('fixedStepStates', () => {
  const applier = makeNode('applier', 'human', { steps: ['Tailor', 'Fill', 'Stop'] });
  const filter = makeNode('filter', 'tool', { steps: ['Keywords', 'Embedding', 'Text'] });
  /** The applier's states after its events `steps`, each [type, action]. */
  const after = (...steps: [EventType, string][]) => {
    const { item } = makeEvents();
    const events = steps.map(([type, action]) => item('applier', type, 'a', { action }));
    return fixedStepStates(applier, reduceAll(events).nodes.applier ?? EMPTY_NODE);
  };

  it('is all pending before the applier did anything', () => {
    expect(fixedStepStates(applier, EMPTY_NODE)).toEqual(['pending', 'pending', 'pending']);
  });

  it('is all pending for an agent whose events name no action', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true }),
    ]);

    expect(fixedStepStates(filter, state.nodes['filter#1'] ?? EMPTY_NODE)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('has as many states as the agent has steps', () => {
    expect(fixedStepStates(makeNode('scorer', 'llm'), EMPTY_NODE)).toEqual([]);
  });

  it('shows the first step active while the applier tailors the CV', () => {
    expect(after(['item.started', 'tailor'])).toEqual(['active', 'pending', 'pending']);
  });

  it('ticks the first step when tailoring finished, and marks it when it failed', () => {
    expect(after(['item.started', 'tailor'], ['item.finished', 'tailor'])).toEqual([
      'done',
      'pending',
      'pending',
    ]);
    expect(after(['item.started', 'tailor'], ['item.failed', 'tailor'])).toEqual([
      'failed',
      'pending',
      'pending',
    ]);
  });

  it('shows the second step active while the form is filled and while it waits for the human', () => {
    const tailored: [EventType, string][] = [
      ['item.started', 'tailor'],
      ['item.finished', 'tailor'],
    ];
    const filling = after(...tailored, ['item.started', 'fill_form']);
    const waiting = after(
      ...tailored,
      ['item.started', 'fill_form'],
      ['item.waiting', 'fill_form'],
    );

    expect(filling).toEqual(['done', 'active', 'pending']);
    expect(waiting).toEqual(['done', 'active', 'pending']);
  });

  it('marks the second step when filling the form failed', () => {
    expect(after(['item.started', 'fill_form'], ['item.failed', 'fill_form'])).toEqual([
      'done',
      'failed',
      'pending',
    ]);
  });

  it('ticks every step once the form is filled: the applier stopped before Submit', () => {
    expect(after(['item.started', 'fill_form'], ['item.finished', 'fill_form'])).toEqual([
      'done',
      'done',
      'done',
    ]);
  });

  it('follows the newest event that names an action, on the card of the row too', () => {
    const { item } = makeEvents();
    const state = reduceAll([
      item('researcher', 'item.finished', 'a', { worker: 2, forwarded: false }),
      item('applier', 'item.started', 'a', { action: 'tailor' }),
      item('applier', 'item.finished', 'a', { action: 'tailor', forwarded: false }),
      item('applier', 'item.started', 'a', { action: 'fill_form' }),
      item('applier', 'item.started', 'a'),
    ]);

    expect(fixedStepStates(applier, state.nodes['applier#2'] ?? EMPTY_NODE)).toEqual([
      'done',
      'active',
      'pending',
    ]);
  });

  it('ignores an action it does not know', () => {
    expect(after(['item.started', 'tailor'], ['item.started', 'submit'])).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });
});
