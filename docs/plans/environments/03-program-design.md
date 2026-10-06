# Program design: dev, stage and live on one VPS

Gate 3. Status: **APPROVED 2026-10-07**. The owner approved it with the research changes and two
of their own (below). This file was rewritten that day so it reads as one design. The research
behind it is in `research/2026-10-06-gate3-options.md`.

## Owner decisions that shaped this design

| Date | Decision |
|---|---|
| 2026-10-06 | Gate 2 approved with the recommended answers: native systemd, Docker off, an AgentMail inbox per world (ask before creating), backups = Hostinger weekly snapshot + nightly pull to the Mac SSD, a `promoters` team |
| 2026-10-06 | **Build releases instead of running TypeScript through tsx in production** |
| 2026-10-06 | One PostgreSQL, a database per world |
| 2026-10-06 | Stage and dev share one Cutroom Reel pool (`cutroom-pool`); live has `cutroom-live` |
| 2026-10-06 | The agent has full control of dev |
| 2026-10-07 | **Android builds happen on the owner's Mac when the owner asks.** No CI Android builds. Prod Android (Google Play) is set up later, after the first Play release |
| 2026-10-07 | **Proper cleanup is part of the design**, so storage never piles up and crashes the server |
| 2026-10-07 | Research adopted: Android product flavours, full bundling, Ansible for setup, a TypeScript deploy tool, and improvements 1–7. Improvement 8 (in-app update prompt) is dropped because builds are local |

## What the code already does (verified 2026-10-06)

- `NODE_ENV=production` already requires a fixed `KS_CSRF_SECRET` (32+ bytes), `KS_WEB_ORIGIN`
  and the `agentmail` sender (`apps/api/src/http/web-session.ts`,
  `apps/api/src/mail/magic-link-sender.ts`).
- What blocks a server today:
  - `apps/api/src/main.ts` refuses production;
  - `buildApp(developmentToken)` throws unless the token has 24+ characters (`app.ts:51`);
  - Fastify has no `trustProxy`.
- `/health` needs no sign-in and answers only when the database does.
- Every runtime path is relative to the working directory: migrations, `.env` and `content/`.
  Nothing uses `import.meta.url` or `__dirname`. A full esbuild bundle was measured working
  (research note, item 3).

## Files

### Product code

| File | Change | Why |
|---|---|---|
| `apps/api/src/main.ts` | Read the runtime config; in production, start without a dev token and refuse if one is set | Server mode |
| `apps/api/src/http/runtime-config.ts` | **New.** Reads and validates runtime settings, reporting every problem at once | Keeps `main.ts` a composition root |
| `apps/api/src/app.ts` | `developmentToken: string \| null` (`null` enrols no development session); `trustProxy` and `health` options | No dev identity on a server; real client IP behind Caddy |
| `apps/api/src/routes/health.ts` | Add `world` and `commit` | Deploys verify they reached the right build |
| `apps/web/vite.config.ts` | Replace `refuseProductionBuild()`: production builds are allowed. **No world is baked into the bundle** | Build once, promote the same bits |
| `apps/web/src/world.ts` | **New.** Works out the world from `location.hostname` (`app.dev.` → dev, `app.stage.` → stage, `app.` → live, anything else → local) | One web bundle serves every world |
| `apps/web/src/components/EnvironmentLabel.tsx` (+ css) | **New.** The Stage/Dev ribbon from the Gate 1 mockup; nothing for live or local | Environment label |
| `apps/web/src/App.tsx` (shell) | Mount `EnvironmentLabel` once | On every screen |
| `apps/mobile/app/build.gradle.kts` | One flavour dimension `world`: `local`, `dev`, `stage`, `live`. Only `localDebug`, `devDebug`, `stageRelease` and `liveRelease` are enabled (`androidComponents.beforeVariants`). Per flavour: `applicationIdSuffix` (`.dev`, `.stage`), app name, `KS_API_BASE`, App Links host, `KS_WORLD` | Side-by-side apps, debuggable dev build (research item 1) |
| `apps/mobile/app/src/main/kotlin/…/ui/theme/EnvironmentLabel.kt` + root scaffold | **New.** The ribbon in Compose, from `BuildConfig.KS_WORLD` | Label on Android |
| 11 × `scripts/android-*.py`, `.github/workflows/checks.yml` | Task names and APK paths move to the `local` flavour (`assembleLocalDebug`, `outputs/apk/local/debug/app-local-debug.apk`, …) | Flavours rename tasks; one mechanical update |
| `scripts/android-world-build.sh` | **New.** On the Mac, when the owner asks: builds `devDebug` or `stageRelease` on the SSD, then installs it over `adb` or uploads it to that world's `/download` | Local builds |

### Build

| File | Purpose |
|---|---|
| `scripts/build-release.mjs` | **New.** esbuild bundles of `api`, `worker`, `generation`, `maintenance`, `migrate` and `seed`, **with every dependency inside** (ESM, Node 22, source maps). Then the web build, then `release.json`, then one tarball holding `dist/`, `packages/db/migrations/`, `content/` and `web/` |
| `package.json` | `build:release` script; explicit `esbuild` dev dependency (already allowed in `onlyBuiltDependencies`) |

### Server setup (`ops/vps/ansible/`, run from the Mac)

| File | Purpose |
|---|---|
| `ops/vps/ansible/site.yml`, `inventory.yml` | One playbook for the one server. Always previewed with `--check --diff` before it is applied |
| `roles/base` | 4 GiB swap; Docker disabled; ufw (22/80/443); unattended upgrades that also remove old kernels and unused packages; journald limits; time and locale |
| `roles/postgres` | PGDG PostgreSQL 16 on 127.0.0.1; `shared_buffers=1GB`; a role and database per world; `statement_timeout` and connection limits for dev and stage; `OOMScoreAdjust=-900` |
| `roles/node` | NodeSource 22 (`>=22.23`) |
| `roles/caddy` | Caddy from its official repo, plus the Caddyfile (8 hosts, `lb_try_duration` retries, `/download`, `assetlinks.json`) |
| `roles/worlds` | Users, folders, env-file skeletons (no values), systemd slices and templated units, sandboxing, the `pool-media` group |
| `roles/ops-tools` | Installs the bundled ops tool, the SSH gate, sudoers rules and the cleanup and backup timers |
| `roles/cutroom` | The `cutroom-pool` and `cutroom-live` checkouts at pinned revisions, plus `build-essential` for their SQLite driver |

### Deploy and operations tool (`ops/vps/tool/`, TypeScript, bundled to one file)

| File | Purpose |
|---|---|
| `ops/vps/tool/src/main.ts` | `ks <command>`: `deploy`, `rollback`, `status`, `backup`, `restore-test`, `reset`, `cleanup`, `disk-guard`, `move-universe`, `standin-cutroom` |
| `ops/vps/tool/src/*.ts` | One module per command, with pure decision functions and their unit tests (`node:test`) |
| `ops/vps/gate.sh` | About 10 lines. The deploy key's forced command: parses `SSH_ORIGINAL_COMMAND`, allows only `deploy <world> <sha>` and `promote-artifact`, then calls `ks` |

### Repo workflow and docs

| File | Change |
|---|---|
| `.github/workflows/deploy.yml` | **New.** After `checks` succeeds on a push to `dev`, build the release once and upload it to the server. Deploy it to the pushed world. `workflow_dispatch` with any ref, **dev only** |
| `scripts/promote.sh` | **New.** Fast-forward `dev → stage` or `stage → main`, then tells the server to reuse the release already there (no rebuild) |
| `scripts/seed-reader.ts` | **New.** A scripted reader through the real API with an operator-issued session, so the real Cartographer forms places in dev and stage |
| `.claude/hooks/refuse-main-update.sh` + `.claude/settings.json` | **New.** Refuses agent Bash commands that would update `main` |
| `docs/decisions/0049-environments-on-one-vps.md` | **New ADR** |
| `docs/operations/environments.md` | **New.** The operator guide |
| `docs/operations/deployment.md`, `CONTRIBUTING.md`, `AGENTS.md`, `README.md` | Move to the new flow |

## Types and signatures

```ts
// apps/api/src/http/runtime-config.ts
export type World = 'live' | 'stage' | 'dev';
export type RuntimeConfig =
  | { mode: 'development'; port: number; developmentToken: string; trustProxy: false }
  | { mode: 'server'; port: number; developmentToken: null; trustProxy: '127.0.0.1';
      world: World; commit: string };
/** Server mode = NODE_ENV=production: requires KS_WORLD and KS_COMMIT, refuses KS_DEV_TOKEN.
 *  Throws RuntimeConfigError naming every problem. Mail/CSRF/origin checks stay where they are. */
export function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig;
export class RuntimeConfigError extends Error { readonly problems: readonly string[] }

// apps/api/src/app.ts
export function buildApp(
  developmentToken: string | null,
  options?: { /* existing */ trustProxy?: false | string;
              health?: { world: World | 'local'; commit: string } },
): FastifyInstance;
type Health = { status: 'ok'; database: true; world: World | 'local'; commit: string };

// apps/web/src/world.ts
export type WebWorld = 'live' | 'stage' | 'dev' | 'local';
export function worldFromHostname(hostname: string): WebWorld;

// ops/vps/tool — release manifest, written by build-release, checked by `ks deploy`
type ReleaseManifest = { commit: string; builtAt: string; node: string;
  bundles: string[]; migrations: string[]; sha256: string };
```

```kotlin
// BuildConfig per flavour
const val KS_WORLD: String          // "local" | "dev" | "stage" | "live"
const val KS_API_BASE: String       // e.g. "https://backend.dev.knowscroll.space"
const val KS_APP_LINKS_HOST: String // e.g. "app.dev.knowscroll.space"
@Composable fun EnvironmentLabel(world: String = BuildConfig.KS_WORLD)
```

```sh
# ks — one tool on the server (exit 0 = done; nonzero = nothing half-applied, reason on stderr)
ks deploy <dev|stage|live> <sha>     # release tarball on stdin, or the release already on the server
ks rollback <world>                  # back to the previous release (code only)
ks status [--json]
ks backup live --reason pre-deploy|nightly
ks restore-test live                 # restore the latest backup into a scratch DB, compare counts, drop it
ks reset <dev|stage> [--confirm-stage]   # refuses live
ks cleanup [--emergency]             # see "Cleanup and stability"
ks disk-guard                        # run by a timer every 10 minutes
ks move-universe --dump <f> --media <d> --expect-counts <f>
ks standin-cutroom start|stop        # dev only
```

## Call stacks

### A deploy to dev (push to `dev`)

1. `checks` succeeds on the pushed commit.
2. `deploy.yml` runs on `workflow_run` **only if** all of these hold:
   - `conclusion == 'success'`;
   - `event == 'push'`;
   - `head_repository.full_name == github.repository`;
   - `head_branch` is in `{dev, stage, main}`.

   Without the repository check, a fork PR whose branch is named `dev` could reach the deploy
   secrets.
3. A concurrency group per world: a newer dev deploy cancels an older one still in flight.
4. `pnpm build:release` (pnpm store cached) produces `release-<sha>.tar` and its `sha256`.
5. `ssh deploy@187.126.119.96 deploy dev <sha> < release.tar`. The key is
   `restrict,command="/usr/local/bin/ks-gate"`; the gate validates the command and calls `ks`.
6. `ks deploy dev <sha>`:
   1. **Disk check:** refuse if the disk-critical flag is set.
   2. Take the box-wide deploy lock.
   3. Unpack to `/srv/knowscroll/releases/<sha>/`, shared by all worlds (one copy per commit).
      Verify `release.json` and the tarball hash.
   4. Run migrations as `ks_dev`.
   5. Point `/srv/knowscroll/dev/current` at the release and restart `ks-world@dev.target`.
      Caddy holds requests for up to 5 s, so nobody sees an error.
   6. Poll `https://backend.dev…/health` until `commit` matches (90 s). On failure, point
      `current` back at the previous release and restart.
   7. Append to `releases.log`, then run release cleanup.

### Promotion (no rebuild)

`scripts/promote.sh stage`:
1. Reads dev's healthy commit from `/health`.
2. Checks it fast-forwards `stage` and that `checks` is green on it.
3. `git push origin <sha>:stage`.
4. The push triggers `deploy.yml`, which finds the release already on the server (`ks deploy
   stage <sha>` without a tarball) and only links and restarts it.

Stage now runs **the same bytes** that passed in dev. `promote.sh live` does the same into
`main`. The ruleset admits that push only from the `promoters` team, the agent's hook refuses it in
Claude sessions, and the `production` environment waits for a reviewer. Live also runs `ks backup
live --reason pre-deploy` before any migration and stops if the backup can't be verified.

### A web request

1. Browser → `https://app.dev.knowscroll.space/v1/feed`.
2. Caddy terminates TLS and proxies to `127.0.0.1:4330` (`X-Forwarded-For`, retries during a
   restart).
3. Fastify trusts `127.0.0.1` and sees the real client IP, so sign-in rate limits work per person.
4. `worldFromHostname` shows the DEV ribbon.

### Moving the owner's universe (one time, in the live slice)

1. On the Mac: stop the API and worker, take a verified `pg_dump` (`deployment.md` steps 1–3),
   and write per-table counts.
2. `scp` the dump, the counts and the media to the server.
3. `ks move-universe`:
   1. Restores into a scratch database and migrates it.
   2. **Every table's count must match**, except rows that later migrations add, which are listed
      explicitly.
   3. Renames the scratch database to `knowscroll` and copies media with hash checks.
4. The owner checks their universe at `app.knowscroll.space`.

## Cleanup and stability

**The rule: nothing on the server grows without a limit.** Every growing thing has an owner, a
cap and a cleanup.

| What grows | Cap and cleanup | Run by |
|---|---|---|
| Releases (`/srv/knowscroll/releases/`) | Keep any release a world currently uses or used last, plus the 3 newest; delete the rest | `ks deploy` after each deploy; `ks cleanup` nightly |
| systemd journal (all service logs, including Caddy's) | `SystemMaxUse=1G`, `MaxRetentionSec=30day` | journald itself |
| PostgreSQL server logs | Logrotate weekly, keep 4, compressed | logrotate (Ubuntu default, checked) |
| Cutroom working files (`cutroom-<pool\|live>/data/` artifacts) | A run's working files are deleted **7 days after it finished**. KnowScroll copies the final MP4 at import, and Cutroom's contract promises no retention. The 7 days leave room for Cutroom's resume of failed runs | `ks cleanup` nightly |
| KnowScroll media in **live** | **Never deleted automatically** (personal data, paid Reels). Only interrupted-import temp files older than 1 day | `ks cleanup` nightly |
| Pool media (stage and dev) | Files no `media_object` row in **either** stage or dev references, older than 7 days; temp files older than 1 day | `ks cleanup` nightly |
| Live backups (`/var/backups/knowscroll/`) | Pre-deploy: keep the last 3. Nightly: keep 7. The weekly restore-test's scratch database is dropped after the check | `ks backup` and `ks cleanup` |
| apt cache, old kernels, unused packages | Unattended upgrades with `Remove-Unused-Kernel-Packages` and `Remove-Unused-Dependencies`; weekly `apt-get autoclean` | apt timers |
| `/tmp` | Each service has its own `PrivateTmp`, cleared on restart; systemd-tmpfiles for the rest | systemd |
| Dev | `ks reset dev` also clears dev-only temp files | on demand |

**Disk guard** (`ks disk-guard`, a timer every 10 minutes, measuring `/`):

| Disk use | What happens |
|---|---|
| **≥ 80 %** | Warning in the journal, plus an alert once alerts exist |
| **≥ 90 %** | Writes `/run/knowscroll/disk-critical`. **Deploys are refused**, Cutroom and the generation workers are paused (`systemctl stop`), and `ks cleanup --emergency` runs: keep only the 2 newest unused releases, vacuum the journal to 500 MB, delete Cutroom working files older than 1 day. The flag clears itself when use falls below 85 % |
| **Never** | Live's database, live's media and live's newest verified backup are never touched by any cleanup |

**Memory and crash safety:**

- Per-world `MemoryHigh` and `MemoryMax`: live 3 GiB, stage 1.5 GiB, dev 1.5 GiB.
- The 4 GiB swap absorbs ffmpeg spikes.
- OOM priority: Postgres `OOMScoreAdjust=-900`, live `-500`, stage `+200`, dev `+500`. Under
  memory pressure the kernel kills dev first and Postgres last.
- `Restart=on-failure` with backoff (`RestartSec=5`, `StartLimitBurst=5`/10 min) on every
  service.
- Sandboxing: `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateTmp`, and write access only to
  that world's folders.

**Proven backups:** `ks restore-test live` runs weekly. A failure is an alert, not a log line.

**Uptime alert:** a free external check calls the three `/health` addresses every 5 minutes and
emails the owner. Hooking it into the Hermes WhatsApp butler is an optional later step.

## Test plan (named checks, written to fail before the code exists)

### Product code (CI)

- `runtime-config.test.ts`:
  - `server mode refuses KS_DEV_TOKEN`;
  - `server mode requires KS_WORLD and KS_COMMIT and names every missing setting at once`;
  - `server mode rejects an unknown world`;
  - `development mode is unchanged`.
- `app.test.ts`:
  - `buildApp(null) enrols no development session and the old bearer is 401`;
  - `with trustProxy 127.0.0.1, X-Forwarded-For is the rate-limit key`;
  - `without trustProxy, X-Forwarded-For is ignored`.
- `health.test.ts`: `/health reports world and commit`.
- Web:
  - `worldFromHostname maps app., app.stage., app.dev. and anything else`;
  - `EnvironmentLabel renders STAGE and DEV and nothing for live or local`;
  - `vite build succeeds without a world`.
- Android:
  - `EnvironmentLabel draws for dev and stage only` (unit);
  - `assembleLocalDebug, assembleDevDebug and assembleStageRelease produce com.knowscroll.mobile,
    .dev and .stage` (`aapt2 dump badging`, run locally when the Android slice lands, not in CI);
  - the existing Android CI job, renamed to `local`, still passes.
- Release build:
  - `build-release bundles start`: bundled `migrate` and `api` against CI Postgres, `/health`
    200;
  - `no bundle loads node_modules at runtime`: the release runs from a folder with no
    `node_modules`;
  - `release.json names the built commit and hash`.
- Ops tool unit tests:
  - `deploy refuses when disk-critical is set`;
  - `deploy refuses a stage or live commit that is not the branch tip`;
  - `live deploy with a pending migration requires a verified backup first`;
  - `cleanup never selects a world's current or previous release`;
  - `cleanup never selects live media or live's newest backup`;
  - `pool media cleanup keeps any file referenced by stage or dev`;
  - `disk-guard thresholds 80/90/85 (hysteresis)`.
- `ops/vps/gate.sh` passes `shellcheck`. The Ansible playbook passes `ansible-lint` and a
  `--check` run against the server.

### On the server (joined, recorded per slice)

- **TLS:** all 8 names over HTTPS with valid certificates; the apex and `www` redirect.
- **Correct build:** each world's `/health` shows the right world and commit.
- **Ports closed** (from the Mac): 4310–4330, 5432, 8787 and 8797 refuse outside connections.
- **Deploy key fenced:** `ssh deploy@… ls` is refused.
- **Restart with no errors:** a deploy while a loop of requests runs shows zero 5xx responses.
- **Rollback:** a release that fails health puts the previous one back by itself.
- **Promotion:** a promotion reuses the release (no rebuild) and stage's files hash the same as
  dev's.
- **Disk guard, for real, before live exists.** `fallocate` a dev-only filler file until the disk
  reaches 91 %:
  - deploys are refused;
  - Cutroom and generation stop;
  - emergency cleanup runs.

  Then delete the filler: the flag clears below 85 % and services return.
- **Live backup gate:** a corrupted backup stops a live deploy before migrating. The weekly
  restore-test passes on a real backup.
- **Access:** the `agent` user cannot read live's env file or database, and can do anything in
  dev.
- **Pool:** stage and dev both read pool media; dev holds no paid grant; `cutroom-live` is
  reachable only by live's user.
- **Owner's universe:** per-table counts match after the move, and the owner signs in at
  `app.knowscroll.space`.

## Least confident decisions

1. **Ansible adds a tool on the Mac.** Mitigated by installing it in a virtualenv on the SSD and
   keeping the playbook small. The bash fallback stays documented.
2. **Shared pool across two databases.** If dev's schema runs ahead of stage's, a pooled Reel must
   still import into both. The import rules are designed in #199.
3. **`knowscroll_test_*` names for stage and dev**, to reuse migration 0014's stand-in fence. No
   test suite may ever run on this server.
4. **Auto-rollback restores code only.** A migrated live database is the owner's restore decision.
5. **The `promoters` team does not stop the agent**, which uses `Legend101Zz`. Only the hook does,
   in Claude sessions on this Mac.
6. **Cutroom working files kept 7 days.** That's long enough for Cutroom's resume of failed runs,
   and short enough that a busy week can't fill the disk. Revisit once real Reel sizes are known.
