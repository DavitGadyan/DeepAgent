# Agents

One container each (the applier runs on the host). Every pipeline agent is the same small
shape: a `handle(message)` function plugged into the shared loop in
`packages/common/leadscout_common/worker.py`, which adds events, timing, retries,
forwarding, tracing, waiting out an unreachable model server, one worker per row of the
pipeline (a job stays in its row), and letting go of the jobs of a run that was stopped. The extractor, scorer and researcher run each
job as a LangGraph thread with checkpoints in Postgres
(`leadscout_common/checkpoints.py`): after a crash the job continues at the node that did
not finish. Each of them publishes its graph, and reports the node a job enters, so the
Pipeline page can draw the graph and the job's position in it.

| Agent | Reads → writes | Model | Code | Prompts | Checked by |
|---|---|---|---|---|---|
| Scout | `runs.start` → `jobs.raw` | none | `services/scout/scout_service/` | – | 77 unit tests on recorded fixtures |
| Filter | `jobs.raw` → `jobs.filtered` | `bge-m3` (embeddings) | `services/filter/filter_service/` | – | unit tests + `evals/` (title set) |
| Extractor | `jobs.filtered` → `jobs.extracted` | `qwen3:14b` | `services/extractor/extractor_service/` | `prompts/{system,facts,highlights}.md` | unit tests + `evals/` (labelled postings) |
| Scorer | `jobs.extracted` → `jobs.scored` | `qwen3:14b` | `services/scorer/scorer_service/` | `prompts/system.md` | unit tests (rubric) + `evals/` (score bands) |
| Researcher | `jobs.scored` → end | `qwen3:14b` | `services/researcher/researcher_service/` | `prompts/system.md` | unit tests (tools, tool list) + a manual run |
| Applier | `apply.requests` → end | Claude Code | `services/applier/applier_service/` | `.claude/agents/job-applier.md` | unit tests + `make applier-selftest` |

## Scout

Runs every enabled adapter in `scout_service/sources/` (four at a time). It ranks each
source's postings (title contains a target phrase, then a word of one, then the rest) and
walks that list, forwarding postings it has not seen before until `limit_per_source` new
ones are sent, dealing them to the rows of the pipeline in turn; with **force**, the first `limit_per_source` are sent again. A posting is
marked seen only after it was published. It makes no relevance decision. One bad record
costs only itself (counted as `skipped`), and a failing source is reported as
`source.failed` without stopping the others. Jobicy and Remotive are asked at most once
an hour and once every six hours. Adapters are listed in [sources.md](sources.md).

To add a source: one file with a class that has `name`, `label`, `scraped` and
`async fetch(ctx) -> list[JobPosting]`, registered in `sources/__init__.py`, plus a test
with a recorded fixture.

## Filter

Three checks, cheapest first (`filter_service/rules.py`):

1. **Title keywords.** An exclude phrase drops the posting; a target phrase keeps it.
   Whole words only, so "AI" does not match "email".
2. **Title embedding.** Kept when the title is closer to a target role than to any role in
   `config/roles.yaml` `other_roles`, and at least `min_similarity` close. Similarity to
   target roles alone does not work: "DevOps Engineer" scores 0.76 against
   "Deep Learning Engineer" because of the shared word.
3. **Posting text.** A title the embedding dropped is still kept when the description
   mentions three or more distinct target phrases ("AI" inside "Generative AI Engineer"
   counts once).

Measured on titles alone with `bge-m3` (2026-11-11): train recall 0.93 / precision 0.82,
holdout recall 0.83 / precision 0.71. A wrongly kept posting costs one extractor call and
scores low; a wrongly dropped one is a lost lead, so the rule leans towards keeping.

## Extractor

A graph of three nodes: `facts` → `highlights` → `tidy`. The first two are
schema-constrained calls on the same posting: the facts (`JobFacts`: role family,
seniority, remote policy, contract, locations, salary, years, required and nice-to-have
skills) and the key points (`JobHighlights`: one-liner, summary, what you'll do, what they
need, what you get). The lead page shows the key points instead of the full text.

Why two calls: with one 17-field schema, `qwen2.5:7b` on a real posting returned no skills,
no summary and no bullets. Asked for the two halves separately it filled every field
(12 skills, 3 of 3 labelled facts) and finished sooner (488 s against 540 s on CPU),
because the posting is the same prompt prefix in both calls. That posting is now an eval
case.

The prompts forbid guessing: a fact the posting does not state is `unknown`, `null` or an
empty list. The job board's remote flag is passed in, and is used when the text says
nothing about remote work. Placeholders such as "unknown" inside lists are removed.

## Scorer

A graph of two nodes: `judge` (the model) → `rubric` (the code). The model is asked for
what needs reading; the code decides the rest (`scorer_service/rubric.py`):

| Part | Points | Who decides |
|---|---|---|
| Skills | 45 | Required skills your CV or portfolio names outright are matched by code; the model adds closely related ones (PyTorch for TensorFlow). Only skills from the job's list count, and the share sets the points. |
| Role | 25 | Code: the job's role family looked up in `config/roles.yaml` `role_fit`. A role worth 0 caps the total at 49. |
| Seniority | 15 | Code: the job's level against yours (`preferences.seniority`, else your years of experience). |
| Logistics | 15 | The model compares location, remote policy, contract and pay with your preferences (10 when you stated none). |

Small models classify well and compute badly: a 7B model matched 8 of 10 skills and
answered 42, gave "AI Engineer" 0 of 25 for role, and matched only "Python" against a CV
and portfolio that name LangChain, LangGraph, scikit-learn, Pinecone and MLflow.

Its inputs are the CV text, the skills evidenced in the polishmycv portfolio catalogue,
the `preferences` section of `data/profile/profile.yaml` (read again when the file
changes, so a save on the Setup page applies to the next job), and the extracted facts. The
catalogue matters: a one-page CV names few tools. The `application` section of
`profile.yaml` (phone, salary expectation and so on) is never sent to the model. Jobs
scoring under `research_min_score` stop here.

## Researcher

A deep agent (`deepagents.create_deep_agent`) that sees exactly two tools and its answer
format. Its graph is the loop `model` ↔ `tools`, checkpointed after every step; a research
that ran out of time starts fresh the next time. deepagents adds a file system, a to-do list and a `task` subagent by default; a
harness profile for Ollama models hides them (`researcher_service/agent.py`), which also
takes about 2,700 tokens off every request.

- `web_search(query)` queries the local SearXNG container. When the search engines time
  out it says so, instead of "no results".
- `fetch_page(url)` returns a page's readable text. It refuses non-http schemes and
  private addresses on every redirect and checks the address it actually connected to,
  because the URLs come from search results. Non-HTML pages are not dumped as text.

Both tools return text for every outcome, so a failed search does not end the research.
The brief's fields may be empty; the prompt says an empty field is a correct answer and an
invented one is not. It is bounded by a recursion limit (about ten tool calls) and a
wall-clock budget (`timeout_s`), and runs once per job (no automatic retry of the whole
research). Its context never goes below 8k tokens (`min_num_ctx`). If the model answers in
prose instead of the structured format, or returns sources with every field empty (seen
with `qwen2.5:7b`), a second call fills the brief from the search results and pages the
tools returned.

Measured with `qwen2.5:7b` on CPU: a real company brief in about 7 minutes, three searches
and one page.

## Applier

Runs on the host and only on a command for one lead that you approved in the UI. A
command older than 15 minutes (pressed while the applier was off) is not acted on. The
command in progress is noted in Redis, so a stop or a crash is reported on the lead.
Before each command it reads the Setup page's choices: **Claude access** (your Claude
login, with any `ANTHROPIC_API_KEY` removed from the session, or a Console API key, read
from `.env` at that moment, so adding it needs no restart) and the spending cap per
session. It reports to the Setup page whether a key is set (every 10 s) and whether Claude
Code is signed in (every minute; method and plan only).

**Tailor CV** runs `claude --print --restricted` in the `polishmycv` repo with the skill's
instructions as part of its system prompt and an output folder per lead
(`<date>-<company>-<role>-<job id>`). The session may read the repo and the skill, write
only that folder, and run only the skill's own scripts (by absolute path) and the poppler
tools. It gets a minimal environment, so `.env` values are out of its reach. The job
description is written to a file and described as untrusted data.

**Fill application form** runs the `job-applier` subagent in restricted mode with no
built-in tools at all: only the listed Playwright tools, attached to a Chrome the applier
started with its own profile (`~/.leadscout/chrome-profile`), so the window stays open with
the filled form after the agent exits. The `application` section of `profile.yaml`, the
cover letter and the notes are passed in the prompt. The agent opens its own tab and never
touches tabs that were already open. Layers that keep it from submitting:

1. The subagent's instructions: never click a control that sends the application.
2. Its tool list: no key presses, no script evaluation, no file access.
3. A `PreToolUse` hook (`services/applier/claude/guard_submit.py`) that refuses clicks
   without a description or on submit-like controls (in eight languages, and "Apply" once
   filling has started), Enter, typing that would press Enter, uploads from outside the
   lead's folder, non-web addresses, and typed addresses off the posting's site. If the
   hook itself fails, it refuses.
4. You: the guard judges clicks by the description the agent gives, so review every form.

`make applier-selftest` runs this whole path against a local dummy form with a made-up
applicant and reports whether the agent submitted, what it typed and uploaded, and
whether it left an unanswerable question blank.

A login wall, a CAPTCHA, a missing form or a timeout returns the lead to `cv_ready` with
the reason; the tailored files stay. The Playwright MCP version is pinned
(`browser.py`); change it together with the guard tests.

## Changing a prompt

Prompts are files, and each LLM agent has labelled cases in `evals/cases.json` split into
`train` and `holdout`. Edit the prompt, run `make evals`, and keep the change only if the
combined pass count goes up. This is the loop from LangChain's
[better-harness](https://github.com/langchain-ai/deepagents/tree/main/examples/better-harness)
example, done by hand.
