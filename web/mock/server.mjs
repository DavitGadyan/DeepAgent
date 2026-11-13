/**
 * Dev-only stand-in for the orchestrator: every endpoint of docs/api.md backed
 * by fixtures, and a scripted run streamed over SSE on POST /api/runs.
 *
 *   pnpm mock                        # http://localhost:8000
 *   MOCK_PORT=8010 MOCK_SPEED=3 pnpm mock
 */
import { createServer } from 'node:http';
import { applicationFile } from './files.mjs';
import { pipeline } from './fixtures.mjs';
import { POOLED } from './seeds.mjs';
import {
  eventsOutsideRuns,
  fillForm,
  setStatus,
  startRun,
  state,
  subscribe,
  tailor,
} from './store.mjs';

const PORT = Number(process.env.MOCK_PORT ?? 8000);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

function leadOr404(jobId) {
  const lead = state.leads.get(jobId);
  if (!lead) throw new HttpError(404, `No lead ${jobId}`);
  return lead;
}

/** LeadSummary is Lead without the detail fields. */
const DETAIL_FIELDS = new Set(['job', 'extracted', 'score_detail', 'brief', 'application']);
const toSummary = (lead) =>
  Object.fromEntries(Object.entries(lead).filter(([field]) => !DETAIL_FIELDS.has(field)));

function listLeads(query) {
  const minScore = Number(query.get('min_score') ?? 0);
  const search = (query.get('q') ?? '').toLowerCase();
  const limit = Number(query.get('limit') ?? 50);
  const offset = Number(query.get('offset') ?? 0);

  const matches = [...state.leads.values()]
    .filter((lead) => (lead.score ?? 0) >= minScore)
    .filter((lead) => !query.get('status') || lead.status === query.get('status'))
    .filter((lead) => !query.get('source') || lead.source === query.get('source'))
    .filter((lead) => query.get('remote') !== 'true' || lead.remote_policy === 'remote')
    .filter((lead) => `${lead.title} ${lead.company}`.toLowerCase().includes(search))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const items = matches.slice(offset, offset + limit).map(toSummary);
  return { items, total: matches.length };
}

function listEvents(query) {
  const agent = query.get('agent');
  if (agent !== 'applier') throw new HttpError(422, 'agent must be applier');
  const since = query.get('since');
  if (since && Number.isNaN(Date.parse(since)))
    throw new HttpError(422, 'since must be an ISO time');
  const limit = Math.min(Number(query.get('limit') ?? 500), 2000);
  return eventsOutsideRuns({ agent, since, limit });
}

function streamEvents(req, res) {
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.write(': connected\n\n');
  const unsubscribe = subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function sendFile(res, jobId, name) {
  const file = applicationFile(leadOr404(jobId), decodeURIComponent(name));
  if (!file) throw new HttpError(404, `No file ${name}`);
  res.writeHead(200, { ...CORS, 'Content-Type': file.type });
  res.end(file.body);
}

/** [method, path pattern, handler(match, { query, body })] -> JSON-serialisable result */
const ROUTES = [
  ['GET', /^\/api\/health$/, () => ({ status: 'ok' })],
  ['GET', /^\/api\/pipeline$/, () => livePipeline(pipeline)],
  ['GET', /^\/api\/runs$/, () => state.runs],
  ['POST', /^\/api\/runs$/, (_, { body }) => startRun(body)],
  ['GET', /^\/api\/runs\/([^/]+)$/, ([, id]) => runOr404(id)],
  ['GET', /^\/api\/runs\/([^/]+)\/events$/, ([, id]) => state.events.get(runOr404(id).id)],
  ['GET', /^\/api\/events$/, (_, { query }) => listEvents(query)],
  ['GET', /^\/api\/leads$/, (_, { query }) => listLeads(query)],
  ['GET', /^\/api\/leads\/([^/]+)$/, ([, id]) => leadOr404(id)],
  ['PATCH', /^\/api\/leads\/([^/]+)$/, ([, id], { body }) => patchLead(leadOr404(id), body)],
  ['POST', /^\/api\/leads\/([^/]+)\/tailor$/, ([, id]) => tailor(leadOr404(id))],
  ['POST', /^\/api\/leads\/([^/]+)\/apply$/, ([, id]) => applyTo(leadOr404(id))],
  ['GET', /^\/api\/settings$/, () => state.settings],
  ['PUT', /^\/api\/settings$/, (_, { body }) => (state.settings = { ...state.settings, ...body })],
];

/** How many workers an agent has: its own number from Setup, else the common one. */
function workersFor(agent) {
  if (!POOLED.includes(agent)) return 1;
  return state.settings.workers || 1;
}

/** The pipeline with what Setup decides: which sources are on, how many workers an agent has. */
function livePipeline({ nodes, edges }) {
  const enabled = (node) => state.settings.sources[node.id.replace('source:', '')] ?? node.enabled;
  const live = (node) => ({ ...node, enabled: enabled(node), workers: workersFor(node.id) });
  return { nodes: nodes.map(live), edges };
}

function runOr404(id) {
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) throw new HttpError(404, `No run ${id}`);
  return run;
}

function patchLead(lead, { status }) {
  if (!['new', 'skipped', 'applied'].includes(status)) {
    throw new HttpError(422, 'status must be new, skipped or applied');
  }
  return setStatus(lead, status);
}

function applyTo(lead) {
  if (!['cv_ready', 'form_filled'].includes(lead.status)) {
    throw new HttpError(409, `Cannot fill the form while the lead is ${lead.status}`);
  }
  return fillForm(lead);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();
  if (url.pathname === '/api/events/stream') return streamEvents(req, res);

  const file = url.pathname.match(/^\/api\/leads\/([^/]+)\/files\/([^/]+)$/);
  if (file && req.method === 'GET') return sendFile(res, file[1], file[2]);

  for (const [method, pattern, handler] of ROUTES) {
    const match = req.method === method && url.pathname.match(pattern);
    if (!match) continue;
    const result = handler(match, { query: url.searchParams, body: await readJson(req) });
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(result));
  }
  throw new HttpError(404, `No route ${req.method} ${url.pathname}`);
}

createServer((req, res) => {
  handle(req, res).catch((error) => {
    res.writeHead(error.status ?? 500, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: error.message }));
  });
}).listen(PORT, () => console.log(`Mock orchestrator on http://localhost:${PORT}`));
