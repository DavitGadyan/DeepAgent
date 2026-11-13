# LeadScout

Finds AI and machine-learning jobs, scores each one against your CV, researches the
company, and shows the whole agent pipeline live as a graph. Discovery, scoring and
research run on open-weight models through Ollama, sized for one 16 GB GPU. When you
approve a job, a separate agent tailors your CV and fills the application form for you
to review and submit.

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Using it](#using-it)
- [Architecture](#architecture)
- [Agents](#agents)
- [Job sources](#job-sources)
- [Models and hardware](#models-and-hardware)
- [Applying to a job](#applying-to-a-job)
- [Tracing and costs (Langfuse)](#tracing-and-costs-langfuse)
- [Configuration](#configuration)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Best practices used](#best-practices-used)
- [Claude Code setup in this repo](#claude-code-setup-in-this-repo)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)

## What it does

1. **Scout** pulls postings from 15 sources (company ATS boards, remote job boards,
   Hacker News, Y Combinator and more).
2. **Filter** keeps the target roles: AI Engineer, ML Engineer, Deep Learning, Data
   Scientist, Generative AI, AI Solutions, Forward Deployed Engineer and similar.
3. **Extractor** reads each posting into facts (skills, seniority, salary, remote policy)
   and short key points (what you'll do, what they need, what you get).
4. **Scorer** rates the job against your CV and portfolio from 0 to 100 and says why.
5. **Researcher** writes a sourced company brief for the leads above a score threshold.
6. **Applier** (only when you press the button on a lead) tailors your CV with the
   `polishmycv` skill and fills the application form in a browser. It stops before
   Submit; you press it.

Each agent handles several jobs at the same time (you choose the number of workers), and
the three model agents save a checkpoint after every step, so a job that is cut off
continues where it stopped.

The web UI shows the pipeline as a live node graph, with a time slider that replays any
run to any moment. It has light and dark themes (the toggle is at the bottom of the nav
rail; the default follows your system).

## Quick start

You need Docker, [uv](https://docs.astral.sh/uv/), Node 22 with pnpm, and a model server
you can reach: Ollama, or vLLM (see [Models and hardware](#models-and-hardware)).

```bash
make setup                 # .env, data/profile/profile.yaml, dependencies
$EDITOR .env               # set OLLAMA_BASE_URL and POLISHMYCV_HOME
make models                # pulls qwen3:14b and bge-m3 (see "Models and hardware")
make up                    # builds and starts every container
```

Open <http://localhost:3000/setup>, fill in **Your profile** (preferences for scoring,
answers for application forms) and choose the **Claude Code access**. Then press
**Start run** on the Pipeline page.

To use the Apply buttons, also run the applier on this machine (it needs the Claude Code
CLI, Chrome, and the polishmycv repo):

```bash
make applier               # keep it running in its own terminal
make applier-selftest      # once: checks the form-filling agent on a local dummy form
```

No GPU on this machine? See [Models and hardware](#models-and-hardware).

Moving to the Ubuntu GPU machine, with the data? Follow
[docs/install-ubuntu.md](docs/install-ubuntu.md). If ports 3000, 8000 or 6379 are in use,
set `WEB_PORT`, `API_PORT` or `REDIS_PORT` in `.env`.

## Using it

| Page | What you do there |
|---|---|
| **Pipeline** | Start a run, with the number of **workers** (rows), watch it, and **Stop** it. Each row is a whole pipeline: Filter, Extractor, Scorer, Researcher, Applier, and the job as JSON. The scout deals the jobs to the rows in turn; a job never leaves its row. Hover a node for the job (thread) it holds. Click it for the side panel: the agent's own graph drawn as an orbit, with the step the job is in, then its counters and past events. The card at the end of a row shows the job as JSON, growing as agents add to it. Drag the slider to see the pipeline as it was at any moment; **Live** returns to now. |
| **Leads** | Jobs, newest first (or best score first). Filter by found date (last 24 hours, 3 days, 7 days, or a date range), score, status, source, remote, or text. New and changed leads appear at once, without a reload. |
| **Lead** | Key facts at a glance, the score with its four-part breakdown, the role as short bullets, the company brief, and the **Application** panel. The full posting is one click away. A step that failed for this job says so. |
| **Runs** | History of runs with their counts. Click one to replay it. |
| **Cost** | What the Claude Code sessions cost per day, action, model and lead; the monthly budget and the cap per session; a link to the Console for your credit balance. |
| **Setup** | Turn sources on and off, edit target and excluded phrases, set the research threshold, the per-source limit and the workers per agent; your profile; Claude Code access and model. |

## Architecture

One container per agent. Agents never call each other: each reads one Redis Stream and
writes the next, and reports every step as an event. The orchestrator stores the events
and derives leads, run statistics and the live graph from them.

The pipeline has N rows (the worker count). Inside its container, each agent has one
worker per row. The scout deals the jobs of a run to the rows in turn, and a job is handled
by the worker of its row in every agent, so rows never exchange jobs. Inside a row the
agents work at the same time, each on its own job. The extractor, scorer and researcher
are LangGraph graphs with checkpoints in Postgres, one thread per job.

```
            ┌──────────── web (Next.js) ────────────┐
            │ Pipeline graph · Leads · Runs · Cost · Setup │
            └───────────────┬───────────────────────┘
                     REST + Server-Sent Events
                    ┌───────▼────────┐
                    │  orchestrator  │── Postgres (events, leads, runs, settings;
                    └───────┬────────┘            LangGraph checkpoints of the agents)
                       Redis Streams
   ┌──────────┬───────────┼────────────┬──────────────┐
 scout ──► filter ──► extractor ──► scorer ──► researcher        applier (host)
(no model) (embeddings)  (LLM)       (LLM)   (deep agent         (Claude Code +
                                              + SearXNG)          Chrome, on approval)
                    └── Ollama or vLLM (your GPU box) ──┘
```

Details, the stream table and the design decisions are in
[docs/architecture.md](docs/architecture.md). The HTTP API is in [docs/api.md](docs/api.md).

## Agents

| Agent | Job | Model |
|---|---|---|
| Scout | Runs the source adapters, forwards postings not seen before | none |
| Filter | Title keywords, then title embeddings, then posting text | `bge-m3` |
| Extractor | Posting to facts and key points, in two small calls | `qwen3:14b` |
| Scorer | Picks the required skills your CV shows; code computes the score | `qwen3:14b` |
| Researcher | Deep agent with web search and page fetch only; sourced company brief | `qwen3:14b` |
| Applier | Tailors the CV and fills the form, on your approval | Claude Code |

The pipeline order is fixed in code, because small models are unreliable at choosing
among many tools. Only the researcher plans its own steps. More in
[docs/agents.md](docs/agents.md).

## Job sources

Greenhouse, Lever and Ashby boards (54 verified company slugs in `config/sources.yaml`),
RemoteOK, Remotive, We Work Remotely, Hacker News "Who is hiring", Y Combinator jobs,
Jobicy, startup.jobs, Teamtailor sites (jobs.ethikos.es), talent40.com and freelancermap.

LinkedIn and Indeed adapters exist but are **off by default** and only run with
`ENABLE_SCRAPED_SOURCES=true`: they have no public API and scraping is against their
terms. LinkedIn's guest search worked when tested; Indeed returned HTTP 403 to every
request, so treat that adapter as not working.

Endpoints, terms and the state of each adapter are in [docs/sources.md](docs/sources.md).

## Models and hardware

Defaults are in `config/agents.toml`, sized for a single 16 GB GPU:

| Model | Size (Q4) | Used by |
|---|---|---|
| `qwen3:14b` | about 9.3 GB | extractor, scorer, researcher |
| `bge-m3` | about 1.2 GB | filter |

With a 16k context this leaves room for the KV cache. One chat model for all three
agents avoids reloading between stages. `deepseek-r1:14b` (9 GB) also fits and can be
used for scoring with `SCORER_MODEL=deepseek-r1:14b`; current full-size DeepSeek models
do not fit in 16 GB.

**Ollama on a GPU box, LeadScout on your laptop.** On the box run
`OLLAMA_HOST=0.0.0.0 ollama serve` and `ollama pull qwen3:14b && ollama pull bge-m3`; in
the laptop's `.env` set `OLLAMA_BASE_URL=http://<box address>:11434`. Ollama has no login,
so do this only on a network you trust.

**Everything on the GPU box.** It needs the NVIDIA container toolkit. Set
`OLLAMA_BASE_URL=http://ollama:11434` in `.env`, then:

```bash
docker compose --profile gpu up -d --build   # includes the Ollama container
make models                                  # pulls into the container
```

Every port is bound to the box's localhost. From your laptop, open a tunnel and use
<http://localhost:3000> as usual: `ssh -L 3000:localhost:3000 -L 8000:localhost:8000 <box>`.

**vLLM instead of Ollama** (Ubuntu with an NVIDIA GPU). vLLM serves the OpenAI API, and
LeadScout talks to any server that does. vLLM's default port 8000 is the LeadScout API's,
so use another one. It serves one model per process, so the embedding model gets its own
small process (or stays on Ollama with `EMBED_PROVIDER=ollama`):

```bash
# Chat model. The tool flags are what the researcher's tool calls need.
vllm serve Qwen/Qwen2.5-7B-Instruct --port 8001 --max-model-len 16384 \
  --gpu-memory-utilization 0.75 --enable-auto-tool-choice --tool-call-parser hermes
# Embeddings for the filter.
vllm serve BAAI/bge-m3 --port 8002 --gpu-memory-utilization 0.12
```

In `.env` (then `make up`; `make models` is for Ollama only):

```bash
LLM_PROVIDER=openai
LLM_BASE_URL=http://host.docker.internal:8001/v1
LEADSCOUT_MODEL=Qwen/Qwen2.5-7B-Instruct
LEADSCOUT_NUM_CTX=16384          # not larger than --max-model-len
EMBED_BASE_URL=http://host.docker.internal:8002/v1
FILTER_MODEL=BAAI/bge-m3
```

`host.docker.internal` reaches a vLLM on the same machine; start vLLM with
`--host 0.0.0.0` for that, and with `--api-key <key>` plus `LLM_API_KEY=<key>` if the
machine is on a network you do not trust. The OpenAI-compatible code path was tested
against Ollama's `/v1` endpoint; vLLM itself and a GPU were not available for testing,
so check the two commands above against your vLLM version.

**Workers.** The number next to **Start run** (or on Setup) is the number of rows: how
many jobs each agent handles at the same time. vLLM batches parallel requests, so more
rows give more throughput until the GPU is full. Ollama handles `OLLAMA_NUM_PARALLEL`
requests at once (set it on the Ollama server); rows beyond that only wait. On a machine
without a GPU keep one row: parallel model calls on a CPU only slow each other down
until they time out.

**The "waiting" number.** A column header shows how many jobs wait in front of that
agent. It is not a block between agents: a job that an agent finished goes to the next
agent of its row at once. It is the speed of the model. Each row takes one job per agent
at a time, and a model call takes seconds on a GPU and minutes on a CPU, so a run that
finds hundreds of jobs queues them in front of the first model agent. To make the queue
shorter: more rows on a GPU, a lower limit per source, or narrower keywords on Setup.

**Without a GPU** (development; this is how it was tested). In `.env`:

```bash
LEADSCOUT_MODEL=qwen2.5:7b
LEADSCOUT_NUM_CTX=4096
LEADSCOUT_TIMEOUT_S=900
RESEARCHER_TIMEOUT_S=3600
```

and `make models CHAT_MODEL=qwen2.5:7b`. Each model call takes minutes on a laptop CPU
(measured: extraction about 8 minutes, scoring 3 to 5, a company brief about 7), so keep
runs small with a `limit_per_source` of 2 or 3. Each setting can be set for one agent
(`RESEARCHER_NUM_CTX`, `SCORER_MODEL`, …) or for all chat agents (`LEADSCOUT_…`); the
researcher never goes below the 8k context its fixed prompt needs.

## Applying to a job

On a lead's page:

1. **Tailor CV** runs Claude Code headless with your `polishmycv` skill. The tailored CV,
   cover letter and notes appear on the page.
2. **Fill application form** opens a tab in a Chrome window on the applier machine, fills
   the form from the `application` section of `data/profile/profile.yaml`, uploads the CV
   and cover letter, and stops.
3. You check the form in that window and press Submit yourself, then **Mark as applied**.

What the agent will not do: submit, invent an answer, create an account, log in, or solve
a CAPTCHA. Questions it cannot answer from your profile are left blank and listed on the
page. If the form is behind a login, it says so; log in in the open window (the Chrome
profile keeps you logged in) and press the button again. A failed fill keeps your
tailored CV: you can retry, or apply by hand with the files on the page.

**What each session may do.** Job descriptions and web pages are untrusted text, so both
sessions run with Claude Code's restricted mode and an exact tool list:

| Session | May | May not |
|---|---|---|
| Tailor CV | read the polishmycv repo and skill; write only this lead's folder; run the skill's own scripts and the poppler tools | run other commands or code, read other files, see your `.env` |
| Fill form | the listed browser tools in its own tab; open pages on the posting's site; follow links by clicking; upload only this lead's files | read or write files, run commands, press keys, submit (a guard hook refuses submit-like clicks, Enter, uploads from elsewhere and non-web addresses) |

Each session has a time cap (`APPLIER_*_TIMEOUT_S` in `.env`) and a spending cap (Setup
page). A button press that waited more than 15 minutes for the applier is not acted
on, and a lead whose action was interrupted (the applier was stopped) is reported as such.
If a lead still looks stuck, its page offers **Reset**.

This step uses Claude, not a local model, and only for jobs you approve. The switch on the
Setup page chooses how it signs in:

| Claude Code access | Signs in with | Billed to |
|---|---|---|
| Claude login (default) | the account from `claude auth login`; an `ANTHROPIC_API_KEY` in `.env` is removed from the session | your Claude plan's usage |
| Console API key | `ANTHROPIC_API_KEY` in `.env`, read for every command (no restart) | your Anthropic Console account, per token |

While `make applier` runs, the Setup page shows whether the chosen access works. The
Setup page also picks the **Tailor CV model**: Claude Code's default, an alias (`opus`,
`sonnet`, `haiku`, `fable`, each the latest of its family) or a full model name. It is
recorded per session in Langfuse.

## Tracing and costs (Langfuse)

Optional. Set `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` in `.env` (and
`LANGFUSE_BASE_URL` for a self-hosted server), then `make up` and restart the applier.
Without the keys nothing is sent and nothing changes.

Every model call is then recorded in [Langfuse](https://langfuse.com) with its prompt,
output, latency and token counts:

| Call | Recorded as | Tokens | Cost |
|---|---|---|---|
| Extractor, scorer | generation, with the JSON it returned | from Ollama | see below |
| Researcher | one trace with every model step and tool call | from Ollama | see below |
| Filter | embedding | from Ollama | see below |
| Applier (Claude Code) | generation per session | from Claude Code | the USD figure Claude Code reports |

Calls are grouped so you can follow one job or one run: the **session** is the pipeline
run, the **trace** is one agent handling one job, tags carry the agent and the source, and
metadata carries the job id, title and company. Applier sessions use `lead-<job id>`.

**Costs.** Local models have no per-token price, so Langfuse shows their tokens and a cost
of zero. To see a notional cost, add a price for `qwen3:14b` under *Settings → Models* in
Langfuse (for example your electricity or hardware estimate per million tokens); Langfuse
then computes cost per call from the recorded tokens. The applier's cost is what Claude
Code reports for the session at API prices; the lead page shows the total per lead, with
or without Langfuse. On a Claude subscription that figure is usage, not a charge.

**Where to run Langfuse.** Langfuse Cloud needs only the two keys. Self-hosting uses
Langfuse's own
[Docker Compose](https://langfuse.com/self-hosting/deployment/docker-compose) (several
containers; they recommend 4 cores and 16 GB), so run it on the GPU box or another server,
not next to Ollama on a 16 GB laptop. It is deliberately not bundled into this compose file.

## Configuration

| File | What it holds | When a change applies |
|---|---|---|
| `.env` | Model server (Ollama or vLLM) address, model overrides, path to the polishmycv repo, Langfuse keys, `ANTHROPIC_API_KEY` | `make up`; restart `make applier` (except `ANTHROPIC_API_KEY`: next command) |
| `config/agents.toml` | Model, context size, timeout and thresholds per agent | `docker compose restart <agent>` |
| `config/roles.yaml` | First-start target phrases, excluded phrases, non-target roles, role points for scoring | next job (target and excluded phrases: the Setup page wins) |
| `config/sources.yaml` | Company slugs and per-source settings; which sources start enabled | next run |
| `data/profile/profile.yaml` | Your preferences (for scoring) and application details (for forms), edited on the Setup page or by hand. Git-ignored | next job |

The `config/` folder is mounted into the containers read-only. Settings changed on the
Setup page (sources, keywords, thresholds, Claude access, spending caps) are stored in the
database and win over `roles.yaml`. The profile is saved to `profile.yaml` itself.

**Backup, and a move to another machine.** `make backup` saves the database, the queues
and your profile to one archive in `backups/` (stop the agents first); `make restore
FILE=<archive>` loads it, also into a new install, and a run in progress continues there.
`make prior-applications FILE=<json>` imports applications you made outside LeadScout: a
lead for the same job takes the status (applied, in review, interview, rejected, skipped)
and the documents that were sent. The steps for the Ubuntu machine are in
[docs/install-ubuntu.md](docs/install-ubuntu.md).

## Repository layout

```
config/                 agents.toml, roles.yaml, sources.yaml
data/profile/           profile.example.yaml (your profile.yaml is git-ignored)
packages/common/        shared contracts (schemas.py), bus, worker loop, LLM factory, tracing
services/
  scout/                source adapters (one file each) and the run loop
  filter/               keyword and embedding rules, eval set
  extractor/            prompts, eval set
  scorer/               prompt, rubric, profile loader, eval set
  researcher/           deep agent, web tools, prompt
  orchestrator/         FastAPI, event log, projections
  applier/              host worker: Claude Code runner, Chrome, submit guard, self-test
web/                    Next.js UI (pipeline graph, leads, runs, setup)
docker/                 service.Dockerfile, SearXNG settings
docs/                   architecture, agents, sources, api
tests/                  repository-level tests (the push guard)
.claude/                project settings and hooks, the job-applier subagent
```

## Development

```bash
make test     # unit tests: no network, no model
make evals    # filter, extractor and scorer against a real model (slow on CPU)
make lint     # ruff, eslint, prettier, tsc
make logs     # follow all containers
```

Run one service outside Docker: stop its container first (`docker compose stop
extractor`), then `REDIS_URL=redis://localhost:6379/0 OLLAMA_BASE_URL=http://localhost:11434
uv run python -m extractor_service.main`. The scorer also needs `PROFILE_CV_PATH` and
`PROFILE_CATALOGUE_PATH` (see `make evals` for the values). The UI has a dependency-free
mock backend for front-end work: `cd web && pnpm mock` and `pnpm dev`.

## Best practices used

**Architecture**

- One responsibility and one container per agent; shared code only in `packages/common`.
- Agents are decoupled by a message bus. None imports or calls another.
- Typed contracts: every message and event is a pydantic model in one file.
- Event sourcing: the stored event log is the trace, the audit record and the data
  behind the replay slider. Run statistics count distinct jobs, so a redelivered message
  cannot skew them.
- A single database owner (the orchestrator). Agents are stateless.
- At-least-once delivery with idempotent consumers; the applier is at-most-once because
  an application must never be replayed. An unreachable model server or database is
  waited out instead of failing the jobs in the queue.

**Local models** (from LangChain's
[better-harness](https://github.com/langchain-ai/deepagents/tree/main/examples/better-harness)
example and the deepagents docs)

- The extractor, scorer and researcher prompts are files, one folder per agent.
- Labelled eval cases with train and holdout splits, including a real posting; a prompt or
  rule change is kept only if the numbers improve.
- Schema-constrained JSON output for the extractor and scorer; the researcher answers
  through a schema-shaped tool.
- Small schemas: the extractor asks for facts and for key points in two calls (one large
  schema made a 7B model leave most fields empty).
- The model judges, the code computes: the scorer returns which required skills your CV
  shows and a logistics judgement; role, seniority and the total are computed in Python.
- Few tools per agent: the researcher sees exactly its two tools, with a step limit and a
  time budget.
- Explicit context size on every model, because Ollama's default silently truncates.
- Retries only for transient errors (timeouts, dropped connections, 429, 5xx).
- Every model call is traceable (Langfuse) with tokens and cost, tied to its run and job.
- A cheap filter before any chat model, so the GPU works on plausible jobs only.

**Safety**

- Human approval for anything outward-facing; the agent never submits an application.
- The API refuses state-changing requests from other web sites and unknown host names.
- Web pages and job descriptions are treated as untrusted data: the page fetcher refuses
  private addresses (on every redirect), and the Claude Code sessions run in restricted
  mode with exact tool lists, a minimal environment and spending caps.
- Form details in `profile.yaml` never go to the scoring model; the form agent sees only
  the `application` section.
- Scraped sources are opt-in. Jobicy's and Remotive's request limits are enforced.

**Operations and code**

- Multi-stage images, non-root users, health checks (the API reports 503 when its event
  consumer stops), ports bound to localhost, `init` so containers stop at once.
- All configuration through files and environment; no secrets in git.
- Small functions, type hints, docstrings that say why; `ruff`, `eslint`, `prettier`,
  strict TypeScript.

## Claude Code setup in this repo

- **Claude Code cannot push; you can.** `.claude/settings.json` denies `git push` and
  the `gh` commands that publish (`pr create`, `repo create`, `repo sync`,
  `release create`), and a `PreToolUse` hook (`.claude/hooks/block_push.py`) parses
  every shell command Claude runs and refuses those, also inside `sh -c`, `sudo` or
  `git -C`, while allowing look-alikes such as `git stash push`. Both apply only to
  Claude Code sessions in this project; `git push` in your own terminal works as usual.
- **Concise replies.** The `concise` plugin (`o4f6bgpac3/concise`) is enabled for this
  project; `/concise` turns it on in a session.
- **`job-applier` subagent** in `.claude/agents/`, used by the applier service.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `open ~/.docker/buildx/current: permission denied` on build | Files in `~/.docker/buildx` owned by root. `sudo chown -R $USER ~/.docker/buildx`, or build with `BUILDX_CONFIG=/tmp/buildx make up`. |
| Every posting fails with `model "…" not found` | The model is not pulled into the Ollama the agents use: `make models` (with `CHAT_MODEL=…` if you changed it). |
| Extractor or scorer steps fail after a long wait | The model is too slow for `timeout_s`. On CPU use the values under "Without a GPU". |
| A lead says a step failed | It is retried when you start a run with **force** ticked. |
| Run stays "running" | A job is still in a queue; `make logs` shows which agent is working. If an agent container is stopped, its queue waits: `docker compose ps`. |
| Nothing found on a second run | Only postings not seen before are forwarded. Tick **force** in the Start run popover to re-process the first ones. |
| Scorer container exits at start | No CV text at `$POLISHMYCV_HOME/docs/cv/David_Gadyan_Resume.txt`; set `PROFILE_CV_RELPATH`. |
| "Can't reach the orchestrator" in the UI | `docker compose ps`; the API is at <http://localhost:8000/api/health>. |
| "Cross-site request refused" | The UI is opened from an address not in `CORS_ORIGINS` (for example 127.0.0.1 instead of localhost). Use <http://localhost:3000> or add the address. |
| Apply buttons do nothing | The applier is not running: `make applier`. A press older than 15 minutes is not acted on; press again. |
| `make applier` stops at `.env` | A value with spaces is not quoted, e.g. `CHROME_BIN="/Applications/Google Chrome.app/…"`. |

## Known limits

- No login on the UI or API. Ports are bound to `127.0.0.1` by default; `BIND_ADDRESS=0.0.0.0`
  opens the UI and API to your network (see `.env.example`). Never expose them to the internet.
- No migration tool; missing tables and the columns added since the first version are
  created at start-up.
- A run whose queued messages were lost (for example Redis data deleted) stays "running".
- The filter judges mostly by title. Measured on titles alone it finds 83% of target roles
  on unseen titles; the posting text rescues some of the rest.
- Scores from a 7B model on CPU are rough; the 14B model on a GPU is the intended setup.
- Some adapters parse page-embedded JSON (Y Combinator, talent40, freelancermap) and will
  break when those sites change. A broken source is reported on the graph and does not
  stop a run.
- startup.jobs, Y Combinator and LinkedIn results come without full descriptions, so
  their extraction and scores are weaker.
- The submit guard judges clicks by the element description the agent gives. Review every
  form before you press Submit.
