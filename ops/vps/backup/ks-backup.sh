#!/bin/bash
# Nightly database backups (#228, docs/v2/operations/backups.md) — installed by ops/vps/ansible as
# /usr/local/lib/knowscroll-ops/ks-backup and run as root by ks-backup.service:
#
#   ks-backup <database>...
#
# Each database is dumped by pg_dump -Fc (as postgres, over the local socket) into
# /srv/knowscroll/backups/<database>/<UTC date>.dump; folders 0700 and files 0600, owned by root,
# because a dump is personal data. A dump counts only once pg_restore can read its table of
# contents. Dumps older than KS_BACKUP_KEEP_DAYS (14) are removed, never the newest one. The result
# is written to /srv/knowscroll/backups/status.json and one JSON line per database to the journal;
# the unit fails if any database could not be dumped.
set -euo pipefail
umask 077

root=${KS_BACKUP_ROOT:-/srv/knowscroll/backups}
keep_days=${KS_BACKUP_KEEP_DAYS:-14}
[ "$#" -gt 0 ] || { echo "usage: ks-backup <database>..." >&2; exit 2; }
[[ "$keep_days" =~ ^[1-9][0-9]*$ ]] || { echo "KS_BACKUP_KEEP_DAYS must be a positive number" >&2; exit 2; }

install -d -m 0700 -o root -g root "$root"
# One backup or restore check at a time.
exec 9>"$root/.lock"
flock -n 9 || { echo '{"event":"backup-skipped","reason":"another backup or restore check is running"}'; exit 1; }

started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
today=$(date -u +%F)
# Keep today and the keep_days - 1 days before it.
cutoff=$(date -u -d "$((keep_days - 1)) days ago" +%F)
failed=0
results=()

for db in "$@"; do
  if [[ ! "$db" =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "refusing database name $db" >&2
    failed=1
    continue
  fi
  dir=$root/$db
  install -d -m 0700 -o root -g root "$dir"
  partial=$dir/.$today.dump.partial
  dump=$dir/$today.dump
  t0=$(date +%s)
  ok=false
  bytes=0
  reason=""
  if ! runuser -u postgres -- pg_dump --format=custom --dbname="$db" > "$partial"; then
    reason="pg_dump failed"
  elif ! pg_restore --list "$partial" > /dev/null; then
    reason="the dump's table of contents cannot be read"
  else
    mv -f "$partial" "$dump"
    ok=true
    bytes=$(stat -c %s "$dump")
  fi
  rm -f "$partial"
  [ "$ok" = true ] || failed=1

  # Retention by the date in the name; the newest dump always stays, even if it is old.
  deleted=0
  newest=$(find "$dir" -maxdepth 1 -type f -name '????-??-??.dump' -printf '%f\n' | sort | tail -n 1)
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if [[ "${name%.dump}" < "$cutoff" && "$name" != "$newest" ]]; then
      rm -f -- "${dir:?}/$name"
      deleted=$((deleted + 1))
    fi
  done < <(find "$dir" -maxdepth 1 -type f -name '????-??-??.dump' -printf '%f\n')
  kept=$(find "$dir" -maxdepth 1 -type f -name '????-??-??.dump' | wc -l)

  result=$(jq -cn \
    --arg database "$db" --argjson ok "$ok" --arg file "$([ "$ok" = true ] && echo "$today.dump" || echo "")" \
    --argjson bytes "$bytes" --argjson seconds "$(( $(date +%s) - t0 ))" \
    --argjson kept "$kept" --argjson deleted "$deleted" --arg reason "$reason" \
    '{database: $database, ok: $ok, file: (if $file == "" then null else $file end), bytes: $bytes,
      seconds: $seconds, kept: $kept, deleted: $deleted, reason: (if $reason == "" then null else $reason end)}')
  echo "$result"
  results+=("$result")
done

status_ok=true
[ "$failed" -eq 0 ] || status_ok=false
printf '%s\n' "${results[@]}" | jq -s \
  --arg started "$started" --arg finished "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson ok "$status_ok" --argjson keepDays "$keep_days" \
  '{kind: "nightly-backup", started: $started, finished: $finished, ok: $ok, keepDays: $keepDays, databases: .}' \
  > "$root/.status.json.next"
mv -f "$root/.status.json.next" "$root/status.json"
exit "$failed"
