.DEFAULT_GOAL := help
COMPOSE := docker compose
# Models `make models` pulls. Override for a CPU machine: make models CHAT_MODEL=qwen2.5:7b
CHAT_MODEL ?= qwen3:14b
EMBED_MODEL ?= bge-m3
# Load .env for targets that run on the host (values with spaces must be quoted in .env).
LOAD_ENV := set -a && . ./.env && set +a

help: ## Show this list
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

setup: ## First-time setup: .env, profile file, git hook, Python and web dependencies
	@test -f .env || cp .env.example .env
	@test -f data/profile/profile.yaml || cp data/profile/profile.example.yaml data/profile/profile.yaml
	git config core.hooksPath .githooks
	uv sync --all-packages --all-extras
	cd web && pnpm install

up: ## Build and start every container
	@$(LOAD_ENV) && mkdir -p "$$POLISHMYCV_HOME/output"  # owned by you, not created by Docker as root
	$(COMPOSE) up -d --build

down: ## Stop the containers (data is kept)
	$(COMPOSE) down

logs: ## Follow the logs of all agents
	$(COMPOSE) logs -f --tail=50

applier: ## Run the applier worker on this machine (needs Claude Code and Chrome)
	$(LOAD_ENV) && REDIS_URL=redis://localhost:6379/0 uv run python -m applier_service.main

applier-selftest: ## Check the form-filling agent on a local dummy form (uses Claude Code)
	$(LOAD_ENV) && uv run python -m applier_service.selftest

models: ## Pull the models into the bundled Ollama container if it runs, else the local Ollama
	@if $(COMPOSE) ps -q ollama 2>/dev/null | grep -q .; then \
	  $(COMPOSE) exec ollama ollama pull $(CHAT_MODEL) && $(COMPOSE) exec ollama ollama pull $(EMBED_MODEL); \
	else \
	  ollama pull $(CHAT_MODEL) && ollama pull $(EMBED_MODEL); \
	fi

test: ## Unit tests (no network, no model)
	uv run pytest -q
	cd web && pnpm test

evals: ## Model evals against the Ollama in .env (slow on CPU)
	$(LOAD_ENV) && export OLLAMA_BASE_URL="$$(printf %s "$$OLLAMA_BASE_URL" | sed 's/host\.docker\.internal/localhost/')" \
	  PROFILE_CV_PATH="$$POLISHMYCV_HOME/docs/$${PROFILE_CV_RELPATH:-cv/David_Gadyan_Resume.txt}" \
	  PROFILE_CATALOGUE_PATH="$$POLISHMYCV_HOME/docs/$${PROFILE_CATALOGUE_RELPATH:-portfolio-catalogue.json}" \
	  PROFILE_PREFS_PATH=data/profile/profile.yaml \
	  && uv run pytest -q -m eval -s

lint: ## Lint and format checks
	uv run ruff check . && uv run ruff format --check .
	cd web && pnpm lint && pnpm typecheck

.PHONY: help setup up down logs applier applier-selftest models test evals lint
