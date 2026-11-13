/**
 * A thread is one job on its way through the pipeline: where it is, which
 * worker nodes it passed, where it is inside the current agent's LangGraph
 * graph, and the facts every agent added, in the order they arrived.
 *
 * Everything here is pure and reads only the events, so the reducer can replay
 * a thread to any moment of a run. The thread id is the job id.
 */
import { formatSalary, humanize } from '@/lib/format';
import type { PipelineEvent } from '@/lib/types';
import { eventScore } from './eventData';
import { eventWorker, flowIndex, isStage, nextStage, parseNodeId } from './stages';

/** `waiting`: between two agents, or on the human at the applier. */
export type ThreadStatus = 'running' | 'waiting' | 'done' | 'dropped' | 'failed';

export type FactValue = string | number | Record<string, string | number>;

/** One thing an agent learned about the job. */
export interface Fact {
  key: string;
  value: FactValue;
  /** The agent that added it, or changed it last. */
  agent: string;
}

export interface Thread {
  /** The job id. */
  id: string;
  title: string;
  company: string;
  status: ThreadStatus;
  /** The agent that has the thread, or had it last. */
  agent: string;
  /** Which of that agent's workers; null for the scout and the applier. */
  worker: number | null;
  /** Ids of the graph nodes it visited, oldest first: 'scout', 'filter#2', ... */
  path: string[];
  /** The LangGraph node it is in inside `agent`; null outside a graph. */
  graphNode: string | null;
  /** The LangGraph nodes it already left inside `agent`. */
  graphDone: string[];
  /** The LangGraph node it continued at after a restart; null when it ran from the start. */
  resumedAt: string | null;
  /** In the order the agents added them. */
  facts: Fact[];
}

/** Place of a thread among the scored threads of the run: 1 is the best fit. */
export interface Rank {
  rank: number;
  of: number;
}

/** How many of the required skills the JSON card lists. */
const MAX_SKILLS = 4;

type Loose = Record<string, unknown>;
type Entry = [key: string, value: FactValue];

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
/** Like `text`, but the models' "unknown" counts as nothing. */
const known = (value: unknown): string => (text(value) === 'unknown' ? '' : text(value));
const amount = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const record = (value: unknown): Loose =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];

export const shortId = (id: string) => id.slice(0, 8);

export function fitLabel(score: number): string {
  if (score >= 80) return 'Strong';
  if (score >= 65) return 'Good';
  if (score >= 50) return 'Fair';
  return 'Weak';
}

export const formatRank = ({ rank, of }: Rank) => `#${rank} of ${of}`;

/** Events are titled "<job title> @ <company>". */
export function splitTitle(label: string): { title: string; company: string } {
  const at = label.lastIndexOf(' @ ');
  if (at === -1) return { title: label, company: '' };
  return { title: label.slice(0, at), company: label.slice(at + 3) };
}

/** What a finished stage adds, per agent. Empty values are left out later. */
const STAGE_FACTS: Record<string, (data: Loose, event: PipelineEvent) => Entry[]> = {
  scout: (data) => [['source', text(data.source)]],
  filter: (data) => {
    const job = record(data.job);
    return [
      ['source', text(job.source)],
      ['location', text(job.location)],
      ['salary', text(job.salary)],
    ];
  },
  extractor: (data) => {
    const found = record(data.extracted);
    const salary = formatSalary(
      amount(found.salary_min),
      amount(found.salary_max),
      text(found.salary_currency),
    );
    return [
      ['contract', known(found.contract_type)],
      ['remote', known(found.remote_policy)],
      ['location', strings(found.locations).join(', ')],
      ['salary', salary],
      ['seniority', known(found.seniority)],
      ['skills', strings(found.required_skills).slice(0, MAX_SKILLS).join(', ')],
    ];
  },
  scorer: (_, event) => {
    const score = eventScore(event);
    return score === null
      ? []
      : [
          ['score', score],
          ['fit', fitLabel(score)],
        ];
  },
  researcher: (data) => {
    const brief = record(data.brief);
    return [
      ['company_brief', text(brief.what_they_do)],
      ['contact', text(brief.hiring_contact)],
    ];
  },
};

const APPLIER_STATE: Partial<Record<PipelineEvent['type'], string>> = {
  'item.started': 'running',
  'item.waiting': 'waiting for you',
  'item.finished': 'done',
  'item.failed': 'failed',
};

/** The applier's work on the thread as one nested fact; counts instead of lists keep it small. */
function applicationFact(thread: Thread, event: PipelineEvent): Entry[] {
  const { data } = event;
  const before = factValue(thread, 'application');
  // A note explains one outcome, so it does not carry over to the next one.
  const kept =
    typeof before === 'object' ? Object.entries(before).filter(([key]) => key !== 'note') : [];
  const next: Record<string, string | number> = {
    ...Object.fromEntries(kept),
    action: text(data.action) || 'apply',
    state: APPLIER_STATE[event.type] ?? 'running',
  };
  const counts: [string, number][] = [
    ['files', strings(data.files).length],
    ['filled_fields', strings(data.filled_fields).length],
    ['unanswered', strings(data.unanswered).length],
  ];
  for (const [key, count] of counts) if (count > 0) next[key] = count;
  const cost = amount(data.cost_usd);
  if (cost !== null) next.cost_usd = cost;
  const note = text(data.reason) || text(data.error);
  if (note) next.note = note;
  return [['application', next]];
}

/** The facts `event` adds to `thread`; empty when it only reports progress. */
function factsOf(thread: Thread, event: PipelineEvent): Entry[] {
  if (event.type === 'item.progress') return [];
  if (event.agent === 'applier') return applicationFact(thread, event);
  if (event.type === 'item.dropped') return [['dropped', text(event.data.reason)]];
  if (event.type === 'item.failed') return [['error', text(event.data.error)]];
  if (event.type !== 'item.finished') return [];
  return STAGE_FACTS[event.agent]?.(event.data, event) ?? [];
}

/**
 * Appends new keys and updates known ones in place, so the order tells who
 * came first. An agent that repeats what is known does not take the credit.
 */
function mergeFacts(facts: Fact[], entries: Entry[], agent: string): Fact[] {
  const merged = [...facts];
  for (const [key, value] of entries) {
    if (value === '') continue;
    const at = merged.findIndex((fact) => fact.key === key);
    if (at === -1) merged.push({ key, value, agent });
    else if (merged[at]?.value !== value) merged[at] = { key, value, agent };
  }
  return merged;
}

function newThread(event: PipelineEvent): Thread {
  return {
    id: event.job_id,
    ...splitTitle(event.title),
    status: 'running',
    agent: event.agent,
    worker: null,
    path: [],
    graphNode: null,
    graphDone: [],
    resumedAt: null,
    facts: [],
  };
}

/** The posting itself has the full title and company; event titles are cut at 120 characters. */
function jobNames(thread: Thread, event: PipelineEvent): Pick<Thread, 'title' | 'company'> {
  const job = record(event.data.job);
  return {
    title: text(job.title) || thread.title,
    company: text(job.company) || thread.company,
  };
}

const GRAPH_START = { graphNode: null, graphDone: [], resumedAt: null };

type GraphPosition = Pick<Thread, 'graphNode' | 'graphDone' | 'resumedAt'>;

/** The thread leaves the LangGraph node it was in; that node counts as finished. */
function leaveGraphNode({ graphNode, graphDone }: Thread): string[] {
  return graphNode === null || graphDone.includes(graphNode)
    ? graphDone
    : [...graphDone, graphNode];
}

function enterGraphNode(thread: Thread, event: PipelineEvent): GraphPosition {
  const node = text(event.data.node);
  return {
    graphNode: node,
    graphDone: thread.graphNode === node ? thread.graphDone : leaveGraphNode(thread),
    resumedAt: event.data.resumed === true ? node : thread.resumedAt,
  };
}

/** What the event changes about the thread's status and its place inside the agent's graph. */
function outcome(thread: Thread, event: PipelineEvent): Partial<Thread> {
  switch (event.type) {
    case 'item.started':
      return { status: 'running', ...GRAPH_START };
    case 'item.progress':
      return { status: 'running', ...enterGraphNode(thread, event) };
    case 'item.waiting':
      return { status: 'waiting' };
    case 'item.failed':
      // The graph position stays: it shows the node the thread failed in.
      return { status: 'failed' };
    case 'item.dropped':
      return { status: 'dropped', graphNode: null, graphDone: leaveGraphNode(thread) };
    default: {
      const handedOn = event.data.forwarded !== false && nextStage(event.agent) !== null;
      return {
        status: handedOn ? 'waiting' : 'done',
        graphNode: null,
        graphDone: leaveGraphNode(thread),
      };
    }
  }
}

/**
 * True when the thread already left `nodeId`. Agents emit on their own, so the
 * "finished" of one stage can arrive after the "started" of the next.
 */
export const hasMovedOn = (thread: Thread | undefined, nodeId: string): boolean =>
  thread !== undefined && thread.path.at(-1) !== nodeId && thread.path.includes(nodeId);

/**
 * True when the event comes from an agent the thread has already passed without
 * this event being seen. Agents emit on their own: the scout's "forwarded" can
 * arrive after the filter already took the job.
 */
const isBehind = (thread: Thread | undefined, event: PipelineEvent): boolean =>
  thread !== undefined &&
  flowIndex(event.agent) !== -1 &&
  flowIndex(event.agent) < flowIndex(thread.agent);

/** Whether the event tells of a place the thread has already left: it must not move it back. */
export const isLate = (thread: Thread | undefined, event: PipelineEvent, nodeId: string): boolean =>
  hasMovedOn(thread, nodeId) || isBehind(thread, event);

/** `path` with `nodeId` put where the pipeline order has it, before the later agents' nodes. */
function insertInOrder(path: string[], nodeId: string): string[] {
  if (path.includes(nodeId)) return path;
  const index = flowIndex(parseNodeId(nodeId).agent);
  const at = path.findIndex((id) => flowIndex(parseNodeId(id).agent) > index);
  return at === -1 ? [...path, nodeId] : [...path.slice(0, at), nodeId, ...path.slice(at)];
}

/**
 * The thread after one `item.*` event of its job at graph node `nodeId`.
 * A late event still adds its facts and its place in the path, but does not
 * pull the thread back.
 */
export function applyEvent(
  thread: Thread | undefined,
  event: PipelineEvent,
  nodeId: string,
): Thread {
  const base = thread ?? newThread(event);
  const learned: Thread = {
    ...base,
    ...jobNames(base, event),
    facts: mergeFacts(base.facts, factsOf(base, event), event.agent),
  };
  if (hasMovedOn(base, nodeId)) return learned;
  if (isBehind(thread, event)) return { ...learned, path: insertInOrder(base.path, nodeId) };

  const entered = base.path.at(-1) !== nodeId;
  const here = entered ? { ...learned, ...GRAPH_START, path: [...base.path, nodeId] } : learned;
  return {
    ...here,
    agent: event.agent,
    worker: isStage(event.agent) ? eventWorker(event) : null,
    ...outcome(here, event),
  };
}

function factValue(thread: Thread, key: string): FactValue | undefined {
  return thread.facts.find((fact) => fact.key === key)?.value;
}

export function threadScore(thread: Thread): number | null {
  const score = factValue(thread, 'score');
  return typeof score === 'number' ? score : null;
}

/**
 * The nodes to highlight for a thread: the source it came from (the scout's
 * event names it) and then the nodes it visited.
 */
export function threadPath(thread: Thread): string[] {
  const source = factValue(thread, 'source');
  return typeof source === 'string' ? [`source:${source}`, ...thread.path] : thread.path;
}

/** Rank of every scored thread, best score first; equal scores share a rank. */
export function rankThreads(threads: Record<string, Thread>): Record<string, Rank> {
  const scored = Object.values(threads)
    .flatMap((thread) => {
      const score = threadScore(thread);
      return score === null ? [] : [{ id: thread.id, score }];
    })
    .sort((a, b) => b.score - a.score);

  const ranks: Record<string, Rank> = {};
  let rank = 0;
  let previous: number | null = null;
  scored.forEach(({ id, score }, index) => {
    if (score !== previous) rank = index + 1;
    previous = score;
    ranks[id] = { rank, of: scored.length };
  });
  return ranks;
}

/**
 * The thread as the JSON card prints it: id, title and company first, then one
 * key per fact in the order the agents added them. The rank follows the fit
 * because it is not a fact of the thread: it moves as other threads are scored.
 */
export function threadJson(thread: Thread, rank?: Rank): Entry[] {
  const entries: Entry[] = [
    ['thread_id', thread.id],
    ['title', thread.title],
  ];
  if (thread.company) entries.push(['company', thread.company]);
  for (const fact of thread.facts) {
    entries.push([fact.key, fact.value]);
    if (fact.key === 'fit' && rank) entries.push(['rank', formatRank(rank)]);
  }
  return entries;
}

/** Where the thread is, in words. `labelOf` turns an agent id into its name on the graph. */
export function describeThread(thread: Thread, labelOf: (agent: string) => string): string {
  const agent = labelOf(thread.agent);
  const who = thread.worker === null ? agent : `${agent}, worker ${thread.worker}`;
  switch (thread.status) {
    case 'running':
      return `Running in ${who}`;
    case 'waiting': {
      const next = nextStage(thread.agent);
      return next ? `Waiting for ${labelOf(next)}` : `Waiting for you at ${agent}`;
    }
    case 'dropped':
      return `Dropped by ${who}`;
    case 'failed':
      return `Failed in ${who}`;
    default:
      return `Done after ${who}`;
  }
}

/** One row of the hover card: what is known, and which agent added it. */
export interface ThreadField {
  label: string;
  value: string;
  agent: string;
}

const plain = (value: string) => value;

/** [fact key, label, how to print it], in the order the hover card lists them. */
const CARD_FIELDS: [key: string, label: string, print: (value: string) => string][] = [
  ['contract', 'Contract', humanize],
  ['remote', 'Remote', humanize],
  ['location', 'Location', plain],
  ['salary', 'Salary', plain],
  ['seniority', 'Seniority', humanize],
];

function fitField(thread: Thread, rank?: Rank): ThreadField[] {
  const fact = thread.facts.find((candidate) => candidate.key === 'score');
  if (!fact || typeof fact.value !== 'number') return [];
  const parts = [String(fact.value), fitLabel(fact.value), ...(rank ? [formatRank(rank)] : [])];
  return [{ label: 'Fit', value: parts.join(' · '), agent: fact.agent }];
}

function endField(thread: Thread): ThreadField[] {
  const labels: Record<string, string> = { dropped: 'Dropped', error: 'Failed' };
  return thread.facts.flatMap((fact) => {
    const label = labels[fact.key];
    return label && typeof fact.value === 'string'
      ? [{ label, value: fact.value, agent: fact.agent }]
      : [];
  });
}

function applicationField(thread: Thread): ThreadField[] {
  const fact = thread.facts.find((candidate) => candidate.key === 'application');
  if (!fact || typeof fact.value !== 'object') return [];
  const { action, state } = fact.value;
  return [
    { label: 'Application', value: `${humanize(String(action))}: ${state}`, agent: fact.agent },
  ];
}

/** The rows of the hover card. A field is listed only once an agent has added it. */
export function threadFields(thread: Thread, rank?: Rank): ThreadField[] {
  const known = CARD_FIELDS.flatMap(([key, label, print]) => {
    const fact = thread.facts.find((candidate) => candidate.key === key);
    return fact && typeof fact.value === 'string'
      ? [{ label, value: print(fact.value), agent: fact.agent }]
      : [];
  });
  return [...known, ...fitField(thread, rank), ...applicationField(thread), ...endField(thread)];
}
