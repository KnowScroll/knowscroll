# v2 database backups, restores and rollback

> **Status: implemented, not yet applied to the server** (#228 part 1). Until the coordinator
> applies Ansible there are no backups on the VPS at all (as before #228).

Backups are personal data. They stay root-only on the server and on the external SSD, never in Git,
an issue, a log or a report. Never print a dump, an env file or a `DATABASE_URL`.

## What runs

| | Nightly backup | Weekly restore check |
|---|---|---|
| Unit / timer | `ks-backup.service` / `ks-backup.timer`, 02:15 UTC (±10 min, catches up after downtime) | `ks-restore-check.service` / `.timer`, Sunday 04:15 UTC |
| Script | `/usr/local/lib/knowscroll-ops/ks-backup` (`ops/vps/backup/ks-backup.sh`) | `…/ks-restore-check` (`ops/vps/backup/ks-restore-check.sh`) |
| Databases | `knowscroll_v2_dev`, `knowscroll_v2_stage`, `knowscroll_pool` | the same |
| Result | `/srv/knowscroll/backups/status.json` | `/srv/knowscroll/backups/restore-check.json` |

The list follows `ks_v2_worlds` in `ops/vps/ansible/group_vars/all.yml` plus the shared pool. The v1
databases `knowscroll_test_dev|stage` are not backed up (dev and stage are disposable by design; that
is unchanged).

**Nightly:** each database is dumped with `pg_dump --format=custom` as `postgres` into
`/srv/knowscroll/backups/<database>/<UTC date>.dump` (folders 0700, files 0600, root). A dump is kept
only if `pg_restore --list` can read it; a failed dump never replaces a good one. Dumps older than
14 days (`ks_backup_keep_days`) are deleted by the date in their name, **never the newest one**, so
two weeks of failures still leave the last good dump. The unit fails if any database could not be
dumped. It holds the deploy lock while it dumps, so a nightly dump and a migration never meet. The
disk guard and `ks cleanup` never touch this folder.

**Before every v2 migrate:** `ks deploy`/`promote` dumps the world's v2 database the same way into
`/srv/knowscroll/backups/knowscroll_v2_<world>/pre-deploy-<UTC time>-<commit12>.dump` (0600, root)
and checks it with `pg_restore --list`; if that fails, nothing is migrated. `releases.log` names the
dump of each v2 deploy. The nightly job ages these files the same way (14 days, never the newest).
They are what "roll a migration back" means (runbook below).

**Weekly:** for each database, the newest nightly dump is restored into the scratch database
`knowscroll_restore_check` and checked. It passes when every table the dump lists exists after the
restore; it also counts the migration table (`kysely_migration`, or `KS_MIGRATION_TABLE`) and
records the latest migration name. An empty database (before the first v2 deploy) passes with zero
tables. The unit fails if any check fails.

A dump holds whatever a world's own role put in its database, so the check gives it no more rights
than that (#228 review M1):

- The restore and every query run as the role **`ks_restore_check`**: no superuser, no createdb or
  createrole, no password (so no network login), logging in only over the local socket by peer
  authentication as the OS user of the same name. It owns the scratch database and nothing else;
  restored objects belong to it (`--no-owner --no-privileges`), and it cannot connect to any other
  KnowScroll database (they all revoke `CONNECT` from `PUBLIC`).
- `postgres` only drops and creates the scratch database, with fixed statements: it is created with
  connections off, `CONNECT` and `TEMPORARY` are revoked from `PUBLIC`, then connections are allowed,
  so no other role can ever connect to it.
- Nothing read from a dump or a catalog is pasted into SQL: queries come on stdin, names go in as
  psql variables (`:'literal'`, `:"identifier"`), and a schema name must match `^[a-z_][a-z0-9_]*$`
  or it is not read. `ops/vps/backup/scripts.test.ts` holds the script to these rules in CI.
- A dump that needs a superuser to restore (an untrusted extension, for instance) fails the check;
  that is reported, never worked around.

So no other database is touched, and no SQL from a dump runs with superuser rights.

One backup or restore check runs at a time (`flock` on `/srv/knowscroll/backups/.lock`).

## Checking on them

```sh
ssh knowscroll-vps ks status                       # "backups": nightly and restoreCheck results
ssh knowscroll-vps systemctl list-timers 'ks-*'
ssh knowscroll-vps journalctl -u ks-backup.service -u ks-restore-check.service --since -2d
```

Run one now (as root on the server), e.g. **before a risky migration**:

```sh
systemctl start ks-backup.service          # waits until the dumps are written
systemctl start ks-restore-check.service
```

## Copy to the Mac

```sh
ops/vps/pull-backups.sh   # → $KS_DEV_ROOT/backups/vps/ (default /Volumes/Mrigesh SSD/knowscroll-dev/backups/vps/)
```

It uses the agent key (`ssh knowscroll-vps`), keeps the server's 0700/0600 modes, skips the lock and
half-written files, and never deletes on the Mac (prune old copies by hand).

## Restore a v2 world's database (runbook)

Use this when a v2 migration or a bug damaged `knowscroll_v2_<world>`. It undoes everything written
after the dump, including Clear, Reset and account deletions made since then (CF-27): re-apply those
afterwards. Only on dev or stage; the shared pool is the money record and is never restored without
the owner (restore it into a scratch database to read it instead).

As root on the server, with `w=dev` (or `stage`) and `d=/srv/knowscroll/backups/knowscroll_v2_$w/<date>.dump`:

1. Look first: `ks status` (current/previous release and generation, health, last backup).
2. Hold deploys and stop the world's v2 processes:
   `exec 9>>/run/knowscroll/deploy.lock && flock 9` (keep this shell open), then
   `systemctl stop ks2-world@$w.target`.
3. Keep the damaged database for inspection:
   `runuser -u postgres -- psql -X -c "ALTER DATABASE knowscroll_v2_$w RENAME TO knowscroll_v2_${w}_damaged_$(date -u +%Y%m%d)"`.
4. Recreate it empty, owned by the world's v2 role, with the same access rules:
   `runuser -u postgres -- createdb -O ks2_$w knowscroll_v2_$w` and
   `runuser -u postgres -- psql -X -c "REVOKE CONNECT ON DATABASE knowscroll_v2_$w FROM PUBLIC; GRANT CONNECT ON DATABASE knowscroll_v2_$w TO ks2_$w"`.
5. Restore the dump (objects keep their owner `ks2_$w`):
   `t=$(mktemp -d) && chown postgres "$t" && install -m 0600 -o postgres "$d" "$t/r.dump"`,
   `runuser -u postgres -- pg_restore --exit-on-error -d knowscroll_v2_$w "$t/r.dump"`, `rm -rf "$t"`.
   **Caution:** this restore runs as the superuser, so anything the dump defines that runs during a
   restore (expression-index functions, defaults) runs with the owner's or superuser's rights. Only
   restore a dump you have reason to trust (a pre-deploy or nightly dump of a world whose code you
   know), and run the weekly-style restore check on it first if in doubt.
6. Put the code back that matches the dump's schema. If the dump is from before the current
   release's migrations, roll back the release (step 7 with `ks rollback`); otherwise restart it.
7. Close the lock shell from step 2, then either `ks rollback $w` (it takes the lock itself) or
   `systemctl start ks2-world@$w.target`.
8. Check: `ks status` shows the world healthy, and `/health`'s `migration` is the dump's latest
   migration (the restore check records it). Drop the `_damaged_` copy once it is no longer needed.

## Roll back a v2 deploy (code, then data)

- A deploy that does not become healthy within 90 s is rolled back automatically to the release
  before it, in whichever generation that was, with `current` and `previous` exactly as they were
  ([environments.md](environments.md)).
- By hand: `ks rollback <world>` (it takes the deploy lock) swaps `current` and `previous`, verifies
  a v2 release again, and starts that release's generation; if it does not become healthy, the links
  and what ran before are put back.
- Migrations are never reversed automatically. **Rolling back a v2 migration = restoring the
  pre-migrate dump of that deploy** (`releases.log` names it: `predeployDump`) with the runbook
  above, `d=…/knowscroll_v2_$w/pre-deploy-<time>-<commit12>.dump`, then `ks rollback` to the release
  that matches it.
- Back to v1: `ks rollback` while `previous` is the v1 release, or a deploy of a v1 commit
  ([environments.md](environments.md)). v2 never wrote to the v1 database, so v1 resumes where it
  stopped.
