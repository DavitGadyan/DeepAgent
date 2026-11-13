# Move LeadScout to the Ubuntu machine

How to move LeadScout, with everything it has found, from the Mac to the Ubuntu GPU
machine (`dyada-Titan-18-HX-A14VIG`), next to the Upwork notifier and AIJobSearch.

The values in this file are from the discovery report of 13 November 2026
([ubuntu-discovery.md](ubuntu-discovery.md) has the questions). Check a value again if the
machine changed since then.

## Rules

- Do not stop, restart or change the Upwork notifier, AIJobSearch or the model server
  without the owner's agreement.
- Claude Code never pushes to GitHub. The owner pushes by hand.
- The applier never submits a form. The owner presses Submit.
- Secrets are only in `.env`, which git ignores. Never print them or commit them.
- The app has no login. Open its ports to the home network only, never to the internet.
- LeadScout and AIJobSearch keep separate databases.
- Run the Mac stack or the Ubuntu stack on this data, not the two at the same time.

## What moves

| What | Where it is | How it moves |
|---|---|---|
| Leads, events, runs, settings, agent checkpoints | Postgres | `make backup` → `make restore` |
| Seen postings, queued jobs of a run in progress | Redis | the same archive |
| Your profile | `data/profile/profile.yaml` | the same archive |
| Secrets and settings | `.env` | copy by hand |
| Tailored CVs and cover letters | `$POLISHMYCV_HOME/output` | copy the folder |
| Code | git | the owner pushes, then `git clone` |

A run in progress moves too: the jobs that wait in a queue continue on the Ubuntu machine,
each from its last saved step.

## Part 1: on the Mac

1. Commit the work. The owner pushes it.
2. Stop the agents and the applier (Ctrl+C in the applier's terminal):

   ```bash
   docker compose stop scout filter extractor scorer researcher orchestrator web
   ```

3. Make the archive. It refuses to run while an agent runs.

   ```bash
   make backup            # writes backups/leadscout-<date>-<time>.tar.gz
   ```

4. Copy three things to the Ubuntu machine: the archive, `.env`, and the folder
   `$POLISHMYCV_HOME/output`. With SSH (on Ubuntu first: `sudo systemctl start ssh`; it is
   off there):

   ```bash
   scp backups/leadscout-*.tar.gz .env dyada@192.168.18.56:~/leadscout-move/
   scp -r "$POLISHMYCV_HOME/output" dyada@192.168.18.56:~/leadscout-move/polishmycv-output
   ```

   A USB stick does the same. Do not send `.env` through a chat or a cloud drive.
5. Leave the Mac stack stopped.

## Part 2: on the Ubuntu machine

### 1. Code and tools

All tools are there (Docker with Compose, `git`, `uv`, Node 22, `pnpm`, Chrome, Claude Code
with a login, `pdftotext`).

```bash
git clone <repo> ~/Desktop/DeepAgent && cd ~/Desktop/DeepAgent
make setup
cp ~/leadscout-move/.env .env
```

Put the CV folders into the polishmycv repo of this machine
(`/home/dyada/Desktop/Github/polishmycv`), next to the 5 folders already there. The leads
and the import of step 6 name these folders.

```bash
cp -rn ~/leadscout-move/polishmycv-output/. /home/dyada/Desktop/Github/polishmycv/output/
```

### 2. The model server

vLLM serves Qwen 2.5 7B (`qwen7b`) for the Upwork notifier on `127.0.0.1:8017`. A container
cannot reach that address. Two ways; the first one changes nothing of the notifier.

**A. A forwarder container (recommended).** It listens on the Docker bridge address, which
only containers of this machine reach, and passes connections on to vLLM.

```bash
BRIDGE=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
docker run -d --name leadscout-llm-forward --restart unless-stopped --network host \
  alpine/socat:1.8.0.3 TCP-LISTEN:8018,bind=$BRIDGE,fork,reuseaddr TCP:127.0.0.1:8017
```

**B. Change the vLLM unit** (`vllm-qwen.service`) from `--host 127.0.0.1` to
`--host 0.0.0.0`, and restart it. vLLM then answers the whole network without a key, and
the notifier is down during the restart. The owner decides.

The other needs are met: tool calls are on (`hermes` parser), JSON-schema output works, and
the context is 32768 tokens. Six parallel requests added little delay in the test.

### 3. The embedding model

The filter needs `BAAI/bge-m3`. Run it on the CPU; the GPU has about 3.8 GB free and the
desktop shares it. The image cannot download this model itself (its downloader fails with
"relative URL without a base"), so the model is mounted from a folder. It is already in
`/home/dyada/models/bge-m3` (2.2 GB: the configuration and tokenizer files and the two
files in `onnx/`, downloaded with the `huggingface_hub` package), and this container
already runs:

```bash
BRIDGE=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
docker run -d --name leadscout-embeddings --restart unless-stopped \
  -p "$BRIDGE:8002:80" -v /home/dyada/models/bge-m3:/model:ro \
  ghcr.io/huggingface/text-embeddings-inference:cpu-1.5 \
  --model-id /model --max-client-batch-size 128
```

Measured on this machine: vectors of length 1024, 30 titles in about 0.3 s, 6.2 GB RAM.
The container on port 8001 serves another model (`bge-small`); do not use it: the
filter's thresholds were set with `bge-m3`.

### 4. `.env`

Change these values in the `.env` from the Mac. The address is the one of this machine on
the home network; it is a DHCP lease, so reserve it in the router, or it can change.

```bash
# Models
LLM_PROVIDER=openai
LLM_BASE_URL=http://host.docker.internal:8018/v1
LEADSCOUT_MODEL=qwen7b
LEADSCOUT_NUM_CTX=16384
EMBED_PROVIDER=openai
EMBED_BASE_URL=http://host.docker.internal:8002/v1
FILTER_MODEL=BAAI/bge-m3
# Delete the CPU values of the Mac: LEADSCOUT_TIMEOUT_S, RESEARCHER_TIMEOUT_S,
# and a LEADSCOUT_NUM_CTX of 4096.

# Paths
POLISHMYCV_HOME=/home/dyada/Desktop/Github/polishmycv
CHROME_BIN=/usr/bin/google-chrome

# Ports: 3000 and 8000 are free, but 3010, 8010 and 6379 are in use here.
WEB_PORT=3020
API_PORT=8020
REDIS_PORT=6381

# Use from the other laptop, like AIJobSearch on port 3010
BIND_ADDRESS=0.0.0.0
NEXT_PUBLIC_API_URL=http://192.168.18.56:8020
CORS_ORIGINS=http://192.168.18.56:3020,http://localhost:3020
ALLOWED_HOSTS=localhost,127.0.0.1,orchestrator,192.168.18.56
```

If `ufw` stops the other laptop:
`sudo ufw allow from 192.168.18.0/24 to any port 3020,8020 proto tcp`.

### 5. Load the data, then start

```bash
make restore FILE=~/leadscout-move/leadscout-<date>-<time>.tar.gz
make up
docker compose ps
```

`make restore` replaces what the database and Redis of this machine hold. On a new install
they are empty.

### 6. The applications made with AIJobSearch

The Ubuntu Claude session wrote `~/leadscout-discovery/prior-applications.json` from the
AIJobSearch database (format: `PriorApplication` in [api.md](api.md)): 49 applications, of
which 22 applied, 14 in review, 1 interview, 6 rejected and 6 withdrawn. 36 of them name
the folder of the CV that was sent.

```bash
make prior-applications FILE=~/leadscout-discovery/prior-applications.json
```

Each lead for the same job takes the status (applied, in review, interview, rejected,
skipped) and the CV that was sent. A lead that LeadScout finds later takes them when it is
created. Run the command again after AIJobSearch has new statuses.

### 7. The applier

```bash
make applier-selftest        # once
make applier                 # in a terminal of the desktop session; keep it running
```

The Chrome window with the filled form is on this machine's screen. From the other laptop
you can press **Tailor CV** and download the files, but Submit is possible only at this
screen: SSH and remote desktop are off here. After a reboot, log in to the desktop and
start `make applier` again; the containers start by themselves.

### 8. Open it

`http://192.168.18.56:3020` from the other laptop, `http://localhost:3020` on this machine.
Check the Setup page: sources, keywords, profile, Claude Code access, budgets.

## Checks

- [ ] `docker compose ps`: no container restarts in a loop.
- [ ] The Leads page shows the leads from the Mac, with their scores.
- [ ] The Pipeline page shows the run from the Mac, and the jobs that waited continue.
- [ ] One job goes through Filter, Extractor, Scorer and Researcher.
- [ ] A lead you applied to with AIJobSearch shows its status and its CV.
- [ ] **Stop run** stops a run in progress.
- [ ] `make applier-selftest` passes.
- [ ] The Upwork notifier still works, at its usual speed.

## What was tested, and what was not

Tested on the Mac, with a copy of the real data in a separate test stack:

- `make backup` and `make restore`, also into an empty stack: 351 leads, the events, 6 runs,
  514 checkpoints and the 293 queued jobs of the run in progress came back the same.
- The import of prior applications: the status and the PDF files of a matching lead.

Tested on the Ubuntu machine by its Claude session (13 November 2026):

- The forwarder container: a container reads the model list of vLLM through it, and the
  port does not answer on the network address.
- The embedding container: the reply has the fields LeadScout reads, and the port does not
  answer on the network address.

Not tested yet:

- vLLM and the GPU with LeadScout. The OpenAI-compatible path was tested against Ollama.
  On this vLLM, Qwen wrote a number without end in JSON output when the prompt did not
  describe the fields. LeadScout's prompts describe them. If an agent fails with a timeout
  on one job, look for this first.
- The applier on Linux.
