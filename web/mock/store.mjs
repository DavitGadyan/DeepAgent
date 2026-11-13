/** In-memory state of the mock orchestrator: runs, their events, leads, settings. */
import { randomUUID } from 'node:crypto';
import {
  FILLED_FIELDS,
  advanceLead,
  buildApplication,
  existingLeads,
  runJobs,
  settings,
} from './fixtures.mjs';
import { buildTimeline } from './timeline.mjs';

/** MOCK_SPEED=4 plays the scripted run and the applier four times faster. */
const SPEED = Number(process.env.MOCK_SPEED ?? 1);
const APPLIER_MS = 6000 / SPEED;

export const state = {
  settings: structuredClone(settings),
  /** Newest first. */
  runs: [],
  /** run id -> events, oldest first */
  events: new Map(),
  /** Events outside any run (run_id ''), oldest first: the applier's. */
  applierEvents: [],
  /** job id -> Lead */
  leads: new Map(existingLeads.map(({ lead }) => [lead.job_id, lead])),
};

const seeds = new Map([...existingLeads, ...runJobs].map(({ lead, seed }) => [lead.job_id, seed]));
const blankLeads = new Map(runJobs.map(({ lead }) => [lead.job_id, lead]));
const listeners = new Set();

/** Calls `listener(event)` for every event from now on; returns the unsubscribe function. */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function runStats(events) {
  const count = (test) => events.filter(test).length;
  const finished = (agent) => (e) => e.agent === agent && e.type === 'item.finished';
  const stats = {
    discovered: count(finished('scout')),
    dropped: count((e) => e.type === 'item.dropped'),
    failed: count((e) => e.type === 'item.failed'),
    scored: count(finished('scorer')),
    researched: count(finished('researcher')),
  };
  const stoppedAtScorer = count((e) => finished('scorer')(e) && e.data.forwarded === false);
  const settled = stats.dropped + stats.failed + stats.researched + stoppedAtScorer;
  return { ...stats, in_flight: stats.discovered - settled };
}

/** A scored or researched posting becomes (or updates) a lead, unless the user already acted on it. */
function updateLead(event) {
  const stage = { scorer: 'scored', researcher: 'researched' }[event.agent];
  if (!stage || event.type !== 'item.finished') return;
  const current = state.leads.get(event.job_id) ?? blankLeads.get(event.job_id);
  // A lead whose step failed keeps the failure: the mock never retries it.
  if (!current || current.pipeline_error || !['new', 'scored'].includes(current.status)) return;
  const lead = advanceLead(
    current,
    seeds.get(event.job_id),
    stage,
    state.settings.research_min_score,
  );
  state.leads.set(lead.job_id, { ...lead, updated_at: event.ts });
}

/** Stores an event, applies its effects and pushes it to the SSE subscribers. */
function record(runId, fields, at = Date.now()) {
  const event = {
    id: randomUUID().replaceAll('-', ''),
    ts: new Date(at).toISOString(),
    run_id: runId,
    ...fields,
  };
  const run = state.runs.find((candidate) => candidate.id === runId);
  if (runId === '') state.applierEvents.push(event);
  if (run) {
    const events = state.events.get(runId);
    events.push(event);
    run.stats = runStats(events);
    if (event.type === 'run.finished')
      Object.assign(run, { status: 'finished', finished_at: event.ts });
  }
  updateLead(event);
  for (const listener of listeners) listener(event);
  return event;
}

function createRun(options, startedAt) {
  const run = {
    id: randomUUID().replaceAll('-', '').slice(0, 12),
    status: 'running',
    started_at: new Date(startedAt).toISOString(),
    finished_at: null,
    options: {
      sources: [],
      limit_per_source: state.settings.limit_per_source,
      force: false,
      ...options,
      workers: state.settings.workers,
    },
    stats: runStats([]),
  };
  state.runs.unshift(run);
  state.events.set(run.id, []);
  return run;
}

const enabledSources = () =>
  Object.entries(state.settings.sources).flatMap(([name, enabled]) => (enabled ? [name] : []));

/** POST /api/runs: plays the scripted run in real time. */
export function startRun(options) {
  // The worker count belongs to the agents, not to one run: it stays until changed.
  if (options.workers) state.settings.workers = options.workers;
  const run = createRun(options, Date.now());
  const sources = run.options.sources.length ? run.options.sources : enabledSources();
  const perSource = new Map();
  const jobs = runJobs.filter(({ lead }) => {
    perSource.set(lead.source, (perSource.get(lead.source) ?? 0) + 1);
    return perSource.get(lead.source) <= run.options.limit_per_source;
  });
  const { research_min_score: minScore, workers } = state.settings;
  for (const { at, event } of buildTimeline(jobs, sources, minScore, workers)) {
    setTimeout(() => record(run.id, event), at / SPEED);
  }
  return run;
}

/** A run that already happened: the whole script, stamped with past times. */
function seedPastRun(jobs, hoursAgo, options = {}) {
  const startedAt = Date.now() - hoursAgo * 3600_000;
  const run = createRun(options, startedAt);
  const { research_min_score: minScore, workers } = state.settings;
  for (const { at, event } of buildTimeline(jobs, enabledSources(), minScore, workers)) {
    record(run.id, event, startedAt + at);
  }
}

/** Runs stored before POST /api/runs saved the effective limit have 0 ("Setup default"). */
seedPastRun(existingLeads.slice(10, 22), 50, { limit_per_source: 0 });
seedPastRun([...existingLeads.slice(0, 10), ...runJobs.filter(({ seed }) => seed.fate)], 20);

function saveLead(lead, changes) {
  const next = { ...lead, ...changes, updated_at: new Date().toISOString() };
  state.leads.set(next.job_id, next);
  return next;
}

const applierEvent = (lead, type, data, durationMs = null, at = Date.now()) =>
  record(
    '',
    {
      agent: 'applier',
      type,
      job_id: lead.job_id,
      title: `${lead.title} @ ${lead.company}`,
      duration_ms: durationMs,
      data,
    },
    at,
  );

/** What the applier already did for the existing leads, as events per lead status. */
function applierHistory(lead) {
  const dir = lead.application?.dir ?? '';
  const tailored = [
    ['item.started', { action: 'tailor' }],
    ['item.finished', { action: 'tailor', forwarded: false, application_dir: dir }],
  ];
  const filled = [
    ...tailored,
    ['item.started', { action: 'fill_form' }],
    ['item.waiting', { action: 'fill_form', reason: 'Form filled. Review it and press Submit.' }],
  ];
  const error = lead.application?.error;
  return (
    {
      tailoring: [['item.started', { action: 'tailor' }]],
      cv_ready: error
        ? [
            ...tailored,
            ['item.started', { action: 'fill_form' }],
            ['item.failed', { action: 'fill_form', error }],
          ]
        : tailored,
      form_filled: filled,
      applied: [...filled, ['item.finished', { action: 'fill_form', forwarded: false }]],
      failed: [
        ['item.started', { action: 'tailor' }],
        ['item.failed', { action: 'tailor', error }],
      ],
    }[lead.status] ?? []
  );
}

/** Applier work on the existing leads, spread over the hours after the latest seeded run. */
function seedApplierHistory(hoursAgo) {
  let at = Date.now() - hoursAgo * 3600_000;
  for (const lead of state.leads.values()) {
    for (const [type, data] of applierHistory(lead)) {
      at += 4 * 60_000;
      applierEvent(lead, type, data, type === 'item.started' ? null : 90_000, at);
    }
  }
}

seedApplierHistory(18);

/** POST .../tailor: the CV is "ready" a few seconds later. */
export function tailor(lead) {
  applierEvent(lead, 'item.started', { action: 'tailor' });
  setTimeout(() => {
    const application = buildApplication(lead);
    saveLead(state.leads.get(lead.job_id), { status: 'cv_ready', application });
    applierEvent(
      lead,
      'item.finished',
      { forwarded: false, action: 'tailor', application_dir: application.dir },
      APPLIER_MS,
    );
  }, APPLIER_MS);
  return saveLead(lead, { status: 'tailoring' });
}

/** Aggregator postings link to a listing, not a form: filling fails like it does live. */
const NO_FORM_SOURCES = new Set(['jobicy']);

/**
 * POST .../apply: a few seconds later the form is "filled" and waits for the
 * human, or the fill fails and the lead returns to cv_ready with the reason.
 */
export function fillForm(lead) {
  applierEvent(lead, 'item.started', { action: 'fill_form' });
  setTimeout(() => {
    const current = state.leads.get(lead.job_id);
    if (NO_FORM_SOURCES.has(lead.source)) {
      const error = 'The agent found no application form on the page.';
      saveLead(current, { status: 'cv_ready', application: { ...current.application, error } });
      applierEvent(lead, 'item.failed', { action: 'fill_form', error }, APPLIER_MS);
      return;
    }
    const unanswered = ['What is your notice period?', 'Why do you want to work here?'];
    const application = {
      ...current.application,
      unanswered,
      error: '',
      filled_fields: FILLED_FIELDS,
      cost_usd: (current.application.cost_usd ?? 0) + 0.46,
    };
    saveLead(current, { status: 'form_filled', application });
    applierEvent(lead, 'item.waiting', {
      action: 'fill_form',
      reason: 'Form filled. Review it and press Submit yourself.',
    });
  }, APPLIER_MS);
  return saveLead(lead, { status: 'filling' });
}

/** 'new' puts the lead back where the pipeline left it; tailored files mean cv_ready. */
function restoredStatus(lead) {
  if (lead.application?.files.length) return 'cv_ready';
  if (lead.brief) return 'researched';
  return lead.score === null ? 'new' : 'scored';
}

/** PATCH: allowed from any status. Marking a filled form as applied also releases the applier node. */
export function setStatus(lead, status) {
  if (lead.status === 'form_filled' && status === 'applied') {
    applierEvent(lead, 'item.finished', {
      forwarded: false,
      action: 'fill_form',
      application_dir: lead.application.dir,
    });
  }
  return saveLead(lead, { status: status === 'new' ? restoredStatus(lead) : status });
}

/** GET /api/events: run-less events at or after `since`, oldest first. */
export function eventsOutsideRuns({ agent, since, limit }) {
  const from = since ? Date.parse(since) : -Infinity;
  return state.applierEvents
    .filter((event) => event.agent === agent && Date.parse(event.ts) >= from)
    .slice(0, limit);
}
