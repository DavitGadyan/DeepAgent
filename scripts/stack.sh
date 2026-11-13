# Shared by backup.sh and restore.sh.

# The containers that write to the database and to Redis.
WRITERS="scout filter extractor scorer researcher orchestrator web"

# A copy taken or replaced while an agent writes would be inconsistent.
refuse_while_agents_run() {
  local running
  running="$(docker compose ps --status running --services | grep -Fxf <(tr ' ' '\n' <<< "$WRITERS") || true)"
  if [ -n "$running" ]; then
    echo "Stop the agents first: docker compose stop $WRITERS" >&2
    echo "Also stop the applier (Ctrl+C in its terminal)." >&2
    exit 1
  fi
}

# On its first start the Postgres container answers on its socket while it still sets
# itself up, then restarts. It answers on its network address only when it is ready.
start_postgres() {
  docker compose up -d --wait postgres
  until docker compose exec -T postgres sh -c 'pg_isready -q -h "$(hostname)" -U "$POSTGRES_USER"'; do
    sleep 1
  done
}
