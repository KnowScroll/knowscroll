# Program design: dev, stage and live on one VPS

Gate 3. Status: in progress. It builds on the approved Gates 1 and 2.

## Defaults recorded at Gate 2 approval (2026-10-06)

The owner approved Gate 2 without answering its questions one by one. The recommendations stand,
and the two questions that had no recommendation take these defaults, which the owner can still
override at this gate:

1. **Native systemd services**, not Docker Compose.
2. **Docker is stopped and disabled** (reversible).
3. **Mail (default):** one AgentMail inbox per world. Production mode already refuses any other
   sender (`apps/api/src/mail/magic-link-sender.ts`), and all three worlds run in production
   mode. No inbox is created without asking the owner first.
4. **Backups (default):** Hostinger's weekly snapshot, plus a nightly copy of live's backup pulled
   to the Mac SSD whenever the Mac is on. No new account or cost.
5. **A `promoters` org team** (`Legend101Zz`, `XZNON`) is the only bypass actor allowed to update
   `main` and `stage`.

## Owner changes at this review (2026-10-06)

1. **Build, don't run TypeScript in production.** CI bundles each program with esbuild; the server
   runs plain `node`. This replaces "tsx in production", which is no longer a least-confident
   decision.
2. **One PostgreSQL, a separate database per world**, confirmed as the owner's decision. It is no
   longer listed as a least-confident decision.
3. **Stage and dev share one pool of Cutroom Reels; live has its own.** That means two Cutroom
   services (`cutroom-live` and `cutroom-pool`), not three. Gates 1 and 2 are amended to match.
4. **The agent has full control of dev**: its database, secrets, services and resets, and
   deploying any commit there, not only `dev`'s tip.

Why bundling is safe here (verified): every runtime path is relative to the working directory, not
to the source file. That covers `resolve('packages/db/migrations')` in `scripts/migrate.ts`,
`resolve('.env')` and `content/`, and nothing uses `import.meta.url` or `__dirname`. A release
therefore keeps `packages/db/migrations/` and `content/` beside its bundles. Plain `tsc` output
would not work, because the workspace packages export their `.ts` sources. Node's built-in type
stripping would not work either, because three classes use constructor parameter properties
(`http-client.ts:86`, `runtime-policy.ts:79`, `generation/storage.ts:34`).

## What the code already does (verified 2026-10-06)

- `NODE_ENV=production` already requires a fixed `KS_CSRF_SECRET` (32+ bytes), `KS_WEB_ORIGIN`
  and the `agentmail` sender (`http/web-session.ts`, `mail/magic-link-sender.ts`).
- What blocks a server today:
  - `main.ts` refuses production outright;
  - `buildApp(developmentToken)` throws unless the token has 24+ characters
    (`apps/api/src/app.ts:51`);
  - Fastify is built without `trustProxy`.
- `/health` exists, needs no sign-in, and answers only when the database does
  (`routes/health.ts`).

## Files

### Product code (the only code changes outside `ops/`)

| File | Change | Why |
|---|---|---|
| `apps/api/src/main.ts` | Read the runtime config; in production, start without a dev token and refuse if one is set | Server mode (Gate 2, change 1) |
| `apps/api/src/http/runtime-config.ts` | **New.** One function that reads and validates the runtime settings, reporting every problem at once | Keeps `main.ts` a composition root |
| `apps/api/src/app.ts` | `developmentToken: string \| null`; `null` skips development-session enrolment; new `trustProxy` option passed to Fastify | No dev identity on a server; correct client IP behind Caddy |
| `apps/api/src/routes/health.ts` | Add `world` and `commit` to the response | Deploys and `ks-status` verify they're talking to the right build |
| `apps/web/vite.config.ts` | Replace `refuseProductionBuild()` with a check that `KS_WORLD` is `live`, `stage` or `dev`; define `import.meta.env.VITE_KS_WORLD` | Production build per world (change 2) |
| `apps/web/src/components/EnvironmentLabel.tsx` (+ css) | **New.** The Stage/Dev ribbon from the Gate 1 mockup; renders nothing for live | Environment label (change 4) |
| `apps/web/src/App.tsx` (or the shell component) | Mount `EnvironmentLabel` once | Label on every screen |
| `apps/mobile/app/build.gradle.kts` | Add two **build types**, `dev` and `stage` (initWith `release`, `applicationIdSuffix` `.dev`/`.stage`, test signing key, own `KS_API_BASE`, App Links host and app name), plus `KS_WORLD` in BuildConfig. `debug` and `release` stay as they are | Side-by-side installs (change 3) without renaming any existing Gradle task |
| `apps/mobile/app/src/main/kotlin/…/ui/theme/EnvironmentLabel.kt` | **New.** The same ribbon in Compose, drawn from `BuildConfig.KS_WORLD` | Label on Android |
| `apps/mobile/app/src/main/kotlin/…/ui/…` (root scaffold) | Mount the label once | Label on every screen |

### Build

| File | Purpose |
|---|---|
| `scripts/build-release.mjs` | **New.** esbuild bundles of `api`, `worker`, `generation`, `maintenance`, `migrate` and `seed` into `dist/*.mjs` (ESM, Node 22, source maps). `@knowscroll/*` are folded in and every npm dependency stays external. Writes `release.json`, then one tarball holding `dist/`, `packages/db/migrations/`, `content/`, `web/`, the phone build (dev/stage), `package.json` and `pnpm-lock.yaml` |
| `package.json` | Add `build:release` and an explicit `esbuild` dev dependency (already present through `tsx` and allowed in `onlyBuiltDependencies`) |

### Operations (new folder `ops/vps/`, never imported by the product)

| File | Purpose |
|---|---|
| `ops/vps/README.md` | Runbook: what runs where, how to deploy, promote, back up, restore and reset dev |
| `ops/vps/bootstrap.sh` | Idempotent server baseline as root (detailed below) |
| `ops/vps/world.sh` | `world.sh create <world>`: creates a world's user, database, role, folders, env file skeleton and units. Idempotent |
| `ops/vps/Caddyfile` | 8 hosts: redirects, static web, `/v1` and `/health` proxy, `/download`, `assetlinks.json` |
| `ops/vps/systemd/ks-@.slice`, `ks-api@.service`, `ks-worker@.service`, `ks-generation@.service`, `ks-world@.target` | Templated units; the instance is the world (`ks-api@live`). `ExecStart=node --enable-source-maps current/dist/api.mjs`, `WorkingDirectory=current` |
| `ops/vps/systemd/ks-cutroom@.service` | Instance `live` or `pool`. Runs upstream's own `apps/service/src/main.ts` from that Cutroom checkout, as upstream ships it |
| `ops/vps/bin/ks-deploy` | The only command the deploy key can run. Deploys one commit to one world (call stack below) |
| `ops/vps/bin/ks-backup` | Verified `pg_dump` of live (the `deployment.md` procedure as a script); used before migrations and nightly |
| `ops/vps/bin/ks-status` | Every world's version, health, last deploy, migrations and service state, on one screen |
| `ops/vps/bin/ks-reset` | Rebuild dev (or stage, only with `--confirm-stage`): drop, migrate, seed, scripted reader, re-import the pool's Reels. **Refuses `live`** |
| `ops/vps/bin/ks-standin-cutroom` | Starts or stops a temporary stand-in Cutroom for dev's free tests. It never touches `cutroom-pool` |
| `ops/vps/bin/ks-move-universe` | One-time move of the owner's universe into live, with the count comparison |
| `ops/vps/sudoers.d/knowscroll` | Exactly which commands `deploy` and `agent` may run as which user |
| `ops/vps/timers/ks-backup.timer` (+ service) | Nightly live backup |

### Repo workflow and docs

| File | Change |
|---|---|
| `.github/workflows/deploy.yml` | **New.** Builds the release and deploys after `checks` succeeds on a push to `dev`, `stage` or `main`. Also `workflow_dispatch` with any ref, **target dev only**, so the agent can try a feature branch in dev |
| `scripts/promote.sh` | **New.** Fast-forward promotion `dev → stage` or `stage → main`, with its checks |
| `scripts/seed-reader.ts` | **New.** A scripted reader that reads and keeps through the real API with an operator-issued session, so the real Cartographer forms places |
| `.claude/hooks/refuse-main-update.sh` + `.claude/settings.json` | **New.** Refuses agent Bash commands that would update `main` (decision 6) |
| `docs/decisions/0049-environments-on-one-vps.md` | **New ADR** recording Gates 1–2 |
| `docs/operations/environments.md` | **New.** Operator guide; links the runbook |
| `docs/operations/deployment.md`, `CONTRIBUTING.md`, `AGENTS.md`, `README.md` | Move from "PR to main, run on the Mac" to the new flow |

## Types and signatures

```ts
// apps/api/src/http/runtime-config.ts
export type World = 'live' | 'stage' | 'dev';

export type RuntimeConfig =
  | { mode: 'development'; port: number; developmentToken: string; trustProxy: false }
  | { mode: 'server'; port: number; developmentToken: null; trustProxy: '127.0.0.1';
      world: World; commit: string };

/** Throws RuntimeConfigError naming every problem, never only the first. Server mode
 *  (NODE_ENV=production) requires KS_WORLD and KS_COMMIT and refuses KS_DEV_TOKEN.
 *  Mail, CSRF and web-origin checks stay where they already are. */
export function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig;
export class RuntimeConfigError extends Error { readonly problems: readonly string[] }

// apps/api/src/app.ts
export function buildApp(
  developmentToken: string | null,         // null: no development session is enrolled
  options?: { /* existing */ trustProxy?: false | string; health?: { world: World | 'local'; commit: string } },
): FastifyInstance;

// GET /health — unchanged meaning, two added fields
type Health = { status: 'ok'; database: true; world: World | 'local'; commit: string };
```

```kotlin
// apps/mobile — BuildConfig, per build type
const val KS_WORLD: String          // "local" for debug, "live" for release, "dev" or "stage"
const val KS_API_BASE: String       // e.g. "https://backend.dev.knowscroll.space"
const val KS_APP_LINKS_HOST: String // e.g. "app.dev.knowscroll.space"

@Composable fun EnvironmentLabel(world: String = BuildConfig.KS_WORLD) // draws nothing for live/local
```

```sh
# ops/vps/bin — command contracts (exit 0 = done; nonzero = nothing half-applied, reason on stderr)
ks-deploy <dev|stage|live> <40-hex commit>   # reads the release tarball on stdin; dev accepts any commit
#   release.json: { commit, world, builtAt, node, bundles: string[], migrations: string[], web: true, apk?: string }
ks-backup live [--reason pre-deploy|nightly] # prints the verified backup path
ks-status [--json]
ks-reset <dev|stage> [--confirm-stage]       # refuses live
ks-move-universe --dump <file> --media <dir> --expect-counts <file>

# scripts/promote.sh — run by the agent (stage) or the owner/XZNON (live)
scripts/promote.sh stage   # dev's deployed, healthy commit → stage
scripts/promote.sh live    # stage's deployed, healthy commit → main
```

## Call stacks

### A deploy (push to `dev`, `stage` or `main`)

1. GitHub `checks` finishes on the pushed commit.
2. `deploy.yml` runs on `workflow_run` and continues only if **all** of these hold:
   - `conclusion == 'success'`;
   - `event == 'push'`;
   - `head_repository.full_name == github.repository`;
   - `head_branch` is in `{dev, stage, main}`.

   Without the repository check, a fork PR whose branch happens to be named `dev` could reach the
   deploy secrets. This is the known `workflow_run` trap.
3. It selects the GitHub Environment `dev`, `stage` or `production` (production waits for a
   reviewer).
4. It runs `pnpm build:release`: the esbuild bundles, plus `apps/web` built with
   `KS_WORLD=<world>`. For dev and stage it also runs `./gradlew :app:assembleDev` or
   `:app:assembleStage` with the test keystore secret.
5. `ssh deploy@187.126.119.96 ks-deploy <world> <sha> < release.tar`. The key's line in
   `authorized_keys` is `restrict,command="/usr/local/bin/ks-deploy-gate"`, and the gate reads
   `SSH_ORIGINAL_COMMAND`.
6. `ks-deploy`, as `deploy` with narrow sudo:
   1. Validates the world and commit. For stage and live, the commit must be the current tip of
      the world's branch (`git ls-remote`). Dev accepts any commit, because the agent may try
      branches there.
   2. Takes a lock, so only one deploy runs at a time on the whole box.
   3. Unpacks the tarball from stdin into `/srv/knowscroll/<world>/releases/<sha>`, checks that
      `release.json` names the same commit and world, and runs
      `pnpm install --prod --frozen-lockfile` there. Nothing is compiled on the server.
   5. **For live, if a migration is pending:** stops live's worker and generation, runs
      `ks-backup live --reason pre-deploy` and stops if verification fails.
   6. Runs `pnpm db:migrate` as the world's role.
   7. Points the `current` symlink at the release, restarts `ks-world@<world>.target` and polls
      `https://backend.<world>/health` until `commit` equals the deployed commit (90 s).
   8. If health fails, repoints `current` at the previous release and restarts. A migrated live
      database is never auto-restored; the job fails loudly and the owner decides, per
      `deployment.md`.
   9. Appends to `releases.log` and prunes all but the last 3 releases.

### A promotion

`scripts/promote.sh stage`:
1. Reads dev's deployed commit from `https://backend.dev…/health`.
2. Checks it is a descendant of `stage` (fast-forward only) and that `checks` is green on it.
3. `git push origin <sha>:stage`.
4. The push to `stage` triggers the deploy above.

`promote.sh live` does the same from stage to `main`. The ruleset admits that push only from the
`promoters` team, and the agent's hook refuses it in Claude sessions.

### A web request

1. Browser → `https://app.dev.knowscroll.space/v1/feed`.
2. Caddy terminates TLS and reverse-proxies to `127.0.0.1:4330`, adding `X-Forwarded-For`.
3. Fastify (trusting `127.0.0.1`) sees the real client IP, so the sign-in rate limits work per
   person.
4. The cookie session is read as on the Mac today.

### Moving the owner's universe (one time, live slice)

1. On the Mac: stop the API and worker, `pg_dump` with verification (`deployment.md` steps 1–3),
   and write per-table row counts to a file.
2. `scp` the dump, the counts file and `$KS_MEDIA_ROOT` to the server.
3. `ks-move-universe`:
   1. Restores into a scratch database and migrates it.
   2. Compares row counts. **Every table must match**, except rows that newer migrations add,
      which are listed explicitly.
   3. Renames the scratch database to `knowscroll` (live is empty before this) and copies media
      into live's folder, checking hashes.
4. The owner opens `app.knowscroll.space` and checks their universe.

## The server baseline (`bootstrap.sh`, as root, idempotent)

1. **Swap:** a 4 GiB swap file with `vm.swappiness=10`.
2. **Docker:** `systemctl disable --now docker.socket docker containerd` (left installed).
3. **Packages:**
   - PGDG repo, then `postgresql-16`;
   - NodeSource `node_22.x`, then `nodejs`, then corepack-enabled `pnpm@10.30.3`;
   - Caddy's official repo, then `caddy`;
   - `ffmpeg` (Ubuntu's 8.0.1), `build-essential`, `ufw`, `jq`.
4. **Firewall:** ufw denies incoming and allows 22, 80 and 443, enabled last. The SSH rule is
   checked before enabling.
5. **Postgres:** listens on `127.0.0.1` only, `shared_buffers=1GB`. Roles `ks_live`, `ks_stage`
   and `ks_dev` each own their own database and no other. `ks_stage` and `ks_dev` get
   `statement_timeout=30s` and `CONNECTION LIMIT 20`, so dev can't starve live.
6. **Users:** `deploy` (deploys only) and `agent` (operations); `ks-live`, `ks-stage` and `ks-dev`
   as no-login service users.
7. **Templates and folders:** systemd slices and units, `/srv/knowscroll`, `/etc/knowscroll`,
   `/var/backups/knowscroll`.
8. **Caddy:** with the Caddyfile. Certificates are issued on first request to each name.

## Test plan (each is a named check, written to fail before the code exists)

### Product code (CI, on every push)

- `runtime-config.test.ts`:
  - `server mode refuses KS_DEV_TOKEN`;
  - `server mode requires KS_WORLD and KS_COMMIT and names every missing setting at once`;
  - `server mode rejects a world other than live/stage/dev`;
  - `development mode is unchanged: it requires a 24-character token`.
- `app.test.ts` (extended):
  - `buildApp(null) enrols no development session and a bearer of the old token is 401`;
  - `with trustProxy 127.0.0.1, X-Forwarded-For is the rate-limit key`;
  - `without trustProxy, X-Forwarded-For is ignored`.
- `health.test.ts`: `/health reports world and commit`.
- Web vitest:
  - `EnvironmentLabel renders STAGE and DEV and renders nothing for live`;
  - `vite build refuses a missing or unknown KS_WORLD`.
- Android unit: `EnvironmentLabel draws for dev and stage only`.
- Android build (CI):
  - `assembleDev and assembleStage produce com.knowscroll.mobile.dev and .stage`;
  - `assembleDebug still produces the existing debug APK`, which guards every existing script;
  - read via `aapt2 dump badging`.
- `ops/vps` scripts pass `shellcheck` in CI.
- Release build (CI):
  - `build-release bundles start`: the bundled `migrate` and `api` run against CI's Postgres and
    `/health` answers;
  - `no bundle imports @knowscroll/* at runtime`;
  - `release.json names the built commit`.
- The existing suites keep running against source, unchanged.

### On the server (joined checks, run and recorded per slice)

- **Reachability and TLS:** all 8 names answer over HTTPS with a valid certificate; `knowscroll.space`
  and `www` redirect to `app.knowscroll.space`.
- **Correct build:** `/health` on each `app.` and `backend.` host reports the right world and the
  deployed commit.
- **Ports closed** (checked from the Mac): 4310–4330, 5432 and 8787–8807 refuse connections from
  outside.
- **Deploy key is fenced:** `ssh deploy@… 'ls'` is refused; `ks-deploy dev <sha not at dev's tip>`
  is refused.
- **Live backup gate:** a live deploy with a pending migration produces a verified backup before
  migrating. A deliberately corrupted backup stops the deploy before any migration.
- **Rollback:** a deploy whose health check fails returns the world to the previous commit,
  automatically.
- **Access separation:** the `agent` user cannot read `/etc/knowscroll/live.env` and cannot
  connect to database `knowscroll`. It can do anything in dev: read dev's env, use `psql` as
  `ks_dev`, restart, reset, and deploy any commit.
- **Shared pool:** a Reel in `pool-media` is readable by both stage and dev; dev's grant table
  holds no paid grant; `cutroom-live` is reachable only by live's user.
- **Promotion rules:**
  - a promotion that isn't a fast-forward is refused;
  - `promote.sh live` from a Claude session is refused by the hook;
  - a push to `main` by a non-`promoters` account is refused by the ruleset. This needs a test by
    Asrani-Aman or XZNON; otherwise it is recorded as unproved.
- **Phone:** the dev and stage APKs download from `/download` after sign-in, install beside each
  other, show their label and sign in by email to their own world.
- **Owner's universe:** after the move, per-table counts match the Mac's, the owner signs in at
  `app.knowscroll.space` and sees their places and Traces.

## Least confident decisions

1. **Android build types instead of product flavours.** Flavours are the textbook answer, but
   they rename every Gradle task (`assembleDebug` → `assembleLocalDebug`), which breaks
   `scripts/android-hands-on.py`, the journeys and CI. Build types add `assembleDev` and
   `assembleStage` and leave everything else alone. The cost: a world can't be combined with
   debug, so dev and stage builds are release-shaped, minified and signed with the test key.
2. **Bash for `ops/vps/bin/*`.** These are short, linear system steps where bash is most readable
   to an operator. TypeScript (like `ops/cutroom-host/host.ts`) would give tests and types but
   needs Node before Node is installed. Mitigated by `shellcheck`, `set -euo pipefail` and joined
   checks.
3. **esbuild bundles with npm packages left external.** Bundling everything would remove `pnpm
   install` from the server, but some npm packages misbehave when bundled. Keeping them external
   costs an install per deploy. The CI smoke test is the guard.
4. **A shared Reel pool across two databases.** Stage and dev each keep their own
   `generated_reel` rows over the same media files. If the two worlds' migrations diverge (dev
   ahead of stage), a pooled Reel must still import into both. The import rules live in #199.
5. **Naming stage and dev `knowscroll_test_*`** to reuse migration 0014's stand-in fence. It's
   precise, but it means those names must never be used for disposable test databases on this
   server (no test suite runs here).
6. **Auto-rollback restores code only.** A live migration plus a failed health check leaves the
   new schema with the old code. Forward-only migrations (ADR-0047) usually keep old code working
   on a newer schema, but not always. The deploy fails loudly and the owner restores from the
   verified backup if needed.
7. **The `promoters` team does nothing against the agent.** The agent uses `Legend101Zz` (decision
   6), so only the hook stops it, and only in Claude sessions on this Mac.
