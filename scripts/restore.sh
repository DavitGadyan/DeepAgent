#!/usr/bin/env bash
# Loads an archive made by scripts/backup.sh into this machine's LeadScout. What the
# database and Redis hold now is replaced. Usage: scripts/restore.sh backups/<file>.tar.gz
set -euo pipefail
archive="$(cd "$(dirname "${1:?Usage: scripts/restore.sh <archive>}")" && pwd)/$(basename "$1")"
cd "$(dirname "$0")/.."
. scripts/stack.sh

refuse_while_agents_run
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -C "$work" -xzf "$archive"

start_postgres
docker compose exec -T postgres sh -c \
  'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' \
  < "$work/postgres.dump"

# Redis reads its files only when it starts, so they are replaced while it is stopped.
docker compose stop redis
docker compose run --rm --no-deps -T --entrypoint sh redis \
  -c 'rm -rf /data/* && tar -C /data -xf -' < "$work/redis-data.tar"
docker compose up -d --wait redis

mkdir -p data/profile
cp "$work/profile.yaml" data/profile/profile.yaml
echo "Restored $archive. Start the agents with: make up"
