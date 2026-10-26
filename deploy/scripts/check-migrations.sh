#!/usr/bin/env bash
# Block destructive Supabase migrations from reaching review-merged main.
#
# A schema migration against the live database cannot be undone by reverting a
# commit, so this gate inspects only the migrations a pull request actually
# touched and fails on statements that drop or truncate data. A migration that
# genuinely needs such a statement opts in with an explicit marker line so the
# choice is visible in the file and in review, never accidental.
#
# Usage: check-migrations.sh <base-sha>
set -euo pipefail

base="${1:-}"
migrations_dir="supabase/migrations"

if [ -z "$base" ]; then
  echo "migration-lint: no base revision supplied, skipping diff-based check."
  exit 0
fi

if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  # Shallow clones or force-pushed branches can drop the base object. Fall back
  # to scanning every migration so the gate never silently disappears.
  echo "migration-lint: base ${base} unavailable, scanning all migrations."
  changed=$(find "$migrations_dir" -name '*.sql' 2>/dev/null || true)
else
  changed=$(git diff --name-only "${base}" HEAD -- "$migrations_dir" || true)
fi

if [ -z "$changed" ]; then
  echo "migration-lint: no migration files changed."
  exit 0
fi

# Only statements that actually lose rows are blocked. Dropping a constraint or
# an index is reversible and routine (widening a CHECK, rebuilding an index), so
# it is deliberately not in this set, and would only produce false alarms.
pattern='DROP[[:space:]]+(TABLE|COLUMN|SCHEMA|DATABASE)[[:space:]]|DROP[[:space:]]+(TABLE|COLUMN|SCHEMA|DATABASE)$|TRUNCATE[[:space:]]'
failures=0

for file in $changed; do
  [ -f "$file" ] || continue
  # An explicit opt-in marker whitelists the whole file, with its reason on the
  # same line so the justification is auditable.
  if grep -qE '^[[:space:]]*--[[:space:]]*ALLOW-DESTRUCTIVE:' "$file"; then
    echo "migration-lint: ${file} carries an ALLOW-DESTRUCTIVE marker, permitting."
    continue
  fi
  hits=$(grep -nEi "$pattern" "$file" || true)
  if [ -n "$hits" ]; then
    echo "migration-lint: ${file} contains destructive statements:"
    echo "$hits"
    failures=$((failures + 1))
  fi
done

if [ "$failures" -gt 0 ]; then
  echo ""
  echo "migration-lint: ${failures} migration(s) drop tables, columns, schemas or truncate."
  echo "Prefer an additive change plus a backfill, or add a line reading"
  echo "'-- ALLOW-DESTRUCTIVE: <reason>' once the data loss is approved."
  exit 1
fi

echo "migration-lint: all changed migrations are additive."
