import { describe, expect, it } from 'vitest';
import type { PipelineEvent } from '@/lib/types';
import { eventNodeId } from './stages';
import { makeEvents } from './testEvents';
import {
  applyEvent,
  describeThread,
  fitLabel,
  rankThreads,
  splitTitle,
  type Thread,
  threadFields,
  threadJson,
  threadPath,
} from './threads';

/** Folds events of one job into its thread, the way the reducer does. */
const follow = (events: PipelineEvent[]): Thread =>
  events.reduce<Thread | undefined>(
    (thread, event) => applyEvent(thread, event, eventNodeId(event)),
    undefined,
  ) as Thread;

const EXTRACTED = {
  contract_type: 'freelance',
  remote_policy: 'remote',
  locations: ['Germany', 'Austria'],
  salary_min: 70000,
  salary_max: 95000,
  salary_currency: 'EUR',
  seniority: 'senior',
  required_skills: ['Python', 'RAG', 'AWS', 'Docker', 'SQL'],
};

const JOB = {
  source: 'jobicy',
  title: 'Senior ML Engineer',
  company: 'Acme',
  location: 'Berlin',
  salary: '',
};

/** A job from the scout to the applier, with the facts each agent adds. */
function fullRun() {
  const { event } = makeEvents();
  const titled = (agent: PipelineEvent['agent'], type: PipelineEvent['type'], data: object) =>
    event(agent, type, { job_id: 'a', title: 'Senior ML Engineer @ Acme', data: { ...data } });
  return {
    events: [
      titled('scout', 'item.finished', { forwarded: true, source: 'jobicy' }),
      titled('filter', 'item.started', { worker: 2 }),
      titled('filter', 'item.finished', { worker: 2, forwarded: true, job: JOB }),
      titled('extractor', 'item.started', { worker: 1 }),
      titled('extractor', 'item.finished', { worker: 1, forwarded: true, extracted: EXTRACTED }),
      titled('scorer', 'item.started', { worker: 1 }),
      titled('scorer', 'item.finished', { worker: 1, forwarded: true, score: { score: 82 } }),
      titled('researcher', 'item.started', { worker: 1 }),
      titled('researcher', 'item.finished', {
        worker: 1,
        forwarded: false,
        brief: { what_they_do: 'Builds robots.', hiring_contact: '' },
      }),
      titled('applier', 'item.started', { action: 'tailor' }),
      titled('applier', 'item.finished', {
        action: 'tailor',
        forwarded: false,
        files: ['cv.pdf', 'letter.pdf'],
        cost_usd: 0.42,
      }),
    ],
  };
}

describe('applyEvent', () => {
  it('names the thread from the event title, then from the posting', () => {
    const { events } = fullRun();

    expect(follow(events.slice(0, 1))).toMatchObject({
      id: 'a',
      title: 'Senior ML Engineer',
      company: 'Acme',
    });
    expect(splitTitle('Head of AI @ Home @ Globex')).toEqual({
      title: 'Head of AI @ Home',
      company: 'Globex',
    });
    expect(splitTitle('No company')).toEqual({ title: 'No company', company: '' });
  });

  it('follows the thread through the workers it visits', () => {
    const { events } = fullRun();
    const thread = follow(events);

    expect(thread.path).toEqual([
      'scout',
      'filter#2',
      'extractor#1',
      'scorer#1',
      'researcher#1',
      'applier',
    ]);
    expect(threadPath(thread)[0]).toBe('source:jobicy');
  });

  it('is waiting between two agents and running inside one', () => {
    const { events } = fullRun();

    expect(follow(events.slice(0, 1))).toMatchObject({ status: 'waiting', agent: 'scout' });
    expect(follow(events.slice(0, 2))).toMatchObject({
      status: 'running',
      agent: 'filter',
      worker: 2,
    });
    expect(follow(events.slice(0, 3)).status).toBe('waiting');
    // The researcher is the last automatic stage: nothing waits after it.
    expect(follow(events.slice(0, 9)).status).toBe('done');
  });

  it('appends the facts in the order the agents add them, with who added each', () => {
    const { events } = fullRun();
    const facts = follow(events).facts.map((fact) => `${fact.key}:${fact.agent}`);

    expect(facts).toEqual([
      'source:scout',
      'location:extractor',
      'contract:extractor',
      'remote:extractor',
      'salary:extractor',
      'seniority:extractor',
      'skills:extractor',
      'score:scorer',
      'fit:scorer',
      'company_brief:researcher',
      'application:applier',
    ]);
  });

  it('adds nothing for a value the agent did not find', () => {
    const { item } = makeEvents();
    const thread = follow([
      item('extractor', 'item.finished', 'a', {
        extracted: { contract_type: 'unknown', remote_policy: '', locations: [], seniority: 'mid' },
      }),
    ]);

    expect(thread.facts).toEqual([{ key: 'seniority', value: 'mid', agent: 'extractor' }]);
  });

  it('updates a fact in place when a later agent knows better', () => {
    const { events } = fullRun();
    const beforeExtractor = follow(events.slice(0, 3));
    const afterExtractor = follow(events.slice(0, 5));

    expect(beforeExtractor.facts[1]).toEqual({ key: 'location', value: 'Berlin', agent: 'filter' });
    expect(afterExtractor.facts[1]).toEqual({
      key: 'location',
      value: 'Germany, Austria',
      agent: 'extractor',
    });
  });

  it('keeps the applier result as one nested fact that later steps extend', () => {
    const { events } = fullRun();
    const { item } = makeEvents();
    const tailored = follow(events);
    const filling = applyEvent(
      tailored,
      item('applier', 'item.waiting', 'a', { action: 'fill_form', reason: 'Review the form.' }),
      'applier',
    );

    expect(tailored.facts.at(-1)?.value).toEqual({
      action: 'tailor',
      state: 'done',
      files: 2,
      cost_usd: 0.42,
    });
    expect(filling).toMatchObject({ status: 'waiting', agent: 'applier', worker: null });
    expect(filling.facts.at(-1)?.value).toMatchObject({
      action: 'fill_form',
      state: 'waiting for you',
      files: 2,
      note: 'Review the form.',
    });
  });

  it('records why a thread was dropped or failed', () => {
    const { item } = makeEvents();
    const dropped = follow([
      item('filter', 'item.started', 'a'),
      item('filter', 'item.dropped', 'a', { reason: 'no keyword' }),
    ]);
    const failed = follow([
      item('scorer', 'item.started', 'b', { worker: 3 }),
      item('scorer', 'item.failed', 'b', { worker: 3, error: 'invalid JSON' }),
    ]);

    expect(dropped).toMatchObject({ status: 'dropped' });
    expect(dropped.facts).toEqual([{ key: 'dropped', value: 'no keyword', agent: 'filter' }]);
    expect(failed).toMatchObject({ status: 'failed', agent: 'scorer', worker: 3 });
    expect(failed.facts).toEqual([{ key: 'error', value: 'invalid JSON', agent: 'scorer' }]);
  });

  it('tracks the position inside the agent graph from progress events', () => {
    const { item } = makeEvents();
    const events = [
      item('researcher', 'item.started', 'a', { worker: 1 }),
      item('researcher', 'item.progress', 'a', { worker: 1, node: 'model' }),
      item('researcher', 'item.progress', 'a', { worker: 1, node: 'tools' }),
      item('researcher', 'item.progress', 'a', { worker: 1, node: 'model' }),
      item('researcher', 'item.finished', 'a', { worker: 1, forwarded: false }),
    ];

    expect(follow(events.slice(0, 1))).toMatchObject({ graphNode: null, graphDone: [] });
    expect(follow(events.slice(0, 3))).toMatchObject({ graphNode: 'tools', graphDone: ['model'] });
    // Back in the loop: the model runs again, the tools stay done.
    expect(follow(events.slice(0, 4))).toMatchObject({
      status: 'running',
      graphNode: 'model',
      graphDone: ['model', 'tools'],
    });
    expect(follow(events)).toMatchObject({ graphNode: null, graphDone: ['model', 'tools'] });
  });

  it('marks where a thread resumed from a checkpoint', () => {
    const { item } = makeEvents();
    const thread = follow([
      item('extractor', 'item.started', 'a', { worker: 1 }),
      item('extractor', 'item.progress', 'a', { worker: 1, node: 'highlights', resumed: true }),
      item('extractor', 'item.progress', 'a', { worker: 1, node: 'tidy' }),
    ]);

    expect(thread).toMatchObject({
      resumedAt: 'highlights',
      graphNode: 'tidy',
      graphDone: ['highlights'],
    });
  });

  it('starts the graph position again in the next agent and on a retry', () => {
    const { item } = makeEvents();
    const retried = follow([
      item('extractor', 'item.started', 'a', { worker: 1 }),
      item('extractor', 'item.progress', 'a', { worker: 1, node: 'facts', resumed: true }),
      item('extractor', 'item.started', 'a', { worker: 1 }),
    ]);
    const next = follow([
      item('extractor', 'item.progress', 'a', { worker: 1, node: 'facts' }),
      item('extractor', 'item.finished', 'a', { worker: 1, forwarded: true }),
      item('scorer', 'item.progress', 'a', { worker: 1, node: 'judge' }),
    ]);

    expect(retried).toMatchObject({ graphNode: null, graphDone: [], resumedAt: null });
    expect(retried.path).toEqual(['extractor#1']);
    expect(next).toMatchObject({ agent: 'scorer', graphNode: 'judge', graphDone: [] });
  });

  it('keeps the facts of a late event without pulling the thread back', () => {
    const { item } = makeEvents();
    const thread = follow([
      item('filter', 'item.started', 'a', { worker: 1 }),
      item('extractor', 'item.started', 'a', { worker: 2 }),
      item('filter', 'item.finished', 'a', { worker: 1, forwarded: true, job: JOB }),
    ]);

    expect(thread).toMatchObject({ agent: 'extractor', worker: 2, status: 'running' });
    expect(thread.path).toEqual(['filter#1', 'extractor#2']);
    expect(thread.facts.map((fact) => fact.key)).toEqual(['source', 'location']);
  });
});

describe('rankThreads', () => {
  const scored = (id: string, score: number | null): Thread => {
    const { item } = makeEvents();
    const data = score === null ? {} : { score: { score } };
    return follow([item('scorer', 'item.finished', id, data)]);
  };
  const threads = Object.fromEntries(
    [scored('a', 70), scored('b', 91), scored('c', null), scored('d', 70), scored('e', 40)].map(
      (thread) => [thread.id, thread],
    ),
  );

  it('ranks the scored threads of the run, best first', () => {
    const ranks = rankThreads(threads);

    expect(ranks.b).toEqual({ rank: 1, of: 4 });
    expect(ranks.e).toEqual({ rank: 4, of: 4 });
    expect(ranks.c).toBeUndefined();
  });

  it('gives equal scores the same rank', () => {
    const ranks = rankThreads(threads);

    expect(ranks.a).toEqual({ rank: 2, of: 4 });
    expect(ranks.d).toEqual({ rank: 2, of: 4 });
  });
});

describe('fitLabel', () => {
  it('names the score bands', () => {
    expect([80, 79, 65, 64, 50, 49].map(fitLabel)).toEqual([
      'Strong',
      'Good',
      'Good',
      'Fair',
      'Fair',
      'Weak',
    ]);
  });
});

describe('threadJson', () => {
  it('starts with the id, title and company and grows with the facts', () => {
    const { events } = fullRun();
    const keys = (count: number) => threadJson(follow(events.slice(0, count))).map(([key]) => key);

    expect(keys(1)).toEqual(['thread_id', 'title', 'company', 'source']);
    expect(keys(3)).toEqual(['thread_id', 'title', 'company', 'source', 'location']);
    expect(keys(5).slice(5)).toEqual(['contract', 'remote', 'salary', 'seniority', 'skills']);
  });

  it('puts the rank after the fit once the thread is scored', () => {
    const { events } = fullRun();
    const entries = threadJson(follow(events.slice(0, 7)), { rank: 2, of: 7 });

    expect(entries.slice(-3)).toEqual([
      ['score', 82],
      ['fit', 'Strong'],
      ['rank', '#2 of 7'],
    ]);
  });
});

describe('threadFields', () => {
  it('lists a field only once its agent has added it', () => {
    const { events } = fullRun();
    const labels = (count: number) =>
      threadFields(follow(events.slice(0, count))).map((field) => field.label);

    expect(labels(1)).toEqual([]);
    expect(labels(3)).toEqual(['Location']);
    expect(labels(5)).toEqual(['Contract', 'Remote', 'Location', 'Salary', 'Seniority']);
  });

  it('prints the values for people and says which agent added them', () => {
    const { events } = fullRun();
    const fields = threadFields(follow(events), { rank: 2, of: 7 });

    expect(fields).toContainEqual({ label: 'Contract', value: 'Freelance', agent: 'extractor' });
    expect(fields).toContainEqual({ label: 'Salary', value: 'EUR 70k–95k', agent: 'extractor' });
    expect(fields).toContainEqual({
      label: 'Fit',
      value: '82 · Strong · #2 of 7',
      agent: 'scorer',
    });
    expect(fields).toContainEqual({
      label: 'Application',
      value: 'Tailor: done',
      agent: 'applier',
    });
  });
});

describe('describeThread', () => {
  const label = (agent: string) => agent.toUpperCase();

  it('says where the thread is', () => {
    const { events } = fullRun();

    expect(describeThread(follow(events.slice(0, 2)), label)).toBe('Running in FILTER, worker 2');
    expect(describeThread(follow(events.slice(0, 3)), label)).toBe('Waiting for EXTRACTOR');
    expect(describeThread(follow(events.slice(0, 9)), label)).toBe(
      'Done after RESEARCHER, worker 1',
    );
    expect(describeThread(follow(events), label)).toBe('Done after APPLIER');
  });
});
