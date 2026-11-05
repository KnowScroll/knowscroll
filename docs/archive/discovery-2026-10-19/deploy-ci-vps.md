# KnowScroll deploy / CI / VPS discovery (for the v2 programme)

Discovery date: 2026-10-19. Read-only. Sources: `origin/dev` = `106c47014a48fa61888d15403db8118060102a5c`
in `/Volumes/Mrigesh SSD/knowscroll-product` (read with `git show origin/dev:<path>`; nothing checked out),
`gh api` as Legend101Zz, and read-only commands on `ssh knowscroll-vps`. Refs at discovery time:
dev `106c4701`, stage `8982391f`, main `e5fdc319`.

Notation: **[verified]** = I saw it in a file/command output named next to it. **[unverified]** = inference
or something I could not check.

---

## 1. GitHub: workflows, rulesets, environments, secrets, runs

### 1.1 Workflows on origin/dev (`.github/workflows/`)

Only two workflow files exist: `checks.yml` and `deploy.yml` [verified: `git ls-tree -r --name-only origin/dev .github`].

#### `checks.yml` (workflow name `checks`)

- Trigger: `on: [push, pull_request]` — every push to **any** branch (including `stage` and `main`
  promotions) and every PR. No path filters, no `workflow_dispatch`. `permissions: contents: read`.
- Toolchain pins (all three jobs that use Node): `actions/checkout@3d3c42e…` (v7.0.1),
  `pnpm/action-setup@ea17c68…` (v6.1.0) with pnpm `10.30.3`, `actions/setup-node@8207627…` (v7.0.0)
  with Node `22.23.0`. Root `package.json` pins `"packageManager": "pnpm@10.30.3"` and
  `"engines": {"node": ">=22.23.0 <23"}`.
- Job **`backend`** (ubuntu-latest, service container `postgres:16` user `knowscroll`, password
  `test-only-ci-password` — a test-only literal in the file, not a secret; `DATABASE_URL=postgresql://knowscroll:…@127.0.0.1:5432/postgres`,
  `KS_DEV_ROOT=/tmp/knowscroll-dev`). Steps, in order:
  `pnpm install --frozen-lockfile` → `apt-get install -y ffmpeg` → `pnpm format:check` (sql-formatter + biome)
  → `pnpm lint` (biome + `scripts/check-architecture.mjs`) → `pnpm knip` → `pnpm typecheck` (`tsc --noEmit`)
  → `pnpm contracts:check` (regenerates `packages/contracts/http-v1.schema.json`, `git diff --exit-code`)
  → `pnpm test` (`./scripts/test.sh`) → `pnpm typecheck:web` → `pnpm test:web`
  → **"Build and smoke-test the server release"**: `pnpm build:release --out "$RUNNER_TEMP/release" --commit "$GITHUB_SHA"`
  then `node scripts/smoke-release.mjs "$RUNNER_TEMP/release/release-$GITHUB_SHA.tar"`
  → fairness evidence (`scripts/capture-fairness-evidence.ts`, `scripts/fairness/sql-restart.ts`)
  → `scripts/journey-verifier.test.ts` → isolated journeys (`run-isolated-journey.ts`, `-session-`, `-history-`,
  `-reasoning-` + `verify-reasoning-journey.ts`, `-ask-`, `-retirement-`, `-cutroom-http-`, `verify-reasoning-cleanup.ts`).
  Artifact uploaded: **`reasoning-interruption-evidence`** (`artifacts/j004-cleanup-*.json`, `artifacts/j004-interrupt-*.json`,
  `if: always()`, retention 7 days). The smoke-tested release tarball is **not** uploaded as an artifact.
- Job **`web-journey`** (ubuntu-latest, `timeout-minutes: 30`, same postgres:16 service,
  `PLAYWRIGHT_BROWSERS_PATH=/tmp/knowscroll-dev/playwright-browsers`):
  `pnpm --filter web exec playwright install --with-deps chromium`, then
  `scripts/run-web-reader-journey.ts`, `scripts/run-web-owner-journey.ts`, `scripts/run-web-why-journey.ts`
  (real Vite dev server + real API/worker + Chromium). Artifact on failure: **`web-journey-evidence`**
  (receipts under `docs/journeys/evidence/web-*/` and `apps/web/artifacts/playwright-*`, retention 7 days).
- Job **`android`** (ubuntu-latest): `actions/setup-java` (temurin 17), `android-actions/setup-android`
  (`platforms;android-37.2`, `build-tools;36.0.0`), `gradle/actions/setup-gradle`; runs
  `./gradlew :app:assembleDebug :app:lintDebug :app:testDebugUnitTest` in `apps/mobile`, then builds a release
  APK with a throwaway keystore made on the runner (`KS_RELEASE_API_BASE=https://api.knowscroll.invalid`)
  and `apksigner verify`. No artifact.
- Check-run context names as GitHub records them (on `106c4701`): **`backend`**, **`web-journey`**,
  **`android`** (plus **`deploy`** from deploy.yml) [verified: `gh api repos/KnowScroll/knowscroll/commits/106c4701…/check-runs`].
- Wall time: checks runs on dev took 11–18 min (`gh run list --branch dev --limit 15`).

#### `deploy.yml` (workflow name `deploy`)

- Triggers: `push` to branches `[dev, stage]`; `workflow_dispatch` with one required input **`ref`**
  ("Commit SHA or branch to deploy to dev"). **Never runs on pull_request** and never on a self-hosted
  runner (comment: repo is public). `main`/live is **not** a trigger yet ("Live (`main`) joins when the
  live world is set up").
- World selection: `WORLD = workflow_dispatch ? 'dev' : github.ref_name` — so a dispatch always deploys
  to **dev**, a push deploys to the world named like the branch (`dev` or `stage`). The same expression
  picks the GitHub **environment** (`environment.name`) and the URL `https://app.<world>.knowscroll.space`.
- Concurrency: `group: deploy-<world>`, `cancel-in-progress: false` (a newer deploy queues; cancelling
  could cut SSH mid-migration).
- `permissions: contents: read, actions: read`. Job `deploy`, ubuntu-latest, `timeout-minutes: 90`.
- Steps:
  1. **Resolve the commit** — dispatch: `gh api repos/$GITHUB_REPOSITORY/commits/$REF --jq .sha`; push: `$GITHUB_SHA`.
  2. **Wait for checks to pass on this commit** — polls `gh run list --workflow checks.yml --commit "$SHA"`
     up to 120 × 30 s (60 min). Exits 0 as soon as **any** `checks` run on that SHA has
     `conclusion == success`; fails if all runs are completed and none succeeded. This is how a stage
     promotion skips re-waiting: the dev push already produced a green `checks` run for the same SHA.
  3. **SSH access** — writes `secrets.KS_DEPLOY_SSH_KEY` (environment secret) to `~/.ssh/deploy`,
     `vars.KS_DEPLOY_KNOWN_HOSTS` to `known_hosts`, an ssh config `Host knowscroll` → `HostName ${{ vars.KS_DEPLOY_HOST }}`,
     `User deploy`, `IdentitiesOnly yes`, `StrictHostKeyChecking yes`.
  4. **Does the server already hold this release?** — `ssh knowscroll "has-release $SHA"` → output `present`.
  5. If not present: checkout `$SHA`, pnpm 10.30.3, Node 22.23.0 (`cache: pnpm`), `pnpm install --frozen-lockfile`,
     `pnpm build:release --out "$RUNNER_TEMP/release" --commit "$SHA"`.
     **Note: this is a second, independent build** — not the tarball that `checks` smoke-tested.
  6. **Deploy** — present: `ssh knowscroll "promote $WORLD $SHA" < /dev/null`; else
     `ssh knowscroll "deploy $WORLD $SHA" < release-$SHA.tar` (tarball streamed over SSH stdin; no scp/rsync).
  7. **Check it from outside** — for `app` and `backend`: `curl -fsS https://<host>.<world>.knowscroll.space/health`
     and `jq -e '.commit == $sha and .world == $world'`.
- Observed timings: dev deploys 12–19 min (they wait for checks, then build); stage deploys 21–90 s
  (release already on the server → `promote` path) [verified: `gh run list --workflow deploy.yml --limit 12`].

### 1.2 Rulesets (`gh api repos/KnowScroll/knowscroll/rulesets` + detail)

| id | name | branches | rules | bypass |
|---|---|---|---|---|
| 24594426 | `environment branches: no deletion, no force-push` | `refs/heads/main`, `refs/heads/stage`, `refs/heads/dev` | `deletion`, `non_fast_forward` | none (`current_user_can_bypass: never`) |
| 24608344 | `promotion branches: only promoters update main and stage` | `refs/heads/main`, `refs/heads/stage` | `update` (restrict updates) | Team **`promoters`** (id 19949429), `bypass_mode: always`; members **XZNON**, **Legend101Zz** (`current_user_can_bypass: always`) |

- **There are no required status checks anywhere** (no `required_status_checks` rule in either ruleset,
  and classic branch protection returns 404 "Branch not protected" for dev, stage and main)
  [verified: `gh api repos/KnowScroll/knowscroll/branches/<b>/protection`, `gh api repos/KnowScroll/knowscroll/rules/branches/<b>`].
- **There is no `pull_request` rule on `dev`**: dev accepts direct (fast-forward) pushes from anyone with
  write access; PRs into dev are a convention (docs/agent-workflow), not enforced. Effective rules on dev =
  `deletion` + `non_fast_forward` only.
- Effective rules on stage and main = `deletion` + `non_fast_forward` + `update`; only the `promoters`
  team can move them, and only fast-forward.
- Org-level rulesets: could not read (`gh api orgs/KnowScroll/rulesets` → 404, token lacks `admin:org`)
  **[unverified]**; the per-branch effective-rules endpoint (which includes org rules) shows only the two
  repo rulesets, so none apply here.

### 1.3 Merge settings (`gh api repos/KnowScroll/knowscroll`)

`default_branch: dev`, **squash only** (`allow_squash_merge: true`, `allow_merge_commit: false`,
`allow_rebase_merge: false`), `squash_merge_commit_title: COMMIT_OR_PR_TITLE`,
`squash_merge_commit_message: COMMIT_MESSAGES`, `delete_branch_on_merge: true`, `allow_auto_merge: false`,
`visibility: public`. Recent merges (#215–#221) are all `dev <- claude/<issue>-<slug>` squash merges.

### 1.4 Environments (`gh api repos/KnowScroll/knowscroll/environments`)

| environment | protection rules | deployment branch policy | env secrets (names) | env vars |
|---|---|---|---|---|
| `dev` | none | none (any ref; needed because dispatch can deploy any branch) | `KS_DEPLOY_SSH_KEY` (updated 2026-10-06) | none |
| `stage` | `branch_policy` | custom: branch `stage` only | `KS_DEPLOY_SSH_KEY` (updated 2026-10-06) | none |
| `production` | `required_reviewers`: Legend101Zz, XZNON (`prevent_self_review: false`); `branch_policy` | custom: branch `main` only | **none** | none |

- Repo-level secrets: **none**. Repo-level variables: **`KS_DEPLOY_HOST`**, **`KS_DEPLOY_KNOWN_HOSTS`**.
- `can_admins_bypass: true` on all three.
- Mismatch to note: deploy.yml would name the live environment `main` (`github.ref_name`), but the
  environment that exists is called `production`. Harmless today (main is not a trigger), but whoever
  adds live must reconcile it [verified by reading both].
- The deploy key differs per world (two separately-stored `KS_DEPLOY_SSH_KEY` secrets; the VPS
  `authorized_keys` binds each key to one world via `ks-gate <world>` — see §3/§4).

### 1.5 Recent runs

- `gh run list --branch dev --limit 15`: all `success`; the last dev push was #221 (cosmic origin) on
  2026-10-16, `checks` 12m16s + `deploy` 13m14s. Before that a run of #199 Cutroom commits on 2026-10-08/09.
- `gh run list --branch stage --limit 8`: all `success`; last stage promotion 2026-10-09 06:26 (`8982391f`),
  deploy 21 s, while `checks` re-ran on stage for 11m52s in parallel (redundant run, because checks
  triggers on every push).
- dev (`106c4701`) is ahead of stage (`8982391f`) by #221 — stage has not been promoted since 2026-10-09.

---

## 2. Promotion

### 2.1 `scripts/promote.sh` (origin/dev)

```
scripts/promote.sh stage   # dev's healthy commit → stage
scripts/promote.sh live    # stage's healthy commit → main
```

What it does, exactly [verified: file content]:
1. Reads the commit the *lower* world is actually running from `https://backend.<from>.knowscroll.space/health`
   (`sed` out `"commit":"<40 hex>"`). Refuses if the world is not healthy.
2. `git fetch origin <from> <to>`; refuses unless `origin/<to>` is an ancestor of that SHA (fast-forward only)
   and the SHA is an ancestor of `origin/<from>`.
3. Refuses unless `gh run list --workflow checks.yml --commit <sha>` has at least one `success`.
4. `git push origin "<sha>:refs/heads/<to>"` — a plain **fast-forward git push** with the caller's own
   credentials. No GitHub API merge, no PR, no merge commit. It succeeds only because the caller is in the
   `promoters` team that bypasses ruleset 24608344's `update` restriction.
5. The push fires `deploy.yml` for the `stage` world, which finds the release already on the server
   (`has-release`) and runs `ks promote stage <sha>` — no rebuild; stage runs the same unpacked bytes dev ran.

Invariant it maintains: `main ⊆ stage ⊆ dev` literally (same SHAs, no merge commits).

### 2.2 Can an agent open a PR dev→stage instead?

- Technically a PR `stage <- dev` can be *opened* by anyone, but **it cannot be merged usefully**:
  the repo allows only squash merges, so merging it would create a new commit on stage that is not on dev
  (breaking the fast-forward invariant and the "same release" reuse — the squash SHA has no release on the
  server, so deploy.yml would rebuild it, and `ks deploy stage` would accept it only if it is the stage tip).
  Merging also requires bypass of the `update` rule (promoters only). No PR into stage has ever been
  opened (`gh pr list --base stage --state all` → empty).
- So promotion is **only via the fast-forward push** (promote.sh or an equivalent `git push origin <sha>:refs/heads/stage`
  by a promoter). The agent today runs as the owner's GitHub account (Legend101Zz, a promoter), so it
  *can* run `scripts/promote.sh stage`.

### 2.3 `.claude/hooks/refuse-main-update.mjs` (+ `.claude/settings.json`)

A `PreToolUse` hook on every `Bash` call (`node "$CLAUDE_PROJECT_DIR/.claude/hooks/refuse-main-update.mjs"`,
timeout 10 s). It exits 2 (blocks) when the command matches any of:
- `git push … [<src>:][refs/heads/]main` (push to main),
- `git push … --mirror|--all`,
- any literal `refs/heads/main`,
- `promote.sh live`.

It does **not** block stage promotion. Rationale in the file: the agent uses the owner's GitHub account,
so GitHub cannot tell agent from owner; this hook is the only guard. It only guards Claude Code sessions
in that checkout; other harnesses (Codex, Pi) are not covered **[inference]**.

---

## 3. Release artifact: build → ship → activate → health → rollback

### 3.1 Build: `scripts/build-release.mjs` (`pnpm build:release`)

- Usage: `node scripts/build-release.mjs --out <dir> [--commit <sha>]` (commit defaults to `git rev-parse HEAD`;
  must be 40 hex).
- **esbuild** (`esbuild ^0.28.2` devDependency) bundles each program with all dependencies:
  `bundle: true, platform: node, format: esm, target: node22, sourcemap: true, outExtension .mjs`, plus a
  `createRequire` banner for CJS deps. Programs (`PROGRAMS` map): `api` (`apps/api/src/main.ts`),
  `worker` (`apps/worker/src/main.ts`), `generation`, `maintenance`, `migrate`, `seed`, `migrate-pool`,
  `generation-cli`, `publication`, `install-supply`.
- Fails if any import is left outside the bundle except Node builtins and `pg-native` — **the server has
  no `node_modules` and no npm during a deploy**.
- Web: `pnpm --filter web exec vite build --outDir <root>/web`.
- Copies `packages/db/migrations`, `packages/db/pool-migrations`, `content/`.
- Writes `release.json` (`commit`, `builtAt`, `node`, `bundles` = sha256 per `dist/*.mjs`, `migrations` list)
  and `release.env` (`KS_COMMIT=<sha>`). "Nothing in it names a world."
- Output: `<out>/<sha>/` tree, `<out>/release-<sha>.tar` (plain tar, not compressed), `<out>/release-<sha>.tar.sha256`.
- Smoke test `scripts/smoke-release.mjs <tar>` (in `checks`): unpack in empty dir, assert no `node_modules`,
  create a throwaway DB, run `dist/migrate.mjs` + `dist/seed.mjs`, start `dist/api.mjs` with
  `NODE_ENV=production` and the world env vars (`KS_WORLD`, `KS_COMMIT`, `KS_CSRF_SECRET`, `KS_WEB_ORIGIN`,
  `KS_MAIL_SENDER`, `AGENTMAIL_*`, `KS_OWNER_EMAIL`, `KS_MEDIA_ROOT`), check `/health` (`status ok`,
  `database true`, `world`, `commit`) and that `/v1/universe` without session → 401.
- The current API is **Fastify** (`fastify ^5.6.0` in root deps).

### 3.2 Ship

- Streamed: `ssh knowscroll "deploy <world> <sha>" < release-<sha>.tar` (stdin). No scp/rsync, no
  GitHub artifact, no registry.
- SSH lands as user **`deploy`** with a **forced command** `/usr/local/bin/ks-gate <world>`
  (source `ops/vps/gate.sh`): one key per world in `authorized_keys`
  (`restrict,command="/usr/local/bin/ks-gate dev" ssh-ed25519 …`). The gate allows only
  `has-release <sha>` (any world), `deploy|promote <its-own-world> <sha>`, and runs them via
  `sudo -n /usr/bin/flock --timeout 1800 /run/knowscroll/deploy.lock /usr/local/bin/ks …` (one deploy at a
  time across all worlds).

### 3.3 Activate (`ops/vps/tool/system.ts` `deploy()`, run as root by `ks`)

1. Refuse if `/run/knowscroll/disk-critical` exists.
2. For stage/live: `git ls-remote https://github.com/KnowScroll/knowscroll refs/heads/<branch>` — the SHA must
   **equal the branch tip** (`validateDeployRequest` in `plan.ts`); dev accepts any SHA.
3. Refuse if `/etc/knowscroll/<world>.env` is missing ("not set up on this server yet").
4. `stdin`: unpack into `/srv/knowscroll/releases/.incoming-<sha>-<pid>`, verify `release.json.commit == sha`
   and every bundle's sha256, `chmod -R a+rX,go-w`, rename to `/srv/knowscroll/releases/<sha>`.
   `existing` (promote): refuse if `/srv/knowscroll/releases/<sha>/release.json` is absent.
5. `migratePool`: if `/etc/knowscroll/pool.env` and `dist/migrate-pool.mjs` exist, run it as OS user
   `postgres` with `KS_POOL_DATABASE_URL` from that file.
6. `runAsWorld(migrate)` then (not on live) `runAsWorld(seed)` — as OS user `ks-<world>`, cwd = release dir,
   env = parsed `/etc/knowscroll/<world>.env` + `NODE_ENV=production` + `KS_WORLD=<world>`, 10 min timeout.
7. Symlinks (atomic `rename` of a `.next` link): `/srv/knowscroll/<world>/previous` → old target (if different),
   `/srv/knowscroll/<world>/current` → `/srv/knowscroll/releases/<sha>`.
8. `systemctl enable ks-world@<world>.target` + `systemctl restart ks-world@<world>.target`.

### 3.4 Health check and rollback

- Health: poll `http://127.0.0.1:<PORT from world env>/health` for up to 90 s until
  `body.commit == sha && body.world == world`.
- Healthy → append `{at, commit, result: deployed, from}` to `/srv/knowscroll/<world>/releases.log`, then `cleanup(false)`.
- Unhealthy → relink `current` back to the previous target, restart the target (or stop it if there was no
  previous good release), log `failed-and-rolled-back`, exit 3 (`Refusal`). **Migrations are not rolled
  back** — a migration that ran stays applied to the world DB **[inference from code: no down-migration step]**.
- Manual: `ks rollback <world>` swaps `current`/`previous` and restarts (root only; not exposed via ks-gate).
- After that GitHub checks from outside (`app.<world>` and `backend.<world>` `/health`).

### 3.5 Where releases live / retention

- `/srv/knowscroll/releases/<sha>/` (shared by all worlds). Retention (`releasesToDelete`, `KEEP_UNUSED_RELEASES = 3`):
  never delete any release that is `current` or `previous` of live/stage/dev; of the rest keep the 3 newest
  (2 in `--emergency`). `.incoming-*` and `<world>/media/tmp/*.tmp` older than a day are removed.
  Emergency cleanup also runs `journalctl --vacuum-size=500M`.
- `ks-cleanup.timer` / `ks-disk-guard.timer` (Ansible role `ops-tools`) run these periodically (see §4/§5).
- Disk guard thresholds (`diskGuardDecision`): ≥80 % warn; ≥90 % critical → deploys refused, pauses
  `ks-generation@dev`, `ks-generation@stage`, `ks-cutroom@pool`, emergency cleanup; clears below 85 %.

---

## 4. VPS live state (read-only inspection, 2026-10-19 ~12:47 UTC, `ssh knowscroll-vps`)

### 4.1 Host

- `srv2036699`, **Ubuntu 26.04.1 LTS**, kernel `7.0.0-38-generic`, up 1 day 18 h, load 0.00 (`hostname; cat /etc/os-release; uptime`).
- **2 vCPU** (`nproc`), **7,935 MiB RAM** (≈1,139 used, ≈6,796 available), **4 GiB swap file** (0 used), `vm.swappiness = 10` (`free -m`, `swapon --show`, `sysctl`).
- Disk: `/dev/sda1` ext4 96 G, **9.4 G used (10 %)**, 87 G free (`df -hT /`; `ks status` says 9.7 %).
- Agent access: `ssh knowscroll-vps` = root@187.126.119.96 with `~/.ssh/knowscroll_vps_agent` (`~/.ssh/config` on the Mac). sshd drop-in `/etc/ssh/sshd_config.d/00-knowscroll.conf`: `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin prohibit-password`.

### 4.2 systemd units (`systemctl list-units --type=service --all | grep -i -E 'ks|knowscroll|cutroom|caddy|postgres'`)

All active/running: `ks-api@dev`, `ks-api@stage`, `ks-worker@dev|stage`, `ks-maintenance@dev|stage`,
`ks-generation@dev|stage`, `ks-cutroom@pool`, `caddy`, `postgresql@16-main` (`postgresql.service` is the
usual exited wrapper). Oneshots `ks-cleanup.service`, `ks-disk-guard.service` (inactive between timer runs).
Targets/slices: `ks-world@dev.target`, `ks-world@stage.target` (both enabled), `ks.slice`, `ks-dev.slice`,
`ks-stage.slice`, `ks-cutroom.slice`. `ks-cutroom@pool.service` is enabled. `docker.service`/`containerd.service`
are installed but **disabled/inactive** (Ansible `base` role stops them; `/etc/cron.d/docker-*-prune` are
leftover image cron lines that are harmless while docker is off).

Unit files (`systemctl cat`; all in `/etc/systemd/system/`, generated from `ops/vps/ansible/roles/worlds/templates/*.j2`, identical in shape):

| unit | ExecStart (cwd `/srv/knowscroll/%i/current`) | notes |
|---|---|---|
| `ks-world@.target` | — | `Wants=ks-api@%i ks-worker@%i ks-maintenance@%i ks-generation@%i`; `WantedBy=multi-user.target` |
| `ks-api@.service` | `/usr/bin/node --enable-source-maps dist/api.mjs` | `User/Group=ks-%i`, `Slice=ks-%i.slice`, `EnvironmentFile=/etc/knowscroll/%i.env` **and** `/srv/knowscroll/%i/current/release.env`, `NODE_ENV=production`, `KS_WORLD=%i`, `Restart=on-failure`, `StartLimitBurst=5/600s`, `PartOf=ks-world@%i.target`, hardening (`ProtectSystem=strict`, `PrivateTmp`, `PrivateDevices`, `ProtectHome`, `NoNewPrivileges`, `RestrictNamespaces`…), `ReadWritePaths=/srv/knowscroll/%i/media` |
| `ks-worker@.service` | `… dist/worker.mjs` | same |
| `ks-maintenance@.service` | `… dist/maintenance.mjs` | same |
| `ks-generation@.service` | `… dist/generation.mjs` | same + `SupplementaryGroups=ks-pool` (reads Cutroom artifacts) |
| drop-ins `ks-<svc>@<world>.service.d/oom.conf` | — | `OOMScoreAdjust=500` (dev) / `200` (stage per group_vars) |
| `ks-cutroom@.service` | `/usr/local/lib/knowscroll/cutroom-run` (→ `node --experimental-strip-types apps/service/src/main.ts` with a FIFO on stdin) | `User=ks-cutroom`, `SupplementaryGroups=ks-pool`, `UMask=0027`, `Slice=ks-cutroom.slice`, `EnvironmentFile=/etc/knowscroll/cutroom-%i.env`, `KillSignal=SIGINT`, `ReadWritePaths=/srv/knowscroll/cutroom-%i`, `OOMScoreAdjust=300`, listens 127.0.0.1:8797 |
| `ks-dev.slice` | — | `CPUWeight=50`, `CPUQuota=100%`, `MemoryHigh=1200M`, `MemoryMax=1536M` |
| `ks-stage.slice` | — | `CPUWeight=100`, `CPUQuota=100%`, `MemoryHigh=1200M`, `MemoryMax=1536M` |
| `ks-cutroom.slice` | — | `CPUWeight=20`, `MemoryHigh=1536M`, `MemoryMax=2G` |
| `ks-cleanup.timer` | `ks cleanup` | daily 03:30 UTC ±10 min, `Persistent=true` |
| `ks-disk-guard.timer` | `ks disk-guard` | `OnBootSec=2min`, every 10 min |
| `caddy.service` | `/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile` | stock package unit (user `caddy`); `ExecReload=caddy reload … --force` |

Postgres has drop-in `postgresql@16-main.service.d/knowscroll.conf` with `OOMScoreAdjust=-900` (from Ansible; not re-read live).

### 4.3 Caddy — `/etc/caddy/Caddyfile` (root:root 0644, 98 lines, Caddy **v2.11.7**)

No credentials in it (scanned for basicauth/password/secret/token/key/bearer — none). Full content:

```caddyfile
# KnowScroll — managed by ops/vps/ansible (#201). Edits here are overwritten; change the template.
# Every name gets HTTPS automatically. APIs listen on 127.0.0.1 only; Caddy is the only door.

(security_headers) {
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
}

(api_proxy) {
	reverse_proxy {args[0]} {
		# Hold requests briefly while a world restarts, so a deploy shows no errors.
		lb_try_duration 5s
		lb_try_interval 250ms
	}
}

knowscroll.space, www.knowscroll.space {
	import security_headers
	redir https://app.knowscroll.space{uri} 302
}

# Live: placeholders until the live slice lands.
app.knowscroll.space {
	import security_headers
	root * /srv/knowscroll/placeholder/web
	file_server
}

backend.knowscroll.space {
	import security_headers
	header Content-Type application/json
	respond `{"status":"not-deployed","world":"live"}` 503
}

# dev
app.dev.knowscroll.space {
	import security_headers
	encode zstd gzip

	handle /v1/* {
		import api_proxy 127.0.0.1:4330
	}
	handle /health {
		import api_proxy 127.0.0.1:4330
	}
	handle /assets/* {
		root * /srv/knowscroll/dev/current/web
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}
	handle {
		root * /srv/knowscroll/dev/current/web
		header Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}

backend.dev.knowscroll.space {
	import security_headers
	encode zstd gzip
	import api_proxy 127.0.0.1:4330
}

# stage
app.stage.knowscroll.space {
	import security_headers
	encode zstd gzip

	handle /v1/* {
		import api_proxy 127.0.0.1:4320
	}
	handle /health {
		import api_proxy 127.0.0.1:4320
	}
	handle /assets/* {
		root * /srv/knowscroll/stage/current/web
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}
	handle {
		root * /srv/knowscroll/stage/current/web
		header Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}

backend.stage.knowscroll.space {
	import security_headers
	encode zstd gzip
	import api_proxy 127.0.0.1:4320
}
```

It is byte-for-byte what `ops/vps/ansible/roles/caddy/templates/Caddyfile.j2` renders from `group_vars/all.yml`
(compared by reading both). Observations: no websocket/`/socket.io` route exists; the web app is same-origin with
the API under `/v1/*`; static web is served from `current/web` so the web bundle switches atomically with the
`current` symlink. Certificates held (`/var/lib/caddy/.local/share/caddy/certificates/*/`): the 8 names above.

### 4.4 Listening ports (`ss -ltnp`, `ss -lunp`)

| port | bind | process |
|---|---|---|
| 22 | 0.0.0.0 / [::] | sshd |
| 80, 443/tcp, 443/udp (HTTP/3) | * | caddy |
| 2019 | 127.0.0.1 | caddy admin API |
| **4320** | 127.0.0.1 | node — `ks-api@stage` |
| **4330** | 127.0.0.1 | node — `ks-api@dev` |
| **8797** | 127.0.0.1 | node — `ks-cutroom@pool` |
| 5432 | 127.0.0.1, [::1] | postgres 16 |
| 53 | 127.0.0.53/54 | systemd-resolved |
| 65529/tcp, 1721/udp | 127.0.0.1 | `monarx-agent` (Hostinger's security agent) |
| 323/udp | loopback | chronyd |

Reserved by docs but unused today: **4310** (live API, `docs/operations/environments.md` "Adding the live world").
Workers, maintenance and generation have no listening port.

### 4.5 PostgreSQL

- `PostgreSQL 16.15 (Ubuntu 16.15-1.pgdg26.04+2)`, single cluster `16/main`, port 5432, data `/var/lib/postgresql/16/main` (`pg_lsclusters`); `/var/lib/postgresql` = 102 MB.
- Drop-in `/etc/postgresql/16/main/conf.d/knowscroll.conf`: `listen_addresses='localhost'`, `shared_buffers=1GB`, `max_connections=100`, `log_min_duration_statement=2000`.
- `pg_hba`: local peer for all; host 127.0.0.1/::1 `scram-sha-256`.
- Databases (`select datname, owner, size from pg_database`):

  | database | owner | size |
  |---|---|---|
  | `knowscroll_pool` | `ks_pool` | 7.8 MB |
  | `knowscroll_test_dev` | `ks_dev` | 18 MB |
  | `knowscroll_test_stage` | `ks_stage` | 19 MB |
  | `postgres`, `template0`, `template1` | postgres | — |

- Roles (non-`pg_*`): `ks_dev` (LOGIN, conn limit 20, `statement_timeout=30s`), `ks_stage` (same), `ks_pool` (NOLOGIN),
  `ks_pool_client` (NOLOGIN; members `ks_dev`, `ks_stage`), `postgres`. No superuser other than `postgres`;
  world roles have no CREATEDB/CREATEROLE.
- Live connections (`pg_stat_activity`): 3 per world DB + 1 per world to `knowscroll_pool` + background ≈ 14 of 100.
- The DB names include `_test_` (`knowscroll_test_dev/stage`) on purpose: `docs/plans/environments/02-architecture.md`
  ("Why stage and dev are named `knowscroll_test_*`") — v1 migration 0014's stand-in fence lets simulated Reels play only in
  databases with that prefix, and `scripts/scrolls/install-supply.ts` accepts only `knowscroll_test_*`/`knowscroll_demo_*`.
  Live is planned as database `knowscroll`, role `ks_live`. This is a v1 code rule; v2 is free to choose its own names.

### 4.6 Filesystem layout (`find /srv /opt /var/lib -maxdepth 3 …`, `stat`, `du -sh`)

```
/srv/knowscroll                         root:root 755
├── releases/<sha>/                     root 755; 6 releases, 225 MB total (~38 MB each): content/ dist/ packages/ web/ release.json release.env
├── dev/        (root 755)              current -> releases/106c4701…, previous -> releases/8982391f…, releases.log
│   └── media/  ks-dev:ks-dev 750       52 MB; sha256/<2-hex>/…  and tmp/
├── stage/      (root 755)              current -> releases/8982391f…, previous -> releases/349b24f7…, releases.log
│   └── media/  ks-stage:ks-stage 750   52 MB
├── placeholder/web/index.html          live placeholder
├── cutroom/                            178 MB: releases/<sha>, current -> releases/94ee04a1…, corepack/, pnpm-store/, .cache, .local
└── cutroom-pool/  ks-cutroom:ks-pool 2750   1.2 GB: data/ (0700 SQLite), artifacts/ (2750), QUESTIONS.md
/etc/knowscroll/            root 0700: dev.env (root:ks-dev 0640), stage.env (root:ks-stage 0640),
                            cutroom-pool.env (root:ks-cutroom 0640), pool.env (0644, no secret — peer-auth URL, content is in Git),
                            secrets/ (0700; not opened)
/etc/knowscroll-cutroom/    pool.budget.md
/usr/local/bin/ks, /usr/local/bin/ks-gate, /usr/local/lib/knowscroll-ops/{ks,plan,system}.ts,
/usr/local/lib/knowscroll/cutroom-run
/opt: only containerd (unused).   /var/lib: no knowscroll dirs.
```

Service users: `ks-dev` (uid 997, home `/srv/knowscroll/dev`, nologin), `ks-stage` (994), `ks-cutroom` (993),
`deploy` (1000, `/bin/sh`, password `*`). Group `ks-pool` = `ks-dev, ks-stage, ks-cutroom`.

Env var **names** in the world env files (extracted with a `sed` that printed only `KEY` names; no value was output or stored): `PORT DATABASE_URL KS_CSRF_SECRET KS_WEB_ORIGIN KS_MEDIA_ROOT
KS_MAIL_SENDER KS_POOL_DATABASE_URL KS_AUTO_PUBLISH_POLICY KS_SCROLL_TRANSPORT MINIMAX_API_KEY AGENTMAIL_API_KEY
AGENTMAIL_INBOX_ID KS_OWNER_EMAIL` (dev and stage identical); cutroom-pool.env: `CUTROOM_*` settings + `MINIMAX_API_KEY FAL_KEY`.
(These names also follow directly from the Ansible template in §5.)

### 4.7 journald

- `/etc/systemd/journald.conf` (non-comment lines): `SystemMaxUse=1G`, `SystemMaxFileSize=100M`, `MaxRetentionSec=7day`,
  `MaxFileSec=1day`, `Compress=yes` — **not** from the repo's Ansible (image/provider edit) **[origin unverified]**.
- Drop-in `/etc/systemd/journald.conf.d/knowscroll.conf` (Ansible `base`): `SystemMaxUse=1G`, `MaxRetentionSec=30day`
  — the drop-in wins, so effective retention is 30 days / 1 GB. `/usr/lib/systemd/journald.conf.d/syslog.conf` also present.
- `journalctl --disk-usage`: **134.2 M**.

### 4.8 Timers / cron / backups

- `systemctl list-timers --all`: `ks-disk-guard.timer`, `ks-cleanup.timer` plus stock Ubuntu timers (sysstat, apt-daily(-upgrade),
  logrotate, man-db, dpkg-db-backup, e2scrub/xfs_scrub, fstrim, update-notifier, tmpfiles-clean).
- `/etc/cron.d`: `docker-builder-prune`, `docker-image-prune`, `e2scrub_all`, `monarx-update`. No root crontab; no user crontabs.
- **There is no database backup of any kind on the VPS** (no timer, no cron, no dump directory). The docs plan backups only
  for the live world (environments.md "Adding the live world" step 4).

### 4.9 Firewall (`ufw status verbose`)

Active, default deny incoming / allow outgoing; allows 22/tcp, 80/tcp, 443/tcp, 443/udp (v4+v6). Nothing else.

### 4.10 Runtime versions

- Node **v22.23.3** from NodeSource (`nodejs 22.23.3-1nodesource1`, `/usr/bin/node`, only one node on PATH). Ansible `node` role
  keeps it at `state: latest` within `node_22.x` and asserts `22.x, minor ≥ 23`. Every unit uses `/usr/bin/node` — one Node for all worlds.
- Caddy 2.11.7 (cloudsmith repo, pinned by apt preference), PostgreSQL 16.15 (PGDG), ffmpeg 8.0.1, git 2.53.0.
- No pnpm/corepack globally except what `ks cutroom-install` uses via `corepack pnpm@10.15.1` with its own `COREPACK_HOME`.

### 4.11 The `ks` tool

- `/usr/local/bin/ks` is a 3-line sh wrapper: `exec /usr/bin/node --disable-warning=ExperimentalWarning /usr/local/lib/knowscroll-ops/ks.ts "$@"`
  (Node type stripping, no build). Its three `.ts` files and `/usr/local/bin/ks-gate` are **byte-identical to origin/dev**
  (sha256 compared: ks.ts `bf46b286…`, plan.ts `9095d74a…`, system.ts `f4016593…`, gate `82257f55…`).
- Help output (`ks` with no args):
  `usage: ks deploy|promote <world> <commit> | has-release <commit> | rollback <world> | status | cleanup [--emergency] | disk-guard | run <world> <program> [args] | cutroom-install <commit> | cutroom-restart`
- `ks run` is limited to programs `generation-cli`, `publication`, `install-supply` (`RUNNABLE_PROGRAMS` in plan.ts).
- Worlds are hard-coded: `type World = 'live' | 'stage' | 'dev'`; `BRANCH_OF = {dev:'dev', stage:'stage', live:'main'}`;
  `inUseReleases()`, `status()`, cleanup of `media/tmp` iterate only those three; `PAUSABLE` names only `ks-generation@dev|stage`
  and `ks-cutroom@pool`; `status()` only reports services `api, worker, maintenance, generation`.
- `ks status` now: disk 9.7 %, 6 releases, live `provisioned: false`; stage current `8982391f` (prev `349b24f7`) healthy;
  dev current `106c4701` (prev `8982391f`) healthy; all 4 services active in both; Cutroom revision `94ee04a1…`, `ready`, 0 open pool orders.
- Deploy entry point: user `deploy`, `/home/deploy/.ssh/authorized_keys` has two keys:
  `restrict,command="/usr/local/bin/ks-gate dev" ssh-ed25519 … knowscroll-deploy-dev@github-actions` and the same for `stage`.
  `/etc/sudoers.d/knowscroll-deploy`: `deploy ALL=(root) NOPASSWD: /usr/local/bin/ks has-release *, /usr/bin/flock --timeout 1800 /run/knowscroll/deploy.lock /usr/local/bin/ks *`.
  `/run/knowscroll` is recreated at boot by `/etc/tmpfiles.d/knowscroll.conf`.

### 4.12 Headroom and conflicts for adding v2 dev/stage processes

- **Memory:** actual use is small — `ks-dev.slice` ≈ 273 MB (peak 280 MB), `ks-stage.slice` ≈ 274 MB, `ks-cutroom.slice` ≈ 193 MB
  (peak 268 MB), Postgres ≈ 155 MB, Caddy ≈ 57 MB; ≈ 6.8 GB available. But the **configured ceilings** are already
  1.5 G + 1.5 G + 2 G = 5 G for slices, plus Postgres `shared_buffers=1GB`. Two more worlds at the same 1.5 G MemoryMax would let the
  ceilings sum past physical RAM (8 G + 4 G swap). Give v2 worlds smaller ceilings (e.g. MemoryHigh 700M / MemoryMax 1G) and set OOM
  scores so Postgres stays last.
- **CPU:** 2 vCPU; each world slice has `CPUQuota=100%` (one core). Cutroom's ffmpeg encodes are weighted low (20). Four worlds plus
  Cutroom will contend during encodes and CI deploy migrations; weights matter more than quotas.
- **Postgres connections:** 100 max, ≈14 used; world roles are capped at 20. pg-boss + Kysely pools in a Nest API + worker could open
  10–40 per world if left at library defaults — set explicit pool sizes and a role `CONNECTION LIMIT`.
- **Ports in use:** 4320, 4330, 8797, 5432, 2019, 65529 (+4310 reserved for live). Anything else on loopback is free.
- **Disk:** 87 GB free; releases ~38 MB each today. A Nest release that ships `node_modules` will be much larger (likely
  100–300 MB) **[estimate]**; still fine.
- **Hard conflict:** `ks cleanup` (runs after every deploy and nightly) deletes any release in `/srv/knowscroll/releases` that is not
  `current`/`previous` of live/stage/dev beyond the 3 newest. **A v2 release placed in the same folder could be deleted while it
  is running** unless `inUseReleases()` learns the new worlds. Likewise `validateDeployRequest` refuses unknown world names.

---

## 5. Ansible (`ops/vps/ansible` on origin/dev)

### 5.1 Files and how the Mac runs it

- `ansible.cfg`: `inventory = inventory.yml`, `interpreter_python=/usr/bin/python3`, `host_key_checking=True`, `pipelining=True`.
- `inventory.yml`: one host `knowscroll-vps`, `ansible_host: 187.126.119.96`, `ansible_user: root`,
  `ansible_ssh_private_key_file: ~/.ssh/knowscroll_vps_agent`.
- `site.yml`: one play on `knowscroll-vps`, roles in order **`base` → `postgres` → `node` → `caddy` → `worlds` → `cutroom` → `ops-tools`**.
- `run.sh`: `ops/vps/ansible/run.sh --check --diff` (preview) / `run.sh` (apply). Uses the venv at
  `$KS_DEV_ROOT/tools/ansible-venv` (default `KS_DEV_ROOT=/Volumes/Mrigesh SSD/knowscroll-dev`), sets
  `ANSIBLE_HOME=$KS_DEV_ROOT/ansible-home`, `ANSIBLE_LOCAL_TEMP`, `ANSIBLE_CONFIG`. Verified present on the Mac:
  `ansible-venv/bin/ansible-playbook`, `ansible [core 2.21.5]`, `~/.ssh/knowscroll_vps_agent`. Past run logs:
  `/Volumes/Mrigesh SSD/knowscroll-dev/logs/ansible-20261006T*.log`, `/Volumes/Mrigesh SSD/knowscroll-dev/tmp/ansible-{check,apply}-199.log`.
  Collections used: `community.postgresql`, `community.general` (ufw), `ansible.posix` (sysctl).
- `.ansible-lint` skips `var-naming[no-role-prefix]` and `no-handler`. No CI job runs ansible-lint or the playbook.
- Last change to `ops/vps/**` on dev: `cd168da6` (2026-10-08, #214). The server's `ks` files match dev (see §4.11), so the box is
  not drifted from the repo for the parts I compared (Caddyfile, unit templates, ks tool, gate, journald drop-in, pg conf).

### 5.2 `group_vars/all.yml` — keys

- `ks_worlds`: list of world dicts. Keys per world: `name`, `port`, `database`, `db_role`, `app_host`, `backend_host`,
  `memory_high`, `memory_max`, `cpu_weight`, `cpu_quota`, `oom_score_adjust`, `shared_pool`, `auto_publish_policy`, `scroll_supply`.
  - dev: port 4330, `knowscroll_test_dev`/`ks_dev`, app.dev/backend.dev, 1200M/1536M, weight 50, quota 100 %, OOM 500, shared_pool, `publication-v2`, scroll_supply.
  - stage: port 4320, `knowscroll_test_stage`/`ks_stage`, app.stage/backend.stage, 1200M/1536M, weight 100, OOM 200, same flags.
- `ks_live_app_host: app.knowscroll.space`, `ks_live_backend_host: backend.knowscroll.space`, `ks_apex_hosts: [knowscroll.space, www.knowscroll.space]`.
- `ks_world_services: [api, worker, maintenance, generation]`.
- `ks_cutroom_instance: pool`, `ks_cutroom_port: 8797`, `ks_cutroom_voice`, `ks_cutroom_reel_cap: "$0.75"`.
- `ks_deploy_keys: {dev: <ssh-ed25519 public key>, stage: <public key>}` — **public halves committed**; private halves are the
  GitHub environment secrets `KS_DEPLOY_SSH_KEY`.
- No vaulted/secret values in group_vars. Secrets live only on the server.

### 5.3 Roles — what each does

- **base**: apt packages (`acl ca-certificates curl gnupg jq openssl ufw python3-psycopg2 ffmpeg fonts-liberation build-essential`),
  4 G swap + `vm.swappiness=10`, docker/containerd stopped+disabled, ufw (22, 80, 443/tcp, 443/udp; default deny), unattended-upgrades
  hygiene (no auto reboot), journald drop-in (1 G / 30 days).
- **postgres**: PGDG repo, `postgresql-16`, conf.d `knowscroll.conf`, OOM drop-in `-900`; `/etc/knowscroll/secrets` (0700);
  per world generates `secrets/<world>/db_password` (`openssl rand -hex 24`) and `csrf_secret` (`rand -hex 32`) **on the server**
  (never leaves it; read only with `no_log`); creates role (`LOGIN,NOSUPERUSER,NOCREATEDB,NOCREATEROLE`, `conn_limit: 20`) and DB owned by it;
  `REVOKE CONNECT … FROM PUBLIC`, `GRANT CONNECT … TO <role>`, `ALTER ROLE … SET statement_timeout='30s'`; shared pool roles `ks_pool`/
  `ks_pool_client`, DB `knowscroll_pool`, grants to worlds with `shared_pool`; writes `/etc/knowscroll/pool.env` (peer-auth URL, no secret).
- **node**: NodeSource `node_22.x`, `state: latest`, asserts 22.x ≥ 22.23.
- **caddy**: cloudsmith repo + pin, `/srv/knowscroll/placeholder/web/index.html`, renders `Caddyfile.j2` with `validate: caddy validate`, notifies reload.
- **worlds**: group `ks-pool`; per world: user `ks-<world>` (nologin, home `/srv/knowscroll/<world>`), `/srv/knowscroll/releases`,
  `/srv/knowscroll/<world>`, `<world>/media` (0750, owned by the world user), placeholder `current` link until first deploy;
  requires hand-copied `/etc/knowscroll/secrets/shared/agentmail.env` (and `minimax.env` if any world has `scroll_supply`);
  **assembles `/etc/knowscroll/<world>.env` on the server** from `PORT`, `DATABASE_URL` (role + generated password + DB),
  `KS_CSRF_SECRET`, `KS_WEB_ORIGIN=https://<app_host>`, `KS_MEDIA_ROOT=/srv/knowscroll/<world>/media`, `KS_MAIL_SENDER=agentmail`,
  optional `KS_POOL_DATABASE_URL`, `KS_AUTO_PUBLISH_POLICY`, `KS_SCROLL_TRANSPORT=minimax` + minimax.env, then agentmail.env
  (`no_log`, mode 0640 root:ks-<world>); `ks.slice`, `ks-<world>.slice` (from `world.slice.j2`), the templated units
  `ks-api@`, `ks-worker@`, `ks-maintenance@`, `ks-generation@`, `ks-world@.target`; `oom.conf` drop-ins for
  `ks_worlds × ks_world_services`. **Services are not started by Ansible** — the first `ks deploy` enables/starts the world target.
- **cutroom**: user `ks-cutroom`, code dirs, `cutroom-pool/{data,artifacts}`, `/etc/knowscroll-cutroom/pool.budget.md`,
  `/usr/local/lib/knowscroll/cutroom-run`, assembles `/etc/knowscroll/cutroom-pool.env` from hand-copied
  `/etc/knowscroll/secrets/cutroom/providers.env`, `ks-cutroom.slice`, `ks-cutroom@.service`. Started only by `ks cutroom-install|restart`.
- **ops-tools**: `/etc/tmpfiles.d/knowscroll.conf` (`/run/knowscroll`), copies `ops/vps/tool/{ks,plan,system}.ts` to
  `/usr/local/lib/knowscroll-ops/`, `/usr/local/bin/ks` wrapper, `ops/vps/gate.sh` → `/usr/local/bin/ks-gate`, user `deploy`,
  `authorized_keys` from `ks_deploy_keys` (one `restrict,command="/usr/local/bin/ks-gate <world>"` line per key), sudoers
  `knowscroll-deploy`, cleanup/disk-guard units + timers.

### 5.4 How a world is defined; how new services/DBs are expected to be added

- A world = one entry in `ks_worlds` + one `ks_deploy_keys` entry + (for the `ks` tool) membership in the hard-coded `World` union,
  `BRANCH_OF`, cleanup/status loops in `ops/vps/tool/*.ts` + a `push` branch in `deploy.yml` + a GitHub environment holding that
  world's `KS_DEPLOY_SSH_KEY` + DNS records for `app_host`/`backend_host`.
- The documented recipe for adding a world is environments.md "Adding the live world": add to `ks_worlds` (port, DB, role, budget),
  create the deploy key + environment secret, add the branch to `deploy.yml`, (backups for live), then run `ops/vps/ansible/run.sh --check --diff`
  then `run.sh`; "A second run should report `changed=0`".
- New per-world **services** are added by (a) a new `ks-<svc>@.service.j2` template in `roles/worlds/templates/`, (b) adding it to the
  template loop in `roles/worlds/tasks/main.yml`, (c) adding it to `ks_world_services` (oom drop-ins) and to `Wants=` in
  `ks-world@.target.j2`, and (d) adding it to `status()` in `system.ts`. The service set is **global** — every world gets the same
  services (`ks_world_services` is not per world), which matters if v1 worlds and v2 worlds need different service sets.
- New **databases/roles** go through the `postgres` role loop over `ks_worlds` (one DB + one role per world; passwords generated on the
  server). A second DB per world (e.g. a separate pg-boss DB) has no existing pattern other than the shared-pool special case.
- Host-wide Ansible runs touch every role, including Caddy reload and Postgres restart on config change (handler `Restart postgres`
  fires only when its conf files change). A careless edit to shared templates (units, Caddyfile) applies to the running v1 worlds too.

---

## 6. DNS and hosts (checked from the Mac with `dig +short` and `curl -sS -o /dev/null -w '%{http_code}' https://<host>/health`)

| host | A | AAAA | GET /health |
|---|---|---|---|
| knowscroll.space | 187.126.119.96 | — | 302 (→ app.knowscroll.space) |
| www.knowscroll.space | CNAME knowscroll.space → 187.126.119.96 | — | 302 |
| app.knowscroll.space | 187.126.119.96 | — | 404 (placeholder file server) |
| backend.knowscroll.space | 187.126.119.96 | — | 503 (`{"status":"not-deployed","world":"live"}`) |
| app.dev.knowscroll.space | 187.126.119.96 | — | **200** |
| backend.dev.knowscroll.space | 187.126.119.96 | — | **200** |
| app.stage.knowscroll.space | 187.126.119.96 | — | **200** |
| backend.stage.knowscroll.space | 187.126.119.96 | — | **200** |
| api.knowscroll.space, api.dev…, media.dev…, v2.dev…, cutroom.knowscroll.space | NXDOMAIN | — | — |

- Nameservers: `byte.dns-parking.com`, `pixel.dns-parking.com` (Hostinger). **No wildcard** (`*.knowscroll.space` and a random
  `*.dev.knowscroll.space` name do not resolve). No AAAA records; no CAA record.
- Per the owner's earlier setup notes (memory `knowscroll-environments-vps.md`), the zone can only be edited in **hPanel** — every new
  hostname for v2 needs the owner (or someone with hPanel access) to add an A record. Caddy then gets the certificate automatically.
- Inside the server, `ks status` reported both world `/health` bodies as `{"status":"ok","database":true,"world":…,"commit":…}`.

---

## 7. Docs vs. the live box

### `docs/operations/environments.md` (last changed `cd168da6`, 2026-10-08) — **mostly accurate**

Accurate (matches §3–§5): world table and hosts; server facts (Ubuntu 26.04, 2 vCPU, 8 GB, 100 GB, key-only SSH, `00-knowscroll.conf`);
ufw 22/80/443; layout (`releases/<commit>`, `<world>/current|previous|media|releases.log`, `/etc/knowscroll/<world>.env` 0640);
Ansible run commands; deploy flow (`ks deploy` steps 1–6, no automatic DB rollback); promote.sh; rulesets `24594426`/`24608344`;
`promoters`; the Claude hook; `ks status/rollback`; cleanup/disk guard thresholds; Cutroom/pool paths, ports and commands.

Stale or incomplete:
- "Services per world: `ks-api`, `ks-worker` and `ks-maintenance`" — the box also runs **`ks-generation@<world>`** (the Cutroom section
  later in the same doc does mention it).
- "the APIs (4310/4320/4330) … listen on 127.0.0.1" — 4310 is only reserved; nothing listens on it.
- "Journal: capped at 1 GB and 30 days" — true for the effective config, but `/etc/systemd/journald.conf` itself carries other non-default
  values (7-day retention, 100 M files) that the drop-in partly overrides; not mentioned.
- The by-hand deploy example `ssh knowscroll-vps "flock /run/knowscroll/deploy.lock ks deploy dev <commit>"` omits `--timeout`, unlike the gate.
- Nothing says `checks` re-runs on every stage/main push (redundant 12–16 min runs), or that the deployed tarball is a second build, not the smoke-tested one.
- "Going private later" correctly notes `ks deploy` uses public HTTPS `git ls-remote`.

### `docs/operations/deployment.md` (last changed `f6e0eb86`, 2026-10-07) — **about the owner's Mac install, not the VPS**

It describes the owner's local installation (Postgres on `127.0.0.1:55432`, API on 4310, `pnpm dev:api`, backups to `$KS_DEV_ROOT/backups`,
restore-by-rename). Its own first paragraph says this stays the owner's installation "until the live world on the VPS replaces it". Stale points:
"The API … refuses `NODE_ENV=production` (`apps/api/src/main.ts`), so it runs in development mode on this machine" — on the VPS the API runs with
`NODE_ENV=production` (unit files; smoke-release.mjs) and "A release phone reaches it only through … `KS_RELEASE_API_BASE`; nothing in this repository
provides that endpoint" predates backend.dev/stage. The env-var table lacks `KS_WORLD`, `KS_COMMIT`, `KS_POOL_DATABASE_URL`, `KS_AUTO_PUBLISH_POLICY`,
`KS_SCROLL_TRANSPORT`. The backup/rollback discipline (ADR-0047: verified backup before every migrate) is **not implemented on the VPS** for dev/stage.

### `docs/operations/development.md` (last changed `dbcadae7`, 2026-10-05) — **Mac development only**

Describes SSD layout, `scripts/env.sh`, `dev-init.sh`, local Postgres 55432, API 4310, Android emulator/`adb reverse`, journeys. Nothing in it describes the VPS;
nothing contradicts the box. It is v1-specific (Android/Gradle, Fastify API, `tsx` scripts) and will need a v2 rewrite (Expo, Nest, pg-boss).

---

## 8. Other facts that matter for v2

- Branch ancestry holds: `main (e5fdc319) ⊆ stage (8982391f) ⊆ dev (106c4701)` (`git merge-base --is-ancestor`). stage is 19 commits ahead of main.
- **`origin/main` has no `ops/vps/` at all** and only `checks.yml` (no deploy.yml); `stage` and `dev` have identical `ops/vps`, `.github`,
  `promote.sh`, `build-release.mjs`. The local checkout `/Volumes/Mrigesh SSD/knowscroll-product` is on `main` (stale) with an uncommitted
  change to `packages/db/src/composer/semantic.ts` — **`ops/vps/ansible/run.sh` cannot be run from it**; Ansible copies `ks.ts`/`gate.sh` from
  whatever checkout runs it (`{{ playbook_dir }}/../tool`), so running it from a stale or divergent branch would silently roll the server tool back.
- Media today is served by the API, not Caddy: `GET|HEAD /v1/media/:sha256` (`apps/api/src/routes/media.ts`, `apps/api/src/media/stream.ts`,
  ADR-0024) — authorized in one short DB transaction, then streamed with single-range `Range` support (206/416), content-addressed under
  `KS_MEDIA_ROOT/sha256/<2 hex>/…`. Caddy just proxies `/v1/*`.
- No websocket/SSE exists in v1 (`git grep` for websocket/socket.io/event-stream in `apps/api/src`, `apps/web/src`: none).
- The current API is Fastify 5 bundled by esbuild; the release has no `node_modules`; both `build-release.mjs` and `smoke-release.mjs`
  **enforce** "no node_modules" — v1-specific rules a `nest build` release cannot satisfy.
- `ks deploy` runs `seed` on every dev/stage deploy, and runs the shared pool's migrations first (`migratePool`, skipped if the release has no
  `dist/migrate-pool.mjs`).
- One global deploy lock: `ks-gate` wraps every deploy/promote in `flock --timeout 1800 /run/knowscroll/deploy.lock` — v1 and v2 deploys would queue
  behind each other (fine; just slower when both fire).

---

## Implications for v2

### A. Shape: add v2 as two *new worlds* on the same rails, not a parallel pipeline

Everything the v1 pipeline does is world-generic in spirit (branch → GitHub environment → per-world deploy key → `ks-gate <world>` →
`ks deploy|promote` → release folder by SHA → `current`/`previous` symlinks → `ks-world@<world>.target` → `/health {commit, world}` →
outside check). v2 should plug into the same rails as worlds of its own. Example names (owner may rename):

| | v2 dev | v2 stage |
|---|---|---|
| world / branch | `v2dev` / `v2-dev` | `v2stage` / `v2-stage` |
| Linux user | `ks-v2dev` | `ks-v2stage` |
| Postgres DB / role | `knowscroll_v2dev` / `ks_v2dev` | `knowscroll_v2stage` / `ks_v2stage` |
| media dir | `/srv/knowscroll/v2dev/media` (0750) | `/srv/knowscroll/v2stage/media` |
| API port (Nest HTTP + Socket.IO on the same server) | **4430** | **4420** |
| worker | Nest standalone, no port (optional loopback health port 4431/4421) | same |
| hosts | `app.v2dev.knowscroll.space`, `backend.v2dev.knowscroll.space` | `app.v2stage…`, `backend.v2stage…` |
| slice | `ks-v2dev.slice` (MemoryHigh ~700M, MemoryMax ~1G, CPUWeight 50) | `ks-v2stage.slice` (same, weight 100) |

World names without hyphens keep systemd slice nesting and Postgres identifiers simple. These names are new, so nothing touches
`knowscroll_test_dev`, `knowscroll_test_stage`, `knowscroll_pool`, or `/srv/knowscroll/{dev,stage}/media`. Ports 4420/4430 are free (§4.4).

### B. Server changes required before the first v2 deploy (all in `ops/vps`, applied with `run.sh --check --diff` then `run.sh`)

1. **`ks` tool (`ops/vps/tool/plan.ts`, `system.ts`)** — mandatory, and **the first thing to change**:
   - add the v2 worlds to `World`/`WORLDS`/`BRANCH_OF` (`v2dev → v2-dev` any SHA like dev; `v2stage → v2-stage` tip-only like stage). Better:
     read the world list from a file Ansible writes (e.g. `/etc/knowscroll/worlds.json`) so the tool stops hard-coding worlds;
   - **`inUseReleases()` must include the v2 worlds' `current`/`previous`**, or v2 releases must live in their own root
     (e.g. `/srv/knowscroll/v2/releases`). Otherwise `ks cleanup` (after every deploy and nightly) can delete a running v2 release;
   - per-world program commands: `runAsWorld` runs `node dist/<program>.mjs`. A v2 release needs its own migrate/seed entry points
     (e.g. `node apps/api/dist/migrate.js`). Put them in the release manifest (`release.json` → `{"programs": {"migrate": …, "seed": …}}`)
     so `ks` stops assuming the v1 layout;
   - `status()`, media `tmp` cleanup, and `PAUSABLE` should loop over all worlds and their own service lists;
   - `healthy()` already works if the v2 API answers `GET /health` on `PORT` with `{commit, world}` (`KS_COMMIT` from `release.env`,
     `KS_WORLD` from the unit). Keep that contract in Nest.
2. **Ansible**: add a v2 world list (e.g. `ks_v2_worlds`) and a v2 unit family, instead of adding v2 to `ks_worlds`. The reason: `ks_world_services`
   is global and the v1 unit templates hard-code `dist/api.mjs` etc. Proposed templates: `ks2-api@.service` (`ExecStart=/usr/bin/node --enable-source-maps apps/api/dist/main.js`
   or whatever path `nest build` emits; same hardening; `ReadWritePaths=/srv/knowscroll/%i/media`; `EnvironmentFile=/etc/knowscroll/%i.env` +
   `/srv/knowscroll/%i/current/release.env`), `ks2-worker@.service`, `ks2-world@.target`; slices from the existing `world.slice.j2`; users, DBs,
   roles and generated secrets by reusing the `postgres` and `worlds` task patterns over the new list. Set the role `CONNECTION LIMIT` (e.g. 30) and
   size Kysely + pg-boss pools explicitly so that v1 + v2 stay well under `max_connections=100`. pg-boss can live in the world DB (its own `pgboss`
   schema; the role owns the DB, so it can create it).
3. **Env files** assembled on the server the same way (no secret in Git or Ansible output). Decide per v2 world which shared secrets it gets
   (`agentmail.env`, `minimax.env`), and whether it may reach Cutroom (see E).
4. **deploy user**: add one `ks_deploy_keys` entry per v2 world (public half in `group_vars/all.yml`); `ks-gate` and sudoers need no change.
5. **Caddy** (`Caddyfile.j2`), per v2 world. Caddy proxies websocket upgrades by itself; no extra config needed:
   ```caddyfile
   app.v2dev.knowscroll.space {
   	import security_headers
   	@compressible not path /socket.io/* /v1/media/*
   	encode @compressible zstd gzip

   	handle /socket.io/* {
   		reverse_proxy 127.0.0.1:4430 {
   			# keep sockets open across a Caddy reload instead of dropping all at once
   			stream_close_delay 5m
   		}
   	}
   	handle /v1/* {
   		import api_proxy 127.0.0.1:4430
   	}
   	handle /health {
   		import api_proxy 127.0.0.1:4430
   	}
   	handle /_expo/* {
   		root * /srv/knowscroll/v2dev/current/web
   		header Cache-Control "public, max-age=31536000, immutable"
   		file_server
   	}
   	handle /assets/* {
   		root * /srv/knowscroll/v2dev/current/web
   		header Cache-Control "public, max-age=31536000, immutable"
   		file_server
   	}
   	handle {
   		root * /srv/knowscroll/v2dev/current/web
   		header Cache-Control "no-cache"
   		try_files {path} {path}.html /index.html
   		file_server
   	}
   }

   backend.v2dev.knowscroll.space {
   	import security_headers
   	import api_proxy 127.0.0.1:4430
   }
   ```
   (A sketch, not validated with `caddy validate`. Run it through the role's `validate:` step.)
   (`try_files {path}.html` covers an expo-router static export; plain SPA export needs only `/index.html`. Check which one the Expo config emits.)
   With one API process per world, Socket.IO needs no sticky sessions. If a world ever runs more than one API process, use sticky load balancing
   or a Postgres adapter. Prove websocket upgrade, reconnect after `ks deploy` restarts the API, and long-polling fallback in a v2 smoke test.
6. **Authenticated media range delivery** — two workable options:
   - *(recommended first)* the same approach as v1 ADR-0024: Nest authorizes, then streams the file with single-range `Range`/`HEAD`/416
     (port `apps/api/src/media/stream.ts` semantics). Caddy only proxies `/v1/media/*` (excluded from `encode` above). No permission changes.
   - *(if throughput needs it)* Caddy `forward_auth 127.0.0.1:4430 { uri /v1/media-auth/{path} }` followed by `file_server` from
     `/srv/knowscroll/v2dev/media`. Caddy serves `Range` natively, but the `caddy` user then needs read access (a media group with setgid
     dirs, 2750), and each range request costs one auth subrequest.
7. **Memory/CPU budget:** v2 ceilings must fit next to v1's (5 G of slice ceilings + 1 G `shared_buffers` on 7.9 G RAM). Give v2 worlds about 1 G
   MemoryMax each and OOMScoreAdjust ≥ v1 dev's. Optionally lower v1 dev/stage ceilings (they use about 275 MB). Postgres stays at -900.
8. **Node:** the box has one Node (22.23.3, NodeSource 22.x, asserted by the `node` role). If v2 targets Node 22 it fits as is. If v2 needs
   Node 24, use a second Node in its own path for v2 units only (e.g. `/opt/node-24/bin/node` via Ansible). Do not bump the global one under v1.

### C. Artifact identity dev → stage (build once, never rebuild)

The v1 pipeline already never rebuilds for stage: the server keeps `/srv/knowscroll/releases/<sha>` and `ks promote` reuses it. **But the dev build is
not the smoke-tested build**: `checks` builds and smoke-tests one tarball and throws it away, then `deploy` builds another from the same SHA. For v2:

1. In `v2-checks` (push + PR), build the release once: `nest build` for the API and worker, the Expo web export, migrations, `release.json` with
   per-file sha256 plus a programs map, and `release.env`. For the production `node_modules`, use something like `pnpm deploy --prod` for API/worker,
   built on ubuntu-latest with the same Node major as the server so native addons match. Smoke-test that exact tarball (fresh DB, migrate, start
   API in production mode, `/health {commit, world}`, a 401, a websocket handshake, a media 206). Upload it as a workflow artifact
   `release-<sha>` (+ `.sha256`) with a modest `retention-days`.
2. Make `v2-deploy` a copy of deploy.yml's shape, with one change. Keep: resolve SHA, wait for `v2-checks.yml` success on that SHA,
   `has-release`, `deploy|promote`, and the outside `/health` check. Change: **download the artifact** from the green checks run
   (`gh run list --workflow v2-checks.yml --commit $SHA --json databaseId` then `gh run download <id> -n release-$SHA`, verify sha256)
   instead of rebuilding.
3. Promotion to v2stage = fast-forward push of v2dev's healthy SHA (extend `scripts/promote.sh` with a `v2stage` target that reads
   `backend.v2dev…/health`). The push triggers `ks promote v2stage <sha>`, which reuses the server copy, so the bytes are identical.
4. Make identity visible: have `/health` (or `ks status`) also report the tarball sha256 and write it into `releases.log`.
5. Keep a different workflow filename (`v2-checks.yml`): v1's `deploy.yml` polls `checks.yml` by name.

### D. Workflows: reuse vs replace

- **Reuse:** deploy.yml's structure (environment-per-world, concurrency `deploy-<world>` without cancel, wait-for-checks-on-SHA, ssh config from
  `KS_DEPLOY_SSH_KEY` + repo vars `KS_DEPLOY_HOST`/`KS_DEPLOY_KNOWN_HOSTS`, `has-release`/`deploy`/`promote`, outside health check), the
  pinned action SHAs, pnpm 10.30.3 / Node 22.23.0 pins, the postgres:16 service-container pattern, `promote.sh`'s fast-forward + checks gate, the Claude
  hook (it already blocks main for any branch layout).
- **Replace for v2:** `build-release.mjs` (esbuild, no node_modules) → a v2 release builder; `smoke-release.mjs` → v2 smoke including Socket.IO + media
  range; all v1 journey steps (`scripts/run-*-journey.ts`, Vite web journeys, Android Gradle job) → v2 equivalents (Nest e2e, Expo web export check,
  Playwright against the exported web build; Expo native builds are a separate question, since EAS or local Gradle is not covered by today's CI).
- **Where v2 code lives (owner decision):**
  - *Option 1 (recommended): long-lived branches `v2-dev` / `v2-stage` in the same repo, with their own `.github/workflows/v2-*.yml`.*
    GitHub runs the workflow files of the pushed commit. An orphan or cleaned v2 tree that does not carry v1's `checks.yml` will not run v1's
    15-minute suite, and v1's `deploy.yml` triggers only on `dev`/`stage`. PRs into `v2-dev` follow the normal squash flow.
  - *Option 2: v2 in a subfolder of `dev`.* Every v2 commit would then run v1's whole checks suite and redeploy v1 dev, and dev→stage promotion
    would couple v1 and v2. Not recommended.
  - *Option 3: separate repo.* Its own rulesets and environments. If private, `ks deploy`'s public `git ls-remote` tip check would need credentials.
- **Single source of truth for `ops/vps`:** the server tool and Ansible currently live on `dev`. Keep them in one place (land the v2-world support
  in `ops/vps` via a normal PR to `dev`, which also redeploys v1 dev harmlessly). Always run Ansible from an up-to-date checkout of that branch.
  Two branches carrying different `ks.ts` copies would overwrite each other on every Ansible run.

### E. Cutroom

The box runs one shared Cutroom (`ks-cutroom@pool`, 127.0.0.1:8797) whose spend record is the `knowscroll_pool` database, reached by v1 through
SQL functions granted to `ks_pool_client`. v2 must not write to `knowscroll_pool` with v1's schema assumptions. Options (owner decision on money):
- (a) a second Cutroom instance for v2: `ks-cutroom@v2` (the unit template is already `@`-instanced; Ansible `cutroom` role currently supports one
  `ks_cutroom_instance`). It would get its own port (e.g. 8798), data/artifacts dir, budget file and provider keys;
- (b) v2 talks to the existing Cutroom over HTTP with its own budget accounting. Cutroom restarts are refused while a paid order is open
  (`cutroomSwitchDecision`).

### F. Blockers / items that need the owner

1. **DNS (hPanel only, no wildcard):** A records → `187.126.119.96` for every v2 host (e.g. `app.v2dev`, `backend.v2dev`, `app.v2stage`, `backend.v2stage`).
   A single wildcard `*.knowscroll.space` record would avoid repeat requests (Caddy still issues certs only for configured names). Add the
   records before the Caddyfile names them, or Caddy keeps retrying ACME for those names.
2. **Rulesets** (repo admin): add the v2 branches to ruleset `24594426` (no deletion, no force-push) and the v2 stage branch to `24608344`
   (only `promoters` update it). Today **no required status checks exist on any branch, and dev has no PR requirement**. Decide whether
   v2 branches get required checks (`v2-checks` job contexts) and a PR rule.
3. **GitHub environments** `v2dev` (no branch policy, or `v2-dev` only) and `v2stage` (branch `v2-stage` only), each with its own `KS_DEPLOY_SSH_KEY`
   secret. A new key pair per world: the public half goes in `group_vars`, the private half goes only into the environment secret. Repo
   vars `KS_DEPLOY_HOST`/`KS_DEPLOY_KNOWN_HOSTS` can be reused.
4. **Permission to run Ansible against the box.** It reloads the shared Caddy, rewrites sudoers/authorized_keys and replaces the `ks` tool used by v1
   deploys. Always `--check --diff` first.
5. **Secrets for v2 worlds:** whether v2 shares the AgentMail inbox and the MiniMax token-plan key (`/etc/knowscroll/secrets/shared/*.env`), and
   whether it uses Cutroom (E). Provider keys get copied by hand once, like v1's.
6. **Memory budget** across four worlds + Cutroom on 8 GB (B.7), and whether v1 dev/stage keep running in full (e.g. their generation workers) during v2.
7. **Backups:** none exist on the VPS for any database today. Decide whether v2 stage gets a nightly `pg_dump` (dev/stage are disposable by design;
   live will need ADR-0047's verified pre-migration backup).
8. Pre-existing mismatch for whoever adds live later: deploy.yml would use environment `main`, but the protected environment is named `production`.

