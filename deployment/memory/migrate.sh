#!/usr/bin/env bash
# Apply Memory Authority schema migrations with an explicitly supplied DDL role.
# This is intentionally separate from routine binary releases so the runtime
# service account does not need schema-changing database privileges.
set -euo pipefail

: "${ZERO3_MEMORY_MIGRATION_DATABASE_URL:?set ZERO3_MEMORY_MIGRATION_DATABASE_URL}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v psql >/dev/null || { echo 'psql is required' >&2; exit 1; }

shopt -s nullglob
migrations=("$repo_root"/deployment/memory/migrations/*.sql)
if [[ ${#migrations[@]} -eq 0 ]]; then
  echo 'No Memory Authority migrations found.' >&2
  exit 1
fi

for migration in "${migrations[@]}"; do
  echo "Applying $(basename "$migration")"
  psql "$ZERO3_MEMORY_MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$migration"
done

echo 'ZERO3_MEMORY_MIGRATIONS=PASS'
