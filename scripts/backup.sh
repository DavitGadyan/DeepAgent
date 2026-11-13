#!/usr/bin/env bash
# Saves everything LeadScout has found and queued into one archive in backups/:
# the database (leads, events, runs, settings, agent checkpoints), the Redis data
# (seen postings, queued jobs) and your profile. Restore it with scripts/restore.sh.
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/stack.sh

refuse_while_agents_run
start_postgres
docker compose up -d --wait redis

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' \
  > "$work/postgres.dump"
docker compose exec -T redis redis-cli save > /dev/null
docker compose exec -T redis tar -C /data -cf - . > "$work/redis-data.tar"
cp data/profile/profile.yaml "$work/profile.yaml"

mkdir -p backups
archive="backups/leadscout-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -C "$work" -czf "$archive" postgres.dump redis-data.tar profile.yaml
echo "Saved $archive ($(du -h "$archive" | cut -f1))"
