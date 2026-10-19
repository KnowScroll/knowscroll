# v2 environments on the VPS

> **Status: implemented, not yet applied to the server** (#228 part 1). The code, Ansible roles and
> workflow below are in the repository; the coordinator applies Ansible and records the date here.
> Until then the server runs v1 only, exactly as before, and no v2 release exists yet.

How KnowScroll v2 runs on the one VPS: which world uses what, how a v2 release is built, shipped,
deployed, promoted and rolled back, and how to change the server safely. Backups and restores are in
[backups.md](backups.md). Decisions: D-002 (branches and promotion), D-004 (v2 runs in the existing
dev and stage worlds), D-008 (one origin per world). Server facts carried from v1: CF-20…CF-33.

## Worlds

v2 replaces v1 inside the existing worlds (D-004). A world runs **one generation at a time**: the
first v2 deploy to a world stops v1 there; a rollback to a v1 release brings v1 back.

| | dev | stage | live |
|---|---|---|---|
| Branch | `dev` (any commit by manual dispatch) | `stage` (branch tip only) | `main`, owner-only, **untouched** |
| Hosts | `app.dev` / `backend.dev` `.knowscroll.space` | `app.stage` / `backend.stage` | placeholder (503) |
| Loopback port (v1 and v2) | 4330 | 4320 | (4310 reserved) |
| Unix user, slice | `ks-dev`, `ks-dev.slice` | `ks-stage`, `ks-stage.slice` | — |
| v2 database / role | `knowscroll_v2_dev` / `ks2_dev` | `knowscroll_v2_stage` / `ks2_stage` | — |
| v2 media (`KS_MEDIA_ROOT`) | `/srv/knowscroll/dev/media-v2` | `/srv/knowscroll/stage/media-v2` | — |
| v2 settings | `/etc/knowscroll/dev.v2.env` | `/etc/knowscroll/stage.v2.env` | — |
| v2 database secret | `/etc/knowscroll/secrets/v2-dev/database.env` | `…/v2-stage/database.env` | — |
| v1 (left as it is) | `knowscroll_test_dev`, `ks_dev`, `dev/media`, `dev.env` | `knowscroll_test_stage`, … | — |

The v1 databases, roles, media, env files and units are not changed or dropped. The shared Reel
pool `knowscroll_pool` is not reachable by the v2 roles (S4.3 decides how v2 uses it); it is backed
up nightly with the v2 databases.

## The v2 release contract

A v2 release is `release-<commit>.tar` (plain tar) whose root holds exactly:

| Path | What |
|---|---|
| `release.json` | `{"schema": "ks-release.v2", "commit", "builtAt", "node", "programs": {"api": {"cwd": "api", "exec": ["node", "--enable-source-maps", "dist/main.js"]}, "worker": {…}}, "migrate": {"cwd": "api", "exec": ["node", "dist/migrate.js"]}, "web": "web", "migrations": [names]}` |
| `files.sha256` | one line per file **and link** except itself, `<sha256>  <path>`: a file's hash is of its content, a link's is `sha256("symlink:" + target)` (so `sha256sum -c` cannot check link lines; `ks` and the smoke test do) |
| `api/`, `worker/` | `pnpm --config.inject-workspace-packages=true --filter @knowscroll/<app> deploy --prod` output (`package.json`, `dist/`, `node_modules/`, the deployed `pnpm-lock.yaml`; installed from the workspace lockfile, D-014) |
| `web/` | `expo export --platform web` output of `apps/client` |

A `release.json` without `schema` is a v1 release and is handled exactly as before. Any other
schema is refused. The rules live in one place, `ops/vps/tool/plan.ts` (`validateV2Manifest`,
`checkFileList`), and the release builder, the CI smoke test and the server all use them:

- `programs` names exactly `api` and `worker` (the server has units for those); each `exec` is
  `["node", …]` with single-line arguments; each `cwd`, and `migrate.cwd`, is a plain folder in the
  release; `web` is `"web"` (Caddy serves `current/web`).
- `files.sha256` matches the release exactly: no missing entry, no unlisted file or link, no hash
  mismatch (a retargeted link is a mismatch), no unsafe path.
- Every link is relative and is followed component by component the way the kernel resolves it
  (`plan.ts` `linkStaysInside`); it must never step above the release root, must end at something
  that exists, and its real path (`realpathSync.native`) must be inside the release. A lexical
  check is not enough: with `s -> .`, `s/s/../../etc` reads as inside but climbs out (#228 review
  M2). No link at all is allowed under `web/` (Caddy serves it; an Expo export has none).
- The program, migrate and `web` folders, and every folder on the way to them, are real folders,
  never links. Devices, FIFOs and sockets are refused. A release that carries a `.ks/` folder is
  refused: only the server writes it.
- One implementation: `ops/vps/tool/tree.ts` reads folders and archives for the server, and
  `scripts/release/files.mjs` re-exports it for the builder and the smoke test (a test checks they
  are the same functions).

What the v2 programs get from their units (and `ks` gives `migrate`): `KS_WORLD`, `PORT`,
`NODE_ENV=production`, `KS_MEDIA_ROOT`, `KS_PUBLIC_ORIGIN` (`https://app.<world>.knowscroll.space`)
from the settings file; `DATABASE_URL` from the root-only secret; `KS_COMMIT` and
`KS_ARTIFACT_SHA256` (the sha256 of the exact tar the server received) from `.ks/release.env`.
Later secrets (auth, mail, model keys) are added the same way, by a later change to
`roles/worlds_v2`.

The v2 API must answer `GET /health` on `PORT` with
`{"status", "world", "commit", "artifact", "migration"}`: `world` = `KS_WORLD`, `commit` =
`KS_COMMIT`, `artifact` = `KS_ARTIFACT_SHA256`, `migration` = the latest applied migration name.
A deploy is healthy only when `world`, `commit` and `artifact` match.

## Build and test (CI)

`checks.yml` (owned by the coordinator) is expected to, on every push and PR:

1. build the workspace (`nest build` for api and worker, `expo export --platform web` for the client);
2. `node scripts/release/build.mjs --out "$RUNNER_TEMP/release" --commit "$GITHUB_SHA"` — writes
   `release-<sha>.tar` and `release-<sha>.tar.sha256` and prints the sha256. Layout defaults are at
   the top of the script; `--config <json>` overrides them (e.g. `"migrations": "<folder>"` to fill
   `release.json`'s migration list). The archive wrapper is deterministic with GNU tar (sorted,
   root-owned, timestamps = commit time), but `pnpm deploy` output is not guaranteed byte-stable
   (e.g. `node_modules/.modules.yaml`), so **two builds of one commit can differ: never rely on a
   rebuild**. The server keeps the first copy and deploy.yml always uses the earliest push run's
   artifact;
3. `node scripts/release/smoke.mjs "$RUNNER_TEMP/release/release-<sha>.tar" --start --world dev`
   with `DATABASE_URL` pointing at the job's disposable Postgres service — checks the release and
   its archive with the server's own code, runs its migrate, starts its api with only the unit's
   variables (plus `--pass-env NAME` for any the app needs in CI) and requires `/health` to report
   the world, commit, artifact and latest migration;
4. upload an artifact named **`release-$GITHUB_SHA`** (always `$GITHUB_SHA`, never a PR head SHA)
   holding exactly `release-<sha>.tar` and `release-<sha>.tar.sha256` at its root, with a
   retention long enough to cover a later promotion to stage (30 days suggested). Only artifacts of
   runs triggered by a **push** in this repository are ever deployed;
5. `node --test ops/vps/tool/plan.test.ts ops/vps/tool/tree.test.ts ops/vps/backup/scripts.test.ts`
   (already in the `integrity` job).

## Deploy, promote, roll back

### Deploy (`.github/workflows/deploy.yml`)

Unchanged rules: pushes to `dev`/`stage` only, never on PRs, never a self-hosted runner;
`workflow_dispatch` deploys any ref to dev only; one deploy per world at a time, queued, never
cancelled; the world-pinned deploy key (forced command `ks-gate <world>`); waits for a successful
`checks.yml` run on the exact commit.

New: the commit's generation is read from the commit itself — a v2 commit carries
`scripts/release/build.mjs` (v1 commits never did; `apps/api` cannot tell them apart because v1 had
one too). For v2 nothing is built in deploy:

- It waits for a successful `checks` run **triggered by a push** on the commit, and takes
  `release-<sha>` only from such runs whose repository and head repository are this repository —
  never from a `pull_request` run, which may run a fork's own workflow (#228 review m3). It uses the
  earliest one; when the server already holds the release (a promotion) it must be that earliest
  run, the one the first deploy used.
- "Not uploaded" and "expired" are told apart from errors: any API or download error fails the job
  (m5). Only when the server already holds the release and that artifact has **expired** does the
  promotion go ahead with a warning and without the artifact comparison (the server re-verifies its
  copy against `files.sha256`).
- `release-<sha>.tar.sha256` must be exactly one line `<sha256>  release-<sha>.tar`, and the
  workflow hashes the tar itself and compares (m4).
- It streams the tar to `deploy <world> <sha>` (or runs `promote` if the server holds it), then
  requires `/health` on `app.` and `backend.` to report the commit, the world and that artifact.

v1 commits are built from source as before.

### On the server (`ks deploy|promote <world> <commit>`, `ops/vps/tool/system.ts`)

For a v2 release:

1. Refused if the disk is critical; stage only takes the tip of `stage` (`git ls-remote`).
2. Refused unless the world is set up for v2 (`<world>.v2.env` and its database secret exist).
0. Everything below runs under the deploy lock `/run/knowscroll/deploy.lock`: ks-gate takes it
   for deploy and promote; `ks rollback`, `ks cleanup` and `ks run <world> generation-cli` (the
   one program that can claim a paid Reel order) take it themselves (they re-run under `flock`,
   or see that they already run under it); the disk guard never waits for it (#228 review m2, m7).
1. Refused if the disk is critical; stage only takes the tip of `stage` (`git ls-remote`).
2. Refused unless the world is set up for v2 (`<world>.v2.env` and its database secret exist).
3. `deploy`: saves the tar from stdin (root only) while hashing it, **lists it before extracting
   anything** and refuses devices, FIFOs, other special entries, absolute paths, `..`, writes
   through a link the archive made, hard links to anything but an earlier file, and `.ks/` (m6);
   extracts with `--no-same-owner --no-same-permissions` and normalises every mode (`u=rwX,go=rX`:
   no set-id, no sticky, no group/other write); verifies `release.json` and `files.sha256` (files
   and links, see above); writes `.ks/release.env` (`KS_COMMIT`, `KS_ARTIFACT_SHA256`) and
   `.ks/programs/<program>.{cwd,argv}`; moves it to `/srv/knowscroll/releases/<commit>`.
   `promote`: re-verifies the copy already there.
4. **v1 → v2 only:** refused while this world has an open paid Reel order in `knowscroll_pool`
   (`ordered_by = <world>`, state `claimed`), or if that cannot be read — v1's generation worker
   must settle it first. Because the check and the switch happen under the deploy lock, and every
   order-claiming `ks run` takes the same lock, no claim can slip in between.
5. **Pre-migrate dump:** `pg_dump -Fc` of `knowscroll_v2_<world>` to
   `/srv/knowscroll/backups/knowscroll_v2_<world>/pre-deploy-<UTC time>-<commit12>.dump` (0700/0600,
   root), checked with `pg_restore --list`; if it fails, nothing is migrated (m10).
6. Runs `migrate` from `release.json` as `ks-<world>` with the v2 settings and secret, with its own
   `statement_timeout` of 15 min set in the migrate session (connection `options`, also
   `PGOPTIONS`); the role's 30 s limit is not loosened. **No seed.**
7. `current` → the new release; **`previous` is not touched yet** (m1).
8. Stops whatever runs of v1 (`ks-world@<world>.target` and its four services) and disables its
   target; enables and restarts `ks2-world@<world>.target`; waits up to 90 s for `/health`.
9. Healthy: now `previous` → the release that ran before (unless it was the same commit), logs to
   `releases.log` (with generation, artifact and the pre-migrate dump's name), then cleanup.
   Not healthy: `current` and `previous` go back **exactly** as they were, and **that release's
   generation** is started again (v2 → restart v2; v1 → stop v2, start v1; placeholder → stop
   both). Migrations are never rolled back automatically: v2's database stays migrated; restoring
   the pre-migrate dump undoes it ([backups.md](backups.md)). v1's database is untouched by any of
   this.

v1 releases deploy as before (pool migrations, migrate, seed, `ks-world@` target). What is new for
them: the archive is listed and refused the same way before extraction, extraction uses root as
owner and normalised modes, `previous` only moves after the health check, starting v1 also stops
v2's units in that world if they run, and a `systemctl` failure leads to the rollback path.

### What the first v2 deploy does to a world that runs v1

- v1's API, worker, maintenance and **generation** services stop, and `ks-world@<world>.target` is
  disabled (it will not start at boot). Its database, media and env file stay exactly as they are.
- `previous` points at the v1 release, so `ks rollback <world>` (or a failed health check) brings
  v1 back as it was. Cleanup never deletes a release any world's `current`/`previous` names.
- Before the first v2 deploy to **stage**, check that `ks status` shows `"openPoolOrders": 0` under
  `worlds.stage` (the orders stage placed and has not settled; the deploy refuses otherwise) and
  decide with the owner whether stage may stop serving v1 (D-004: after the Phase 2 journeys pass on
  dev).

### Promote (`scripts/promote.sh stage`)

Unchanged: dev's healthy commit is fast-forwarded to `stage` if `checks` passed on it. The push runs
deploy.yml, which reuses the server's copy (`promote`) and checks that stage reports the same
artifact hash as the tested release. The script now also prints dev's artifact.

### Roll back by hand

As root on the server (`ssh knowscroll-vps`). `ks rollback` takes the deploy lock itself (running
it under `flock … deploy.lock` as before works too):

```sh
ks rollback dev   # swap current/previous, verify a v2 release again, start that generation
ks status         # generation, health, services, open pool orders per world, backups
```

If the release it returns to does not become healthy, both links and the generation that ran before
are put back, as a failed deploy does (#228 review m8). A rollback is code only: to undo a v2
migration, restore the pre-migrate dump ([backups.md](backups.md)).

To put a world back on **v1** for good while its `previous` is no longer v1, deploy a v1 release
the server still holds (e.g. `legacy/v1-final` = `106c4701…` while dev or stage references it):
dispatch deploy.yml with that commit; the server already has it, so it is a `promote` and runs v1's
own migrate and seed against the v1 database.

## Cleanup and the disk guard

Unchanged thresholds and timers. Cleanup now:

- runs under the deploy lock, so it never races a deploy or promotion (`ks cleanup` takes it; after a
  deploy it runs inside the deploy's own lock). The disk guard never waits: while a deploy holds
  the lock it does everything except deleting releases;
- finds every `current`/`previous` link under `/srv/knowscroll/*/` (not only the three named
  worlds) and keeps every release they name whatever its generation; relative links and links into a
  release's own folder count. If a link cannot be read or points into the releases folder at
  something that is not a 40-hex release, it deletes **no release** and says why (before, such a
  release was treated as unused);
- runs each step on its own: release deletion, interrupted uploads, media temp files (`media/tmp`
  and `media-v2/tmp`) and, in an emergency, the journal vacuum. One failing step does not skip the
  others; failures are reported and the command exits non-zero (#228 review m7). A refused cleanup
  after a good deploy is logged and does not fail the deploy.

## Units and processes

| Unit | What |
|---|---|
| `ks2-api@<world>.service` | `ks2-run <world> api`: `/usr/bin/node <argv>` in the release's `api/` as `release.json` names it; `MemoryHigh/Max` 600M/800M; same sandbox as v1 (`ProtectSystem=strict`, writes only `media-v2`); `Conflicts=ks-api@<world>` (same port) |
| `ks2-worker@<world>.service` | same for `worker`, 450M/600M, no port |
| `ks2-world@<world>.target` | wants both; `Conflicts=ks-world@<world>.target` |
| drop-ins `ks2-*@<world>.service.d/oom.conf` | the world's v1 OOM score (dev dies first, never Postgres) |

Both units run in the world's slice (`ks-<world>.slice`: CPU weight, 1200M/1536M), the same budget
v1 had there. Ansible installs them but never enables or starts them; `ks` does, per deploy.

## Caddy (D-008)

`app.<world>` proxies `/v1/*`, `/health`, `/auth/*`, `/media/*`, `/s/*` and `/socket.io/*`
(WebSocket upgrade; `stream_close_delay 5m` so a Caddy reload does not drop every socket at once)
to the world's port, with `lb_try_duration 5s` as before. `/assets/*` and `/_expo/*` are served
immutable from `current/web`; everything else from `current/web` with `try_files {path}
{path}.html /index.html`. Sockets and `/media/*` are not compressed. v1 answers 404 on the new API
paths (it had no web routes under them). `backend.<world>` still proxies everything. Live's
placeholder is unchanged.

## Changing the server safely (Ansible)

Always from an up-to-date checkout of the integration branch (Ansible copies `ops/vps/tool` and the
scripts from the checkout it runs in; an old checkout would roll the server tool back).

```sh
ops/vps/ansible/run.sh --check --diff   # preview; read every change
ops/vps/ansible/run.sh                  # apply
ops/vps/ansible/run.sh --check --diff   # afterwards: expect no changes but the known noise below
```

What applying #228 part 1 does (from the `--check --diff` of 2026-10-19):

- adds `/etc/knowscroll/secrets/v2-{dev,stage}/` (0700) with a generated `db_password` and
  `database.env` (0600, root), roles `ks2_dev`/`ks2_stage` (LOGIN, no superuser/createdb/createrole,
  connection limit 30, `statement_timeout` 30 s) and databases `knowscroll_v2_dev`/`_stage` owned by
  them, `CONNECT` revoked from `PUBLIC`;
- adds `/etc/knowscroll/{dev,stage}.v2.env` (root:ks-<world>, 0640, no secrets), `media-v2/`
  folders, `/usr/local/lib/knowscroll-ops/ks2-run`, the three ks2 unit files and their OOM drop-ins
  (not enabled);
- replaces `ks.ts`, `plan.ts`, `system.ts` and adds `tree.ts` (see "What is new for them" above
  for v1), and the Caddyfile (the paths above), then **reloads Caddy** (graceful; v1 keeps
  serving);
- adds the backup folder, scripts, `ks-backup.timer` and `ks-restore-check.timer` (enabled), the
  restore check's OS user and database role `ks_restore_check` (no superuser, no password, peer
  login only), and makes sure `rsync` is installed ([backups.md](backups.md)).

Nothing in it restarts Postgres, a world, Cutroom or the deploy user's setup. Known noise: the
`Caddy signing key` (`get_url`) task reports a change in every preview, also from the unchanged base
branch; it has no diff. In a preview the role/database statements and the secret-assembling tasks
are skipped (they would not be read-only), so they appear only when applying.

## Not proved yet

- Nothing here has been applied to the server; no v2 release exists yet; no v2 deploy, promotion,
  rollback, backup or restore has run on the VPS.
- `caddy validate` of the new Caddyfile has not run (Caddy is not installed on the Mac; the
  independent review ran `caddy adapt` on the server and it adapted cleanly); the role validates the
  file before installing it, so an invalid one is never put in place.
- The ks decisions, the release-tree reader (real folders, archives, `/proc/locks` under `flock`)
  and the backup scripts' rules are tested in the `integrity` job; `build.mjs` and `smoke.mjs` have
  not run yet (no workspace to build), and the side-effecting flows of `system.ts` (deploy,
  rollback, the restore check against Postgres) have no automated test: they are proved only by
  the first real runs on dev.
- Whether Caddy's `file_server` follows a link out of `web/` was not tested; links under `web/` are
  refused, so it does not matter for v2 releases.
