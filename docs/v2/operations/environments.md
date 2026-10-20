# v2 environments on the VPS

> **Status (2026-10-19):** the server side is **applied** (#251, merged as `9acf2ab6`; the playbook
> ran with `ok=108 changed=20 failed=0`): v2 databases, roles, settings, units (not enabled), Caddy
> paths and the backup and restore-check timers exist, and a manual backup and restore check
> succeeded. `checks` builds, smoke-tests and uploads the v2 release (`release` job, #228 part 2).
> **No v2 release has been deployed to any world yet**: dev and stage still run v1. The first v2
> deploy follows [the runbook below](#first-v2-deploy-to-a-world-runbook).

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

What the v2 programs need at runtime, and where each comes from on the server (checked against
`packages/backend/src/infrastructure/config` and `docs/v2/engineering/runtime-configuration.md`,
2026-10-19):

| Variable | Needed by | Source on the server |
|---|---|---|
| `NODE_ENV=production` | api, worker (production refuses placeholder identities) | `<world>.v2.env` and the units' `Environment=` |
| `KS_WORLD` | api, worker (`/health`, diagnostics) | `<world>.v2.env` and the units' `Environment=KS_WORLD=%i` |
| `KS_COMMIT` | api, worker (required in production) | `.ks/release.env`, written by `ks` when it receives the release |
| `KS_ARTIFACT_SHA256` | api, worker (required in production; `/health` `artifact`) | `.ks/release.env`: the sha256 of the exact tar the server received |
| `DATABASE_URL` | api, worker, migrate | `/etc/knowscroll/secrets/v2-<world>/database.env` (root only; `ks` adds a 15 min `statement_timeout` session option for migrate) |
| `PORT` | api | `<world>.v2.env` (4330 dev, 4320 stage) |
| `KS_PUBLIC_ORIGIN` | api (sign-in links, `Origin` checks, cookie name) and the operator command | `<world>.v2.env` |
| `KS_MEDIA_ROOT` | not read yet; provided for media | `<world>.v2.env` |
| `KS_NATIVE_SIGN_IN_BINDING` | api: stays **unset** (off) on dev and stage until the native app ships (#226 re-review N1) | not set anywhere |
| `KS_MAIL_SENDER=agentmail`, `KS_ALLOW_OPERATOR_SIGN_IN=1`, `KS_OPERATOR_SIGN_IN_PATTERN=*@test.knowscroll.space` | api and the operator command (S1.3: production refuses to start without AgentMail; operator links on dev/stage only, only for the pattern's addresses) | `<world>.v2.env` (`ks_v2_operator_sign_in_pattern` in `group_vars/all.yml`) |
| `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` | api only (never the worker) | `/etc/knowscroll/secrets/shared/agentmail.env` (root only; copied once from the owner's Mac, CF-40; dev and stage share the inbox), an extra `EnvironmentFile=` of `ks2-api@` |

Optional with defaults the server does not override: `KS_LISTEN_HOST` (127.0.0.1, which Caddy
proxies), `KS_DB_POOL_MAX` (api 10, worker 5), `KS_DB_STATEMENT_TIMEOUT_MS` (15 s; migrate 15 min),
`KS_BODY_LIMIT_BYTES`, `KS_SHUTDOWN_GRACE_SECONDS`; with S1.2 also `KS_SCOPE_LOCK_TIMEOUT_MS`,
`KS_SOCKET_AUTH_CACHE_MS` and `KS_AUTH_ADAPTER` (default `session`: identity's sessions since S1.3;
`test-bearer` is refused outside `NODE_ENV=test`). The connection budget fits
the `ks2_<world>` limit of 30: api 10, worker 5 plus its pg-boss pool 5, and during a migrate 2 + 2.
Later secrets (model keys) are added the same way, by a later change to `roles/worlds_v2`; the mail
key arrived that way with S1.3 (apply the role before deploying an S1.3 revision: without the
AgentMail file, or with `KS_ALLOW_OPERATOR_SIGN_IN=1` but no `KS_OPERATOR_SIGN_IN_PATTERN`, the v2
API refuses to start and `ks` keeps the previous release; without the `ks2-<world>` user the v2
units cannot start and `ks` refuses the v2 migrate).

### Who the v2 programs run as (#226 review m6)

Each world's v2 programs (`ks2-api@`, `ks2-worker@`, and `ks`'s v2 migrate) run as the world's own
v2 user `ks2-<world>` (system user, no login, in no other group), never as v1's `ks-<world>`. So
they cannot read v1's settings (`/etc/knowscroll/<world>.env`, `0640 root:ks-<world>`, which
embeds the AgentMail key and v1's database password) or v1's media. The v2 settings
(`<world>.v2.env`) and secrets are `0600 root`: systemd reads them as root (`EnvironmentFile=`)
and hands the values to the program as its environment, and the units make `/etc/knowscroll` and
v1's media folder invisible to the program (`InaccessiblePaths=`). The v2 media folder
(`media-v2`, recursively) belongs to `ks2-<world>`. Only `ks2-api@` gets the AgentMail file.

### The web app's headers (#226 review m7)

Caddy sends the v2 web app (recognised by the release's `web/_expo/` folder) the
Content-Security-Policy in `roles/caddy/files/app-content-security-policy.txt` (with
`connect-src 'self' wss://app.<world>…`), plus `X-Frame-Options: DENY`; v1's web, while a world
still runs it, gets only `frame-ancestors 'none'` and `X-Frame-Options: DENY`. The client's
Playwright smoke serves the export with the same file and fails on any policy violation. API
answers carry their own headers (`default-src 'none'`, no framing, `no-referrer`).

### Operator sign-in on dev or stage (D-007)

A disposable test account is signed in with a one-time link minted on the server (never in live:
only dev, stage, ci and local allow it; the world's settings carry `KS_ALLOW_OPERATOR_SIGN_IN=1`
and `KS_OPERATOR_SIGN_IN_PATTERN=*@test.knowscroll.space`). As root, with the world's environment
and the release's own program, as the world's v2 user:

```sh
sudo sh -c 'set -a; . /etc/knowscroll/dev.v2.env; . /etc/knowscroll/secrets/v2-dev/database.env; set +a;
  cd /srv/knowscroll/dev/current/api && exec runuser -u ks2-dev -- /usr/bin/node dist/operator.js issue-sign-in --email <name>@test.knowscroll.space'
```

It prints the link (`https://app.dev.knowscroll.space/redeem#token=…`) on stdout: open it in a
browser (operator links are for the web), check "Continue as n•••@test.knowscroll.space", tap it,
and the account is signed in. The link works once, for 15 minutes; treat it as a password until
then. Refused: an address outside the pattern (`address_not_allowed`), an address that signed up
by mail (`not_disposable`). Each issue leaves an audit row: `select world, issued_at,
operator_source, account_id from ops.operator_sign_ins order by issued_at desc` (as
`postgres` on `knowscroll_v2_<world>`); `operator_source` is `cli:<SUDO_USER>`.

### Admitting the starter Scroll on dev or stage (D-005, #229)

The thin journey needs one admitted Scroll. The authored starter ships in the release tree and is admitted
by the same operator program (no sign-in settings are needed; it touches no person's data). As root, with
the world's environment, as the world's v2 user:

```sh
sudo sh -c 'set -a; . /etc/knowscroll/dev.v2.env; . /etc/knowscroll/secrets/v2-dev/database.env; set +a;
  cd /srv/knowscroll/dev/current/api && exec runuser -u ks2-dev -- /usr/bin/node dist/operator.js content import-editorial \
    --file node_modules/@knowscroll/backend/dist/modules/content/starter/why-the-sky-is-blue.editorial-scroll.json'
```

It prints one JSON line (`outcome`, `assetId`, `revision`, `documentSha256`, `path`): `created` the first
time, `unchanged` when run again, `revised` when the shipped file changed. The Scroll is then at
`https://app.dev.knowscroll.space/scroll/<assetId>`. Refused outside dev, stage, ci and local.

The v2 API must answer `GET /health` on `PORT` with
`{"status", "world", "commit", "artifact", "migration"}`: `world` = `KS_WORLD`, `commit` =
`KS_COMMIT`, `artifact` = `KS_ARTIFACT_SHA256`, `migration` = the latest applied migration name.
A deploy is healthy only when `world`, `commit` and `artifact` match.

## Build and test (CI)

The `release` job of `checks.yml` does this on every push and PR, after the `build` and `client`
jobs passed (#228 part 2):

1. build the workspace as those jobs do (`nest build` for packages, api and worker; `expo export
   --platform web` for the client);
2. `node scripts/release/build.mjs --out "$RUNNER_TEMP/release" --commit "$GITHUB_SHA"` — writes
   `release-<sha>.tar` and `release-<sha>.tar.sha256` and prints the sha256. It runs
   `pnpm --config.inject-workspace-packages=true --filter <app> deploy --prod` for api and worker
   (each tree carries its own `pnpm-lock.yaml`, listed in `files.sha256` like every other file and
   link), copies the web export, and lists `release.json`'s `migrations` from `migrations/*.sql`.
   Layout defaults are at the top of the script; `--config <json>` overrides them. The archive
   wrapper is deterministic with GNU tar (sorted,
   root-owned, timestamps = commit time), but `pnpm deploy` output is not guaranteed byte-stable
   (e.g. `node_modules/.modules.yaml`), so **two builds of one commit can differ: never rely on a
   rebuild**. The server keeps the first copy and deploy.yml always uses the earliest push run's
   artifact;
3. `node scripts/release/smoke.mjs "$RUNNER_TEMP/release/release-<sha>.tar" --start --world dev`
   with `DATABASE_URL` pointing at a fresh database in the job's postgres:16 service — checks the
   release and its archive with the server's own code, then runs the programs as the v2 units do,
   with only the units' variables (plus `--pass-env NAME` for any the app needs in CI): migrate
   exits 0; the api answers `/health` with the world, commit, artifact and latest migration,
   answers an unknown route with a 404 `application/problem+json`, answers each
   `--unauthenticated <path>` with a 401 problem, and stops with exit 0; the worker starts and stops
   with exit 0;
4. upload the artifact **`release-$GITHUB_SHA`** (always `$GITHUB_SHA`, never a PR head SHA)
   holding exactly `release-<sha>.tar` and `release-<sha>.tar.sha256` at its root, kept 30 days
   (`if-no-files-found: error`). The job summary records the tar's sha256 and size. Only artifacts
   of runs triggered by a **push** in this repository are ever deployed (a PR run's artifact is
   named after the PR's merge commit and is never used);
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

### First v2 deploy to a world (runbook)

The agent may do this for **dev** (by manual dispatch, below). **Stage** gets v2 only by promotion
(`scripts/promote.sh stage`) once the owner agrees (D-004), never by dispatch. Live: never.

**Preconditions** (all read-only):

1. The server tool and Ansible match the integration branch (they were applied from it; re-apply
   with `ops/vps/ansible/run.sh --check --diff` then `run.sh` after any change under `ops/`).
2. `ssh knowscroll-vps ks status`: under `worlds.dev`, `v2Provisioned: true`, `openPoolOrders: 0`,
   v1 `health` ok; `disk.critical: false`; `backups.nightly.ok: true` (a pre-migrate dump is taken
   anyway).
3. The commit to deploy, `<sha>`, has a **successful push-triggered** `checks` run with the release
   artifact (the `release` job's summary shows its sha256):

   ```sh
   gh run list --workflow checks.yml --commit <sha> --event push --json databaseId,conclusion
   gh api repos/KnowScroll/knowscroll/actions/runs/<run-id>/artifacts --jq '.artifacts[] | [.name, .size_in_bytes, .expired]'
   ```

**Dispatch** (dev only; `--ref` names the branch whose `deploy.yml` runs, which must be the v2
workflow, e.g. the integration branch; `-f ref=` names the commit to deploy):

```sh
gh workflow run deploy.yml --ref codex/release-knowscroll-v2 -f ref=<sha>
gh run watch "$(gh run list --workflow deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

**What happens to v1 in dev:** after the pre-migrate dump and the v2 migrate, v1's API, worker,
maintenance and generation services stop and `ks-world@dev.target` is disabled;
`ks2-world@dev.target` is enabled and started on the same port 4330. v1's database
`knowscroll_test_dev`, its media and `dev.env` are not touched. Once v2 is healthy, `previous`
points at the v1 release. If v2 does not become healthy within 90 s, both links and v1 come back on
their own and the deploy job fails.

**Verify:**

```sh
curl -fsS https://app.dev.knowscroll.space/health      # {"status":"ok","world":"dev","commit":"<sha>","artifact":"<tar sha256>","migration":…}
curl -fsS https://backend.dev.knowscroll.space/health  # the same
ssh knowscroll-vps ks status                            # dev: generation v2, v2Services true, services false, lastDeploy names the predeployDump
ssh knowscroll-vps journalctl -u ks2-api@dev -u ks2-worker@dev --since -15min
```

The deploy job itself requires `/health` on both hosts to report the commit, the world and the
artifact hash of the tested tar.

**Roll back to v1** (root on the server): `ks rollback dev`. It swaps `current` and `previous`
(the v1 release), stops and disables the v2 units, enables and starts `ks-world@dev.target`, and
waits for v1's `/health`. v1 resumes on its own database exactly where it stopped. v2's database is
left as it is (restore its pre-migrate dump only if a migration must be undone: backups.md).

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

- No v2 release has been deployed to any world: no v2 deploy, promotion, rollback or pre-migrate
  dump has run on the VPS (the server side is applied; a manual backup and restore check ran).
- The `release` job proves the tar is built, passes the server's checks and boots in production
  against PostgreSQL 16 in CI; not yet on the server's Node, sandboxed units or loopback Caddy.
- `caddy validate` of the new Caddyfile has not run (Caddy is not installed on the Mac; the
  independent review ran `caddy adapt` on the server and it adapted cleanly); the role validates the
  file before installing it, so an invalid one is never put in place.
- The ks decisions, the release-tree reader (real folders, archives, `/proc/locks` under `flock`)
  and the backup scripts' rules are tested in the `integrity` job, and `build.mjs`/`smoke.mjs` run
  in the `release` job; the side-effecting flows of `system.ts` (deploy, rollback against systemd)
  have no automated test: they are proved only by the first real runs on dev.
- Whether Caddy's `file_server` follows a link out of `web/` was not tested; links under `web/` are
  refused, so it does not matter for v2 releases.
