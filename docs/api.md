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
| POST | `/api/runs` | `RunOptions` (all fields optional) | `Run` (201). `limit_per_source` is stored as the value the run uses |
| GET | `/api/runs/{run_id}` | | `Run`; 404 |
| GET | `/api/runs/{run_id}/events` | | `Event[]` of that run, oldest first |
| GET | `/api/events` | query: `agent=applier` (required; the only value), `since` (ISO time, inclusive), `limit` (1-2000, default 500) | `Event[]` oldest first: the latest `limit` events at or after `since` |
| GET | `/api/events/stream` | | Server-Sent Events: each `data:` line is one `Event`, for every run; `: keepalive` comments every 15 s |
| GET | `/api/leads` | query: `min_score`, `status`, `source`, `remote` (`true`), `q`, `limit` (1-200, default 50), `offset` (≥ 0) | `{ "items": LeadSummary[], "total": number }`, by score, unscored last |
| GET | `/api/leads/{job_id}` | | `Lead`; 404 |
| PATCH | `/api/leads/{job_id}` | `{ "status": "new" \| "skipped" \| "applied" }` | `Lead`. `new` restores a skipped lead, or resets one stuck in `tailoring`/`filling`, to its furthest valid state (`cv_ready` if it has files, else `researched`, `scored` or `new`) |
| POST | `/api/leads/{job_id}/tailor` | | `Lead` (202, status `tailoring`); 409 while the applier works on it |
| POST | `/api/leads/{job_id}/apply` | | `Lead` (202, status `filling`); 409 unless the lead has tailored files and is `cv_ready`, `form_filled` or `failed` |
| GET | `/api/leads/{job_id}/files/{name}` | | A file listed in `application.files`, from the application folder; 404 otherwise |
| GET | `/api/settings` | | `Settings` |
| PUT | `/api/settings` | `Settings` | `Settings` |

## Types

```ts
type AgentId = 'scout' | 'filter' | 'extractor' | 'scorer' | 'researcher' | 'applier' | 'orchestrator';

type EventType =
  | 'run.started' | 'run.finished'
  | 'source.started' | 'source.finished' | 'source.failed' | 'scout.done'
  | 'item.started' | 'item.finished' | 'item.dropped' | 'item.failed' | 'item.waiting';

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
  // item.dropped: { reason }   item.failed: { error }   item.waiting: { reason }
  //   (applier events also carry `action`)
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
}
interface Pipeline { nodes: PipelineNode[]; edges: { source: string; target: string }[]; }

interface RunOptions {
  sources: string[];                // empty: every enabled source
  limit_per_source: number;         // 0 in a request: the Settings value
  force: boolean;                   // re-send postings already seen
}
interface Run {
  id: string;
  status: 'running' | 'finished';
  started_at: string;
  finished_at: string | null;
  options: RunOptions;
  // Distinct jobs; in_flight = discovered minus jobs whose trip has ended.
  stats: { discovered: number; dropped: number; failed: number; scored: number; researched: number; in_flight: number };
}

type LeadStatus = 'new' | 'scored' | 'researched' | 'tailoring' | 'cv_ready'
  | 'filling' | 'form_filled' | 'applied' | 'skipped' | 'failed';

interface LeadSummary {
  job_id: string; status: LeadStatus; score: number | null;
  title: string; company: string; location: string; source: string; url: string;
  remote_policy: string; seniority: string; role_family: string;
  posted_at: string | null; updated_at: string;
}
interface Lead extends LeadSummary {
  job: JobPosting; extracted: ExtractedJob | null; score_detail: FitScore | null; brief: CompanyBrief | null;
  application: {
    dir: string; files: string[]; unanswered: string[]; error: string;
    filled_fields?: string[];
    cost_usd?: number | null;       // Claude Code's figure for this lead's sessions, at API prices
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
}
```

`JobPosting`, `ExtractedJob` (`JobFacts` plus `JobHighlights`), `FitScore` (with
`breakdown: { skills, role, seniority, logistics }`) and `CompanyBrief` are defined
field-for-field in `schemas.py`.
