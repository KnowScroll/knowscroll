#!/bin/bash
# Weekly restore check (#228, docs/v2/operations/backups.md) — installed by ops/vps/ansible as
# /usr/local/lib/knowscroll-ops/ks-restore-check and run as root by ks-restore-check.service:
#
#   ks-restore-check <database>...
#
# For each database, the newest nightly dump in /srv/knowscroll/backups/<database>/ is restored
# into the scratch database knowscroll_restore_check (dropped before and after; no other database
# is touched), then checked: every table the dump's table of contents names exists, and the
# migration table (KS_MIGRATION_TABLE, default kysely_migration) is counted when there is one. The
# result goes to /srv/knowscroll/backups/restore-check.json; the unit fails if any check fails.
set -euo pipefail
umask 077

root=${KS_BACKUP_ROOT:-/srv/knowscroll/backups}
scratch_db=knowscroll_restore_check
migration_table=${KS_MIGRATION_TABLE:-kysely_migration}
[ "$#" -gt 0 ] || { echo "usage: ks-restore-check <database>..." >&2; exit 2; }
[[ "$migration_table" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "bad KS_MIGRATION_TABLE" >&2; exit 2; }

install -d -m 0700 -o root -g root "$root"
exec 9>"$root/.lock"
flock -n 9 || { echo '{"event":"restore-check-skipped","reason":"a backup or restore check is running"}'; exit 1; }

# The dump is root-only; postgres reads a private copy in this unit's own /tmp.
work=$(mktemp -d)
chown postgres:postgres "$work"
as_postgres() { runuser -u postgres -- "$@"; }
psql_scratch() { as_postgres psql -X -A -t -v ON_ERROR_STOP=1 -d "$scratch_db" -c "$1"; }
drop_scratch() { as_postgres dropdb --if-exists "$scratch_db"; }
trap 'drop_scratch || true; rm -rf "$work"' EXIT

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
failed=0
results=()

for db in "$@"; do
  t0=$(date +%s)
  ok=false
  reason=""
  dump=""
  expected=0
  tables=0
  migrations=null
  latest=""
  if [[ ! "$db" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    reason="refused database name"
  else
    dump=$(find "$root/$db" -maxdepth 1 -type f -name '????-??-??.dump' -printf '%f\n' 2>/dev/null | sort | tail -n 1)
    if [ -z "$dump" ]; then
      reason="no nightly dump to restore"
    else
      install -m 0600 -o postgres -g postgres "$root/$db/$dump" "$work/check.dump"
      # Tables the dump says it holds (not their data entries).
      expected=$(pg_restore --list "$work/check.dump" | grep -E '^[0-9]+; [0-9]+ [0-9]+ TABLE ' | grep -vcE ' TABLE (DATA|ATTACH) ' || true)
      if ! drop_scratch || ! as_postgres createdb "$scratch_db"; then
        reason="the scratch database could not be made"
      elif ! as_postgres pg_restore --dbname="$scratch_db" --no-owner --no-privileges --exit-on-error "$work/check.dump"; then
        reason="pg_restore failed"
      else
        # Tables and partitioned tables outside the system schemas, not counting tables an
        # extension creates for itself (pg_dump leaves those to CREATE EXTENSION).
        tables=$(psql_scratch "SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')") || tables=-1
        schema=$(psql_scratch "SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = '$migration_table' AND c.relkind = 'r' ORDER BY n.nspname LIMIT 1") || schema=""
        if [ -n "$schema" ]; then
          migrations=$(psql_scratch "SELECT count(*) FROM \"$schema\".\"$migration_table\"") || migrations=null
          latest=$(psql_scratch "SELECT coalesce(max(name), '') FROM \"$schema\".\"$migration_table\"") || latest=""
        fi
        if [ "$tables" -eq "$expected" ]; then
          ok=true
        else
          reason="restored $tables tables, the dump names $expected"
        fi
      fi
      rm -f "$work/check.dump"
      drop_scratch || true
    fi
  fi
  [ "$ok" = true ] || failed=1
  result=$(jq -cn \
    --arg database "$db" --arg dump "$dump" --argjson ok "$ok" \
    --argjson tables "$tables" --argjson expectedTables "$expected" \
    --argjson migrations "$migrations" --arg latestMigration "$latest" \
    --argjson seconds "$(( $(date +%s) - t0 ))" --arg reason "$reason" \
    '{database: $database, dump: (if $dump == "" then null else $dump end), ok: $ok, tables: $tables,
      expectedTables: $expectedTables, migrations: $migrations,
      latestMigration: (if $latestMigration == "" then null else $latestMigration end),
      seconds: $seconds, reason: (if $reason == "" then null else $reason end)}')
  echo "$result"
  results+=("$result")
done

status_ok=true
[ "$failed" -eq 0 ] || status_ok=false
printf '%s\n' "${results[@]}" | jq -s \
  --arg started "$started" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson ok "$status_ok" \
  '{kind: "weekly-restore-check", started: $started, finished: $finished, ok: $ok, databases: .}' \
  > "$root/.restore-check.json.next"
mv -f "$root/.restore-check.json.next" "$root/restore-check.json"
exit "$failed"
