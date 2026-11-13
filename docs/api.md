# Orchestrator API

Base URL `http://localhost:8000`. JSON everywhere; timestamps are ISO 8601 UTC. The shapes
below mirror `packages/common/leadscout_common/schemas.py`, which is the source of truth.
Errors are FastAPI's `{ "detail": ... }`.

**Who may call it.** There is no login. Requests with a `Host` header other than
`localhost`, `127.0.0.1` or `orchestrator` (`ALLOWED_HOSTS`) get 400. State-changing
requests (POST, PUT, PATCH) whose `Origin` is not in `CORS_ORIGINS`, or that a browser
marks `Sec-Fetch-Site: cross-site`, get 403. Clients that send no `Origin` (curl,
scripts) are allowed.

## Endpoints

| Method | Path | Body or query | Returns |
|---|---|---|---|
| GET | `/api/health` | | `{ "status": "ok" }`; 503 when the event consumer has stopped |
| GET | `/api/pipeline` | | `Pipeline` |
| GET | `/api/runs` | | `Run[]`, newest first (at most 100) |
| POST | `/api/runs` | `RunOptions` (all fields optional) | `Run` (201). `limit_per_source` and `workers` are stored as the values the run uses. A `workers` value is saved to the settings and stays for later runs |
| GET | `/api/runs/{run_id}` | | `Run`; 404 |
| GET | `/api/runs/{run_id}/events` | | `Event[]` of that run, oldest first |
| GET | `/api/events` | query: `agent=applier` (required; the only value), `since` (ISO time, inclusive), `limit` (1-2000, default 500) | `Event[]` oldest first: the latest `limit` events at or after `since` |
| POST | `/api/runs/{run_id}/stop` | | `Run` with status `stopped`. The scout forwards nothing more and every agent lets go of the run's jobs. A run that is not running is returned unchanged; 404 |
| GET | `/api/events/stream` | | Server-Sent Events. Unnamed messages: one `Event` each, for every run. Messages named `lead`: one `LeadSummary` each time a lead is created or changes. `: keepalive` comments every 15 s |
| GET | `/api/leads` | query: `min_score`, `status`, `source`, `remote` (`true`), `q`, `found_after`, `found_before` (ISO times bounding when the lead was found), `sort` (`newest` default, or `score`), `limit` (1-200, default 50), `offset` (≥ 0) | `{ "items": LeadSummary[], "total": number }`, newest found first; with `sort=score` by score, unscored last |
| GET | `/api/leads/{job_id}` | | `Lead`; 404 |
| PATCH | `/api/leads/{job_id}` | `{ "status": "new" \| "skipped" \| "applied" }` | `Lead`. `new` restores a skipped lead, or resets one stuck in `tailoring`/`filling`, to its furthest valid state (`cv_ready` if it has files, else `researched`, `scored` or `new`) |
| POST | `/api/leads/{job_id}/tailor` | | `Lead` (202, status `tailoring`); 409 while the applier works on it, or when the monthly budget is used up (also for `/apply`) |
| POST | `/api/leads/{job_id}/apply` | | `Lead` (202, status `filling`); 409 unless the lead has tailored files and is `cv_ready`, `form_filled` or `failed` |
| GET | `/api/leads/{job_id}/files/{name}` | | A file listed in `application.files`, from the application folder; 404 otherwise |
| POST | `/api/prior-applications` | `PriorApplication[]` | `{ "stored": number, "leads_changed": number }`. Stores applications made before LeadScout or outside it; every lead for the same job takes the status and the documents. A lead found later takes them when it is created. The same list again changes nothing |
| GET | `/api/prior-applications` | | The stored applications, newest first |
| GET | `/api/costs` | query: `days` (1-366, default 30), `tz_offset_minutes` (the browser's offset east of UTC) | `CostReport`: what the Claude Code sessions cost, from the applier's stored events |
| GET | `/api/settings` | | `Settings` |
| PUT | `/api/settings` | `Settings` | `Settings` |
| GET | `/api/profile` | | `UserProfile`, from `data/profile/profile.yaml` (empty when there is none) |
| PUT | `/api/profile` | `UserProfile` | `UserProfile`; replaces the file. Keys added by hand are kept |
| GET | `/api/applier` | | `ApplierStatus`, or `null` when the applier worker is not running |

## Types

```ts
type AgentId = 'scout' | 'filter' | 'extractor' | 'scorer' | 'researcher' | 'applier' | 'orchestrator';

type EventType =
  | 'run.started' | 'run.finished'
  | 'source.started' | 'source.finished' | 'source.failed' | 'scout.done'
  | 'item.started' | 'item.finished' | 'item.dropped' | 'item.failed' | 'item.waiting'
  | 'item.progress';       // a node of the agent's LangGraph graph started

interface Event {
  id: string;
  ts: string;
  run_id: string;          // '' for applier events: they belong to a lead, not a run
  agent: AgentId;
  type: EventType;
  job_id: string;          // '' for run.*, source.* and scout.done
  title: string;           // 'ML Engineer @ Acme'
  duration_ms: number | null;
  data: Record<string, unknown>;
  // item.finished: { forwarded: boolean, ...stage result }
  //   scout:      { source }
  //   filter:     { reason, job: JobPosting }   <- creates the lead
  //   extractor:  { extracted: ExtractedJob }
  //   scorer:     { score: FitScore }
  //   researcher: { brief: CompanyBrief }
  //   applier:    { action: 'tailor' | 'fill_form', application_dir, files: string[],
  //                 cost_usd: number | null, filled_fields?: string[], unanswered?: string[] }
  // item.dropped: { reason, stopped?: true }   (stopped: the user stopped the run)
  // item.failed: { error }   item.waiting: { reason }
  // item.progress: { node, resumed?: true }   node = LangGraph node id; resumed = the job
  //                continued from a checkpoint at this node. Not a job start or end.
  // every item.* event of filter, extractor, scorer, researcher: { worker } (1..N), the
  //   row of the job: the scout deals the rows in turn and a job never changes rows
  // applier outcomes (finished, failed, waiting) also carry { action, access: 'login' |
  //   'console', model, cost_usd? }: a failed session keeps its cost
  // source.started: { source }
  // source.finished: { source, count, new, skipped }   source.failed: { source, error }
}

interface PipelineNode {
  id: string;                       // agent id, or 'source:<name>'
  label: string;
  kind: 'source' | 'tool' | 'llm' | 'deep' | 'human' | 'store';
  description: string;
  model: string;                    // '' when the node uses no model
  parent: string | null;            // sources have parent 'scout'
  enabled: boolean;
  workers: number;                  // agents: jobs handled at the same time (scout, applier: 1)
  graph: GraphShape | null;         // the agent's LangGraph graph, published by the agent
                                    // itself at start; null: not a graph, or not started yet
  steps: string[];                  // agents that are not graphs: what they do, in order
}
interface GraphShape {              // start and end have the ids '__start__' and '__end__'
  nodes: { id: string; label: string }[];
  edges: { source: string; target: string; conditional: boolean }[];
}
interface Pipeline { nodes: PipelineNode[]; edges: { source: string; target: string }[]; }

interface RunOptions {
  sources: string[];                // empty: every enabled source
  limit_per_source: number;         // 0 in a request: the Settings value
  force: boolean;                   // re-send postings already seen
  workers: number;                  // rows, 1-16; 0 or absent in a request: keep the Settings value
}
interface Run {
  id: string;
  status: 'running' | 'finished' | 'stopped';   // stopped: by the user, POST .../stop
  started_at: string;
  finished_at: string | null;
  options: RunOptions;
  // Distinct jobs; in_flight = discovered minus jobs whose trip has ended.
  stats: { discovered: number; dropped: number; failed: number; scored: number; researched: number; in_flight: number };
}

type LeadStatus = 'new' | 'scored' | 'researched' | 'tailoring' | 'cv_ready'
  | 'filling' | 'form_filled' | 'applied' | 'in_review' | 'interview' | 'rejected'
  | 'skipped' | 'failed';

interface LeadSummary {
  job_id: string; status: LeadStatus; score: number | null;
  title: string; company: string; location: string; source: string; url: string;
  remote_policy: string; seniority: string; role_family: string;
  posted_at: string | null;
  created_at: string;               // when LeadScout found the posting
  updated_at: string;
}
interface Lead extends LeadSummary {
  job: JobPosting; extracted: ExtractedJob | null; score_detail: FitScore | null; brief: CompanyBrief | null;
  application: {
    dir: string; files: string[]; unanswered: string[]; error: string;
    filled_fields?: string[];
    cost_usd?: number | null;       // Claude Code's figure for this lead's sessions, at API prices
    applied_at?: string | null;     // set from a prior application: when it was sent
    note?: string;                  // set from a prior application: where it comes from
  } | null;
  // The last pipeline step that failed for this job, until that step succeeds.
  pipeline_error: { agent: AgentId; error: string } | null;
}

interface Settings {
  sources: Record<string, boolean>;   // adapter name -> enabled
  keywords: string[];                 // target role phrases
  exclude_keywords: string[];
  research_min_score: number;         // 0-100
  limit_per_source: number;
  claude_access: 'login' | 'console'; // how applier sessions sign in
  tailor_budget_usd: number;          // USD cap per session, 0-200; 0 = no cap
  fill_budget_usd: number;
  tailor_model: string;               // '' = Claude Code's default; 'opus' | 'sonnet' | 'haiku' | 'fable' | full model name
  monthly_budget_usd: number;         // Claude spend allowed per month; 0 = no limit
  workers: number;                    // rows of the pipeline, 1-16: one worker of every agent each
}

interface CostReport {                // all amounts in USD at API prices
  today: CostAmount; last_7_days: CostAmount; this_month: CostAmount; all_time: CostAmount;
  monthly_budget_usd: number;
  by_day: { date: string; login_usd: number; console_usd: number }[]; // oldest first, every day
  by_action: CostSlice[]; by_model: CostSlice[]; by_access: CostSlice[];
  top_leads: { job_id: string; title: string; usd: number; sessions: number }[];
  links: { console_billing: string; langfuse: string };  // langfuse '' when tracing is off
}
interface CostAmount { usd: number; billed_usd: number; sessions: number } // billed = Console API key
interface CostSlice extends CostAmount { key: string; label: string }

interface UserProfile {               // every value is free text; '' = not stated
  preferences: Record<string, string>;  // locations, remote, contract_types, minimum_salary, seniority, avoid
  application: Record<string, string>;  // full_name, email, phone, ... (see profile.example.yaml)
}

interface PriorApplication {          // an application made before LeadScout or outside it
  company: string; title: string;
  urls: string[];                     // every address of the posting: the board's, the company's, the form's
  status: 'applied' | 'in_review' | 'interview' | 'rejected' | 'skipped';
  applied_at?: string | null;
  application_dir?: string;           // folder in the polishmycv output with the documents that were sent
  note?: string;
}
// A lead is the same job when its address carries the same job id (Greenhouse, Ashby, Lever,
// Workable, LinkedIn), or has the same host and path, or its company and title are the same.

interface ApplierStatus {             // refreshed every 10 s while `make applier` runs
  api_key_set: boolean;               // ANTHROPIC_API_KEY present
  logged_in: boolean;                 // `claude auth status`
  auth_method: string;                // e.g. "claude.ai"
  subscription: string;               // e.g. "max"; no e-mail or organisation is kept
  updated_at: string;
}
```

`JobPosting`, `ExtractedJob` (`JobFacts` plus `JobHighlights`), `FitScore` (with
`breakdown: { skills, role, seniority, logistics }`) and `CompanyBrief` are defined
field-for-field in `schemas.py`.
