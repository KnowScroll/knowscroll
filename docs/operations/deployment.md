# Deploying, backing up and rolling back

Owner-run, on this Mac, from the main checkout. [ADR-0047](../decisions/0047-release-readiness-before-owner-inputs.md)
decides the rules: migrations are forward-only, every migrate is preceded by a verified backup, and
rollback means restoring that backup. The owner inputs a release needs are in
[release-inputs.md](release-inputs.md).

## What runs where

| Part | Where | Start | Stop |
|---|---|---|---|
| PostgreSQL 16 cluster | `$KS_DEV_ROOT/postgres`, `127.0.0.1:55432`, database `knowscroll`, role `knowscroll` | `./scripts/db-start.sh` | `./scripts/db-stop.sh` |
| API | `127.0.0.1:4310` (`PORT`) | `pnpm dev:api` | Ctrl-C, or `kill -TERM "$(lsof -nP -iTCP:4310 -sTCP:LISTEN -t)"` |
| Worker | no port | `pnpm dev:worker` | Ctrl-C, or `kill -TERM <pid>` from its first log line, `"workerId":"local-<pid>"` |

The API listens on loopback only and refuses `NODE_ENV=production` (`apps/api/src/main.ts`), so it
runs in development mode on this machine. A release phone reaches it only through the HTTPS address
named by `KS_RELEASE_API_BASE`; nothing in this repository provides that endpoint.

Every command below starts in a shell prepared like this. The password is the cluster's own, written
by `scripts/dev-init.sh`; it is never printed.

```sh
cd "/Volumes/Mrigesh SSD/knowscroll-product"
. ./scripts/env.sh
export PGHOST=127.0.0.1 PGPORT=55432 PGUSER=knowscroll
export PGPASSWORD="$(cat "$KS_DEV_ROOT/postgres-password")"
```

## Upgrade

1. **Stop the worker, then the API**, and any other process using the database (the generation
   worker, reasoning maintenance, an operator CLI). Nothing may write after the backup. Check that
   nothing is left: `lsof -nP -iTCP:4310 -sTCP:LISTEN` prints nothing, and
   `psql -d postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE datname='knowscroll'"` prints `0`.
2. **Back up to the SSD.**
   ```sh
   umask 077
   mkdir -p "$KS_DEV_ROOT/backups"
   backup="$KS_DEV_ROOT/backups/knowscroll-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD).dump"
   pg_dump --dbname=knowscroll --format=custom --file="$backup"
   ```
   The name carries the commit that wrote the data; that is the commit a rollback returns to.
3. **Verify the backup.** Migrate only after this prints `backup verified`.
   ```sh
   pg_restore --list "$backup" > "$backup.list"
   tables=$(psql -d knowscroll -tAc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
   dumped=$(grep -c ' TABLE DATA public ' "$backup.list")
   [ "$tables" = "$dumped" ] && echo "backup verified: $dumped of $tables tables" || echo "BACKUP INCOMPLETE: do not migrate"
   ```
4. **Take the new code.** `git pull --ff-only origin main`, then `pnpm install --frozen-lockfile`.
5. **Migrate.** `pnpm db:migrate` prints one `Applied <file>` line per new migration. It applies
   all of them in one transaction: if it fails, nothing was applied and the database is exactly
   what the backup holds. Return to the old code with `git switch --detach <commit from the backup's name>` and
   `pnpm install --frozen-lockfile`, and start it; no restore is needed.
6. **Start the API, then the worker** in two terminals, each prepared as above: `pnpm dev:api`,
   `pnpm dev:worker`.
7. **Check health** (below). Then delete older backups (see "Backups are personal data").

To rehearse a migration first, `pnpm exec tsx scripts/prove-owner-upgrade.ts --run` reads the owner
database once with `pg_dump`, migrates a disposable clone, reads it through the API and drops it.

## Rollback: restore the backup

There are no down migrations. Roll back only when the migrated release is wrong and cannot be fixed
forward. **Everything written after the backup is lost** — reading, keeps, Asks, sign-ins — **and a
Clear, Reset or account deletion made after the backup is undone**: the restored database holds that
history again. Repeat such an action after the restore.

```sh
# 1. Stop the worker and the API, as in step 1 above.
# 2. Restore into a new database and check it.
backup="$KS_DEV_ROOT/backups/<the verified backup>.dump"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
createdb "knowscroll_restore_$stamp"
pg_restore --exit-on-error --dbname="knowscroll_restore_$stamp" "$backup"
psql -d "knowscroll_restore_$stamp" -tAc "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1"
# 3. Swap the names. The failed database is kept until the restore is checked.
psql -d postgres -c "ALTER DATABASE knowscroll RENAME TO knowscroll_failed_$stamp"
psql -d postgres -c "ALTER DATABASE knowscroll_restore_$stamp RENAME TO knowscroll"
# 4. The code that wrote the backup, then start and check health.
git switch --detach <commit from the backup's name>
pnpm install --frozen-lockfile
```

The last migration printed in step 2 must be the old release's newest migration file. A rename fails
while anything is connected to either database; stop it first. Once health checks pass, drop the
failed database, which holds personal data: `dropdb "knowscroll_failed_$stamp"`. Return to `main`
with `git switch main` when a fixed release is ready, and upgrade as above.

## Backups are personal data

A backup holds everything the database held when it was taken, including history the owner later
clears, resets or deletes; those controls do not reach a backup (ADR-0035 §6). Backups stay in
`$KS_DEV_ROOT/backups` on the SSD, mode 0600 in a 0700 directory, never in Git, evidence, a synced
folder or a message. Keep the latest verified pre-migration backup; once an upgrade is verified,
delete the older ones: `rm "$KS_DEV_ROOT/backups/<older>.dump" "$KS_DEV_ROOT/backups/<older>.dump.list"`.

## Environment

Names only; values live in the shell or the ignored `.env` at the checkout root, which the database
module loads for any name the shell leaves unset. Never commit them or print them.

| Process | Name | Required | Purpose |
|---|---|---|---|
| API, worker | `DATABASE_URL` | yes | The owner database, `…@127.0.0.1:55432/knowscroll` |
| API | `KS_DEV_TOKEN` | yes, 24+ characters | Enrols the development session at start (ADR-0009); refused in production |
| API | `PORT` | no, default 4310 | Listening port on 127.0.0.1 |
| API | `KS_OWNER_EMAIL` | for sign-in | The one owner address (ADR-0026) |
| API | `KS_MAIL_SENDER` | no, default `dev-sink` | `agentmail` sends real mail ([magic-link-delivery.md](magic-link-delivery.md)) |
| API | `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` | with `agentmail` | The inbox credential and id (ADR-0027) |
| API | `KS_WEB_ORIGIN` | for web and App Link sign-in | Mailed links are `<origin>/sign-in#token=…` (ADR-0034) |
| API | `KS_CSRF_SECRET` | no; random per process otherwise | 32+ bytes; without it, each start derives new web CSRF tokens (ADR-0034) |
| API | `KS_API_BASE_URL` | no | Base of the mailed confirm link when `KS_WEB_ORIGIN` is unset |
| API | `KS_DEV_ROOT`, `KS_MEDIA_ROOT` | for the dev sink and media | Set by `scripts/env.sh`; media defaults to `$KS_DEV_ROOT/media` |
| Worker | `KS_ANSWER_TRANSPORT`, `KS_INQUIRY_TRANSPORT` | no; unset turns answers and inquiries off | `minimax` only with the owner's authorization (ADR-0033/0038) |
| Worker | `MINIMAX_API_KEY` | with `minimax` | Read by the worker only; never by the API |
| Worker | `KS_ANSWER_LEASE_MS`, `KS_INQUIRY_LEASE_MS`, `KS_CORRECTION_REFRESH_INTERVAL_MS`, `KS_CORRECTION_REFRESH_BATCH` | no | Bounded defaults: 60 s leases, a 60 s correction pass of 8 |

`*_FIXTURE_MODE`, `AGENTMAIL_BASE_URL` and `AGENTMAIL_TIMEOUT_MS` exist for tests and stay unset.

## Health checks

- `curl -fsS http://127.0.0.1:4310/health` prints `{"status":"ok","database":true}`.
- `pnpm state` prints `"api": true`, a worker with `"recently_seen": true`, the newest migration
  file as the last `migrations` entry (compare `git ls-files 'packages/db/migrations/*.sql' | tail -1`), and
  no growing `pending` or `failed` job count.
- On the phone: the app opens signed in, the Universe shows its Traces, and a saved Trace reopens.
