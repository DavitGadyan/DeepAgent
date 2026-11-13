/** Builders for the unit tests: events (one per second starting at T0) and pipelines. */
import type {
  AgentId,
  EventType,
  GraphShape,
  Pipeline,
  PipelineEvent,
  PipelineNode,
} from '@/lib/types';

export const T0 = Date.parse('2026-01-05T09:00:00Z');

export function makeEvents() {
  let seq = 0;

  const event = (
    agent: AgentId,
    type: EventType,
    fields: Partial<PipelineEvent> = {},
  ): PipelineEvent => {
    const ts = new Date(T0 + seq * 1000).toISOString();
    seq += 1;
    return {
      id: `e${seq}`,
      ts,
      run_id: 'run-1',
      agent,
      type,
      job_id: '',
      title: '',
      duration_ms: null,
      data: {},
      ...fields,
    };
  };

  const item = (
    agent: AgentId,
    type: EventType,
    job: string,
    data: Record<string, unknown> = {},
    durationMs: number | null = null,
  ) => event(agent, type, { job_id: job, title: `Job ${job}`, data, duration_ms: durationMs });

  const source = (type: EventType, name: string, data: Record<string, unknown> = {}) =>
    event('scout', type, { data: { source: name, ...data } });

  return { event, item, source };
}

/** A pipeline node with the defaults of an agent that has one worker and no graph. */
export const makeNode = (
  id: string,
  kind: PipelineNode['kind'],
  fields: Partial<PipelineNode> = {},
): PipelineNode => ({
  id,
  label: id,
  kind,
  description: '',
  model: '',
  enabled: true,
  workers: 1,
  graph: null,
  steps: [],
  ...fields,
});

/** The extractor's graph: a chain of three nodes. */
export const CHAIN: GraphShape = {
  nodes: ['__start__', 'facts', 'highlights', 'tidy', '__end__'].map((id) => ({ id, label: id })),
  edges: [
    { source: '__start__', target: 'facts', conditional: false },
    { source: 'facts', target: 'highlights', conditional: false },
    { source: 'highlights', target: 'tidy', conditional: false },
    { source: 'tidy', target: '__end__', conditional: false },
  ],
};

/** The researcher's graph: the model calls tools in a loop until it is done. */
export const LOOP: GraphShape = {
  nodes: ['__start__', 'model', 'tools', '__end__'].map((id) => ({ id, label: id })),
  edges: [
    { source: '__start__', target: 'model', conditional: false },
    { source: 'model', target: 'tools', conditional: true },
    { source: 'tools', target: 'model', conditional: false },
    { source: 'model', target: '__end__', conditional: true },
  ],
};

/**
 * The real pipeline in small: two sources, the scout, the four stages and the
 * applier. `workers` gives a stage more than one worker.
 */
export function makePipeline(workers: Record<string, number> = {}): Pipeline {
  const stage = (id: string, kind: PipelineNode['kind'], fields: Partial<PipelineNode> = {}) =>
    makeNode(id, kind, { workers: workers[id] ?? 1, ...fields });
  const agents = [
    makeNode('scout', 'tool', { steps: ['Fetch', 'Rank', 'Forward'] }),
    stage('filter', 'tool', { steps: ['Keywords', 'Embedding', 'Text'] }),
    stage('extractor', 'llm', { graph: CHAIN }),
    stage('scorer', 'llm'),
    stage('researcher', 'deep', { graph: LOOP }),
    makeNode('applier', 'human', { steps: ['Tailor', 'Fill', 'Stop'] }),
  ];
  return {
    nodes: [
      makeNode('source:a', 'source', { parent: 'scout' }),
      makeNode('source:b', 'source', { parent: 'scout' }),
      ...agents,
    ],
    edges: agents.slice(1).map((agent, index) => ({
      source: agents[index]?.id ?? '',
      target: agent.id,
    })),
  };
}
