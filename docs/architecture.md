# Architecture

## Message flow

Agents never call each other. Each one reads a Redis Stream, does one job, and writes the
next stream. Every step is also written to the `events` stream.

```
POST /api/runs
      │
      ▼
 runs.start ──► scout ──► jobs.raw ──► filter ──► jobs.filtered ──► extractor
                                                                        │
              (lead ready) ◄── researcher ◄── jobs.scored ◄── scorer ◄── jobs.extracted

 every agent ──► events ──► orchestrator ──► Postgres (event log, leads, runs)
                                         └─► Server-Sent Events ──► web UI

 UI button ──► orchestrator ──► apply.requests ──► applier (host) ──► events
```

| Stream | Writer | Reader | Payload (`schemas.py`) |
|---|---|---|---|
| `runs.start` | orchestrator | scout | `RunCommand` |
| `jobs.raw` | scout | filter | `JobMessage` |
| `jobs.filtered` | filter | extractor | `JobMessage` |
| `jobs.extracted` | extractor | scorer | `JobMessage` + `extracted` |
| `jobs.scored` | scorer | researcher | `JobMessage` + `score` |
| `apply.requests` | orchestrator | applier | `ApplyCommand` |
| `events` | everyone | orchestrator | `Event` |

A `JobMessage` grows as it travels: each stage fills in its own field and passes it on.

## Events are the source of truth

An `Event` records one step of one agent (`item.started`, `item.finished`, `item.dropped`,
`item.failed`, `item.waiting`, plus `source.*`, `scout.done` and `run.*`). The orchestrator
appends every event to Postgres and derives everything else from them:

- **Leads** are a projection (`orchestrator_service/projector.py`). The filter's
  `item.finished` creates the lead; the extractor, scorer, researcher and applier events
  fill it in.
- **Run statistics** are counted from the stored events as distinct jobs, so a redelivered
  message cannot skew them. Each event that ends a job's trip is marked (`ends_job`). A run
  is finished when the scout has said `scout.done` and no job is still in flight.
- **Pipeline failures** are shown on the lead (`pipeline_error`) until that step succeeds.
- **The live graph** is a reduction of the same events in the browser
  (`web/lib/pipeline/reducer.ts`). The time scrubber replays a run by reducing its stored
  events up to the chosen moment, so the past view is exact, not approximated.

## Who owns what

| State | Owner | Others read it through |
|---|---|---|
| Postgres (events, leads, runs, settings) | orchestrator only | the REST API |
| User settings | orchestrator | a Redis mirror (`leadscout:settings`) |
| Source catalogue | scout | Redis (`leadscout:sources`), so the graph shows real adapters |
| Seen job ids | scout | Redis set, for de-duplication across runs |
| Request guards for Jobicy and Remotive | scout | Redis keys with a time-to-live |
| Applier command in progress | applier | Redis key, to report an interrupted action |
| CV and preferences | scorer (read-only mount) | nobody else |
| Form data in `profile.yaml` | the job-applier agent on the host | never sent to a local model |

## Design decisions

**Fixed pipeline, one free agent.** Small local models are unreliable at choosing among
many tools, so the order of stages is code, not a model's decision. The extractor makes two
small schema-constrained calls and the scorer one. Only the researcher is a deep agent
(`deepagents.create_deep_agent`) that plans its own tool calls, and it is boxed in: it sees
two tools (deepagents' built-ins are hidden by a harness profile), a step limit and a time
budget.

**The model judges, the code computes.** Small models classify well and add up badly. The
scorer's model picks which required skills the CV shows and judges logistics; role,
seniority and the total are computed in `rubric.py`.

**Cheap filter before any chat model.** Most postings on a general board are not AI
roles. Title keywords and embeddings decide that in milliseconds, so the GPU only works on
plausible jobs.

**One 14B model at a time.** `qwen3:14b` at Q4 is about 9.3 GB; with a 16k context and the
1.2 GB embedding model it fits a 16 GB card. Using a different chat model per agent would
make Ollama reload on every stage change, so the default is one model for all three.

**Explicit context size.** Ollama defaults to a 4k context on GPUs under 24 GB and
truncates silently; deepagents' summariser assumes 170k tokens when the model has no
profile. `leadscout_common/llm.py` therefore sets `num_ctx` and the matching
`profile.max_input_tokens` on every model.

**At-least-once delivery, idempotent consumers.** A stage acknowledges a message only
after handling it, so a crash redelivers it. Events carry a unique id and the orchestrator
ignores one it has already stored. Outages are waited out rather than turned into failed
jobs: a stage that cannot reach Ollama retries the same job with back-off, and the
orchestrator retries an event until the database stores it (only an event whose own data
is invalid is skipped). Its consumer task is supervised and restarted; `/api/health`
answers 503 if it stops. The applier is the exception: it acknowledges first, because an
application must never be replayed.

**Writes only from the UI's own origin.** The API has no login, so it refuses
state-changing requests whose `Origin` is not in `CORS_ORIGINS` (a hostile page could
otherwise start the applier with a plain form POST) and requests with an unknown `Host`
header (DNS rebinding). Clients that send no `Origin`, such as curl, are allowed.

**The applier runs on the host.** It needs the Claude Code CLI, Chrome and the
`polishmycv` repo, and it is the only part that uses a hosted model. It acts only on a
command the orchestrator publishes when you press a button on one lead.

**One Dockerfile, many images.** `docker/service.Dockerfile` takes the service name as a
build argument. Each agent is still its own image and container; the recipe is not
copied six times.

**Tracing rides on the worker loop.** `worker.process_one` opens a Langfuse context for
each job (`tracing.job_context`), so any model call an agent makes while handling it is
attributed to the run, the agent and the job without the agent knowing about tracing.
With no Langfuse keys set, every tracing function is a no-op.

## Limits worth knowing

- No authentication. Every published port is bound to `127.0.0.1`; do not expose it.
- No migration tool: tables are created at start-up and `db.upgrade_schema` adds the
  columns introduced since the first version.
- A run whose queued messages were lost (for example Redis data deleted) stays "running".
- The event stream to the browser is in-memory fan-out from one orchestrator process.
- A job's id is a hash of company, title and location, so the same job on two boards is
  one lead, and a re-posted job with a changed title is a new one.
