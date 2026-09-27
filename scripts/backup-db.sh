#!/usr/bin/env bash
set -euo pipefail

# pg_dump wrapper for the self-hosted fallback path (D-09). Not wired into any
# cron job or CI workflow — scheduling is an explicit deploy-time decision left
# out of scope here. See docs/database-backup-and-disaster-recovery.md.

: "${DATABASE_URL:?Set DATABASE_URL to the target Postgres connection string}"

command -v pg_dump >/dev/null 2>&1 || { echo "scripts/backup-db.sh: pg_dump not found. Install postgresql-client (apt) or the Supabase CLI." >&2; exit 1; }

cd "$(dirname "$0")/.."

mkdir -p backups

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
out="backups/backup-${timestamp}.dump"

pg_dump "$DATABASE_URL" --format=custom --file="$out"

echo "$out"
