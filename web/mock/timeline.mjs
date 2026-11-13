/**
 * The script of a mock run, as a pure function: which event happens how many
 * milliseconds after the run starts. The server replays it in real time for a
 * new run and stamps it with past times for the runs that already "happened".
 */

const FAILING_SOURCE = 'arbeitnow';

/** Deterministic stand-in for random durations: the same inputs give the same run. */
const jitter = (seed, min, max) => min + ((seed * 2654435761) % 1000) * ((max - min) / 1000);

const itemFields = (job, data = {}, durationMs = null) => ({
  job_id: job.lead.job_id,
  title: `${job.lead.title} @ ${job.lead.company}`,
  duration_ms: durationMs === null ? null : Math.round(durationMs),
  data,
});

/** What each stage does with a job: how long it takes and how it ends. */
const STAGES = {
  filter: (job, index) => {
    const [kind, reason] = job.seed.fate.split(':');
    const took = jitter(index, 20, 90);
    return kind === 'drop'
      ? { took, type: 'item.dropped', data: { reason }, forward: false }
      : {
          took,
          type: 'item.finished',
          data: { forwarded: true, job: job.lead.job },
          forward: true,
        };
  },
  extractor: (job, index) => {
    const took = jitter(index + 3, 1100, 2600);
    return job.seed.fate === 'fail'
      ? {
          took,
          type: 'item.failed',
          data: { error: 'Model returned invalid JSON after 3 attempts.' },
          forward: false,
        }
      : {
          took,
          type: 'item.finished',
          data: { forwarded: true, extracted: job.seed.extracted },
          forward: true,
        };
  },
  scorer: (job, index, minScore) => {
    const forward = job.seed.scoreDetail.score >= minScore;
    return {
      took: jitter(index + 5, 1400, 3000),
      type: 'item.finished',
      data: { forwarded: forward, score: job.seed.scoreDetail },
      forward,
    };
  },
  researcher: (job, index) => ({
    took: jitter(index + 7, 3500, 6500),
    type: 'item.finished',
    data: { forwarded: false, brief: job.seed.brief },
    forward: false,
  }),
};

/**
 * The LangGraph nodes a job passes inside each graph agent, in order. The
 * researcher goes round its model and tools loop twice.
 */
const GRAPH_STEPS = {
  extractor: ['facts', 'highlights', 'tidy'],
  scorer: ['judge', 'rubric'],
  researcher: ['model', 'tools', 'model', 'tools', 'model'],
};

/** Every seventh job at the extractor "was cut off" earlier and continues from its checkpoint. */
const resumesAt = (agent, index) => (agent === 'extractor' && index % 7 === 3 ? 1 : 0);

/**
 * `item.progress` events for one job inside a graph agent, spread evenly over
 * the time the job takes. A resumed job skips the nodes it finished before.
 */
function progressEvents(agent, index, job, worker, startedAt, took) {
  const steps = GRAPH_STEPS[agent] ?? [];
  const first = resumesAt(agent, index);
  return steps.slice(first).map((node, position, rest) => ({
    at: startedAt + (took * position) / rest.length + 30,
    fields: itemFields(job, {
      node,
      worker,
      ...(first > 0 && position === 0 ? { resumed: true } : {}),
    }),
  }));
}

/**
 * @param jobs     postings the run discovers (from fixtures.mjs)
 * @param sources  names of the enabled sources
 * @param minScore research threshold: lower scores stop after the scorer
 * @param workers  parallel workers of every pipeline agent
 * @returns `{ at, event }[]` sorted by `at`; events lack id, ts and run_id
 */
export function buildTimeline(jobs, sources, minScore, workers = 1) {
  const entries = [];
  const emit = (at, agent, type, fields = {}) =>
    entries.push({
      at: Math.round(at),
      event: { agent, type, job_id: '', title: '', duration_ms: null, data: {}, ...fields },
    });

  emit(0, 'orchestrator', 'run.started');

  // Scout: every source is fetched in parallel and hands over its new postings.
  let arrivals = [];
  let scoutDone = 0;
  sources.forEach((source, index) => {
    const startedAt = 150 + index * 130;
    const took = jitter(index + 1, 700, 2300);
    const endedAt = startedAt + took;
    const found = jobs.filter((job) => job.lead.source === source);
    emit(startedAt, 'scout', 'source.started', { data: { source } });
    scoutDone = Math.max(scoutDone, endedAt + found.length * 60);

    if (source === FAILING_SOURCE) {
      emit(endedAt, 'scout', 'source.failed', {
        duration_ms: Math.round(took),
        data: { source, error: 'HTTP 429 Too Many Requests' },
      });
      return;
    }
    emit(endedAt, 'scout', 'source.finished', {
      duration_ms: Math.round(took),
      data: { source, count: found.length + 6 + index * 4, new: found.length },
    });
    found.forEach((job, position) => {
      const at = endedAt + (position + 1) * 60;
      emit(at, 'scout', 'item.finished', itemFields(job, { forwarded: true, source }));
      arrivals.push({ job, at });
    });
  });
  emit(scoutDone + 80, 'scout', 'scout.done');

  // Every later stage is a pool: a job goes to the worker that is free first.
  for (const [agent, work] of Object.entries(STAGES)) {
    const forwarded = [];
    const freeAt = Array.from({ length: workers }, () => 0);
    arrivals
      .sort((a, b) => a.at - b.at)
      .forEach(({ job, at }, index) => {
        const slot = freeAt.indexOf(Math.min(...freeAt));
        const worker = slot + 1;
        const startedAt = Math.max(at, freeAt[slot]) + 40;
        const outcome = work(job, index, minScore);
        const endedAt = startedAt + outcome.took;
        freeAt[slot] = endedAt;
        emit(startedAt, agent, 'item.started', itemFields(job, { worker }));
        for (const step of progressEvents(agent, index, job, worker, startedAt, outcome.took)) {
          emit(step.at, agent, 'item.progress', step.fields);
        }
        emit(
          endedAt,
          agent,
          outcome.type,
          itemFields(job, { ...outcome.data, worker }, outcome.took),
        );
        if (outcome.forward) forwarded.push({ job, at: endedAt });
      });
    arrivals = forwarded;
  }

  entries.sort((a, b) => a.at - b.at);
  const lastAt = entries.at(-1).at;
  emit(lastAt + 250, 'orchestrator', 'run.finished');
  return entries;
}
