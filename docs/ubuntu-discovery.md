# Discovery on the Ubuntu machine

Before LeadScout is installed on the Ubuntu machine, the Claude Code agent there must
answer the questions below. The answers decide the install (ports, model server, memory,
network access) and show what version 1 (AIJobSearch) has that LeadScout can reuse.

How to use this file: start Claude Code on the Ubuntu machine and paste everything below
the line. Bring `~/leadscout-discovery/` back to the LeadScout session.

---

You are on an Ubuntu machine with a GPU. Two services run on it now:

- an **Upwork notifier** that uses a Qwen 7B model, and
- **AIJobSearch**, version 1 of a job search tool, open on the home network at
  `http://192.168.18.56:3010/`.

A new system, **LeadScout**, will be installed next to them. I need facts to plan the
install and to reuse what is good in version 1.

## What LeadScout is

- **Purpose.** It finds job postings, keeps the ones that fit the owner's profile, and
  helps the owner apply. The owner approves each application. It never submits a form.
- **Pipeline.** Each step is one agent in its own Docker container:
  1. **Scout:** gets postings from job sources (APIs, RSS, opt-in scrapers). No model.
  2. **Filter:** keeps target roles, with keywords and an embedding model.
  3. **Extractor:** a LangGraph graph (facts → highlights → tidy) that turns the posting
     into JSON with a fixed schema: contract type, remote policy, country, salary, skills.
  4. **Scorer:** a LangGraph graph (judge → rubric) that gives a fit score with four
     parts, against the owner's CV, project catalogue and preferences.
  5. **Researcher:** an agent with web search (SearXNG) that writes a company brief for
     jobs above a score threshold.
  6. **Applier:** on the host, not in Docker. It runs Claude Code to tailor the CV and
     cover letter, then fills the application form in a Chrome window and stops before
     Submit.
- **State.** Each job has its own thread id. Each graph step is saved to Postgres, so an
  agent that stops continues the job from the last step. All events are stored and the
  UI can replay a run.
- **Parallel work.** N workers give N full rows of agents. The scout deals the jobs to
  the rows.
- **UI.** Pipeline (live graph, stop, replay), Leads (filters, found date, live updates),
  Lead page (facts, score, brief, application), Runs, Cost, Setup.
- **Stack.** Python 3.12, uv, FastAPI, LangGraph, Redis Streams, Postgres 16, Next.js 16,
  Docker Compose. Langfuse tracing is optional.
- **What it needs on this machine.**
  - An OpenAI-compatible model server (the vLLM that serves Qwen) with JSON-schema
    output, tool calls and a context of 8192 tokens or more.
  - An embedding model (`BAAI/bge-m3`): about 1.5 GB VRAM, or a CPU process.
  - Approximately 3 GB RAM and 10 GB disk (estimates).
  - On the host, for the applier: Claude Code, Chrome, Node, and a desktop session.
  - Two ports open to the home network, for the UI and the API. It has no login.
- **What it does not have, and version 1 possibly has.** The history of applied jobs,
  runs on a schedule, notifications, Upwork as a source.

## Rules

- Read only. Do not stop, restart, install, update, change or delete anything.
- You may write files only in `~/leadscout-discovery/`.
- Never print a secret: no keys, tokens, passwords, cookies or connection strings with a
  password. Give the variable name and "set" or "not set".
- If you cannot find a fact, write "not found" and where you looked. Do not guess.
- Write the answers to `~/leadscout-discovery/report.md` with the same numbers. Include
  the command and its output where the output is short.

## Part 1: the machine

1. OS version, kernel, CPU model and core count, RAM total and free, swap.
2. `nvidia-smi`: GPU model, VRAM total, used and free, driver and CUDA version. Which
   processes hold VRAM, and how much each?
3. Free disk space on `/`, on the Docker data folder, and on the model cache. Size of
   each.
4. Version of each tool, or "missing": `docker`, `docker compose`, the NVIDIA container
   toolkit, `git`, `uv`, `python3`, `node`, `pnpm`, `npx`, Google Chrome or Chromium (give
   the path), `pdftotext` (poppler-utils), `claude` (Claude Code).
5. Is Claude Code logged in, and with which kind of account (subscription or API key)?
   Do not print tokens.
6. Is there a desktop session with a display (`echo $DISPLAY`, `loginctl`)? Is a person
   logged in after a reboot, or is the machine used without a screen?
7. Load average now, and the top 10 processes by CPU and by RAM.

## Part 2: the model server

8. What serves Qwen: vLLM, Ollama or other? Which version? How is it started (systemd
   unit, container, tmux, script)? Show the exact start command with all flags, with any
   API key hidden.
9. The exact model id and the served model name (`GET /v1/models`). Is it quantized
   (AWQ, GPTQ, GGUF) or full precision? Port, bind address (`127.0.0.1` or `0.0.0.0`),
   and is an API key necessary?
10. The values of `--max-model-len`, `--gpu-memory-utilization`,
    `--enable-auto-tool-choice`, `--tool-call-parser`, the structured-output backend and
    the chat template. Does this model have a thinking mode?
11. Three small test requests to the model (these are allowed). Show the request and the
    result:
    a. `response_format` of type `json_schema` returns JSON that matches the schema.
    b. a request with `tools` returns `tool_calls`.
    c. the time for an answer of about 500 tokens, and tokens per second.
12. Is an embedding model served anywhere (a second vLLM process, Ollama, TEI)? Model and
    port. Is Ollama installed? Output of `ollama list`.
13. With the chat model loaded, how much VRAM is free? Can a second process of about
    1.5 GB (`BAAI/bge-m3`) start?
14. Who calls the model now? For each caller: requests per hour, highest number of
    parallel requests, time per request, timeout. Would 3 to 6 more parallel requests
    from LeadScout make them fail or too slow?

## Part 3: ports and services

15. `ss -ltnp` and `docker ps` with ports. For each of these ports, free or the owner:
    3000, 3010, 3020, 8000, 8001, 8002, 8010, 8020, 5432, 6379, 9333, 11434.
16. Each Postgres, Redis and Langfuse on the machine: where, version, which service owns
    it.
17. The systemd units, cron jobs and Docker Compose projects of the two services. How do
    they start after a reboot?
18. Can a Docker container reach a port on the host (`host.docker.internal` or
    `172.17.0.1`), or does the firewall stop it?

## Part 4: access from another laptop, and applying

19. How is AIJobSearch open at `http://192.168.18.56:3010/`? Which process, which bind
    address, a Docker port or a reverse proxy (nginx, Caddy, Traefik)? Is a login or a
    password in front of it?
20. Is `192.168.18.56` a fixed address (static, or reserved in the router)? Hostname, and
    does a `.local` name work?
21. `ufw status verbose` and other firewall rules. Which ports are open to the home
    network now? Is the machine reachable from the internet (port forward, tunnel,
    Tailscale, Cloudflare)?
22. Two free ports for the LeadScout UI and API that follow the scheme of the machine
    (for example 3020 and 8020).
23. Is `sshd` on? Is a remote desktop on (VNC, RDP, NoMachine, RustDesk)? The applier
    shows the filled form in a Chrome window on this machine, and the owner presses
    Submit in that window. From another laptop, that needs the remote screen.
24. Is the owner logged in to job sites in a Chrome profile on this machine (LinkedIn,
    Indeed, others)? Yes or no for each; no cookies.
25. How does the owner apply with version 1 today: by hand in a browser, on which
    machine? What does version 1 record after an application?

## Part 5: the Upwork notifier

26. Repo path, stack, how it runs, how often.
27. The flow: where the Upwork jobs come from (API, RSS, MCP, scrape), what it asks Qwen
    (prompt and output schema, word for word), what it sends and where (Telegram, email,
    push).
28. Does it store the jobs? Database, tables, columns, row counts.
29. Can another service use the same notification channel? Give the names of the
    settings only.
30. RAM and CPU it uses, and model calls per run.

## Part 6: AIJobSearch version 1

31. Repo path, git remote, date of the last commit, stack, how it runs. List the README
    and each document with its path and one line on its content.
32. Architecture in a short text diagram: services or agents, queue, scheduler, database.
33. Sources: each job site, the method (API, RSS, scrape, browser), the credentials or
    cookies it needs (names only), rate limits, and whether it works today.
34. Extraction: file paths, the prompts word for word, the output schema, model settings,
    validation and retry. How much of it is fixed code and how much is left to the model?
    Known failures.
35. Ranking: how the rank is made (prompt, rubric, weights, embeddings), the prompt word
    for word, which profile or CV data it reads and from where. If stored, 3 jobs with a
    high rank and 3 with a low rank, with the reasons.
36. Which key identifies a job for de-duplication (URL, hash, source id)? Show how it is
    built.
37. Database: engine, location, size. Each table with columns and row count. Two sample
    rows of each main table.
38. **Applied jobs.** Where are they stored? Which fields (company, title, URL, date
    applied, status, CV used, notes, replies)? How many, and from which date to which
    date? Export them to `~/leadscout-discovery/applied-jobs.json` and say which field
    means what.
39. Other data worth keeping: excluded companies, saved searches, keywords, preferences,
    salary data, contact persons, replies from companies. Export what exists to
    `~/leadscout-discovery/`.
40. UI: framework, component library, list of pages. Which functions does it have
    (filters, board view, charts, shortcuts, phone layout)? Take screenshots of each page
    into `~/leadscout-discovery/ui/` if you have a browser tool; if not, list the routes
    and the main component files.
41. Schedules and notifications: how often does it search without a person, and how does
    it tell the owner about new jobs?
42. Problems: what breaks, what is slow, the TODO list, and a summary of the errors in
    the logs of the last 7 days.
43. Paid APIs or services it uses, and the cost per month.

## Part 7: summary

44. A resource table: VRAM, RAM and disk, each with total, used by the two services, and
    free. Is there room for LeadScout (see "What it needs on this machine")?
45. Each port conflict and each risk for the two services that run now.
46. The 10 things in version 1 most worth reuse in LeadScout, with file paths.
47. Your questions for me.
