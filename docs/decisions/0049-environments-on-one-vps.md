# ADR-0049 — Three worlds on one VPS: dev, stage and live, built once and promoted by fast-forward

Date: 2026-10-07. Status: accepted for [#201](https://github.com/KnowScroll/knowscroll/issues/201) on the
owner's decisions in the four-gate plan `docs/plans/environments/` (Gates 1–4 approved 2026-10-06/07).
Supersedes the "owner-run on this Mac" deployment of [ADR-0047](0047-release-readiness-before-owner-inputs.md)
for dev and stage now, and for live once the live slice lands. ADR-0047's migration rules (forward-only,
a verified backup before every live migration, rollback by restore) are unchanged.

## Context

KnowScroll ran only on the owner's Mac, from the external SSD, started by hand. The owner bought a Hostinger
VPS (2 vCPU, 8 GB, 100 GB) and the domain `knowscroll.space`. They want:

- three worlds, each with its own database, configuration, secrets and video engine;
- changes flowing one way, `dev ⊇ stage ⊇ main`;
- the agent free in dev and able to promote dev → stage, while only the owner and XZNON promote to live.

Several things blocked this:

- the API refused `NODE_ENV=production` and always enrolled a development identity;
- the web refused a production build (both guards cited identity #2, since closed);
- nothing served HTTPS in front of the loopback-only API.

## Decision

1. **Worlds, branches and hosts.**

   | World | Branch | Web app | Backend |
   |---|---|---|---|
   | live | `main` | `app.knowscroll.space` | `backend.knowscroll.space` |
   | stage | `stage` | `app.stage.knowscroll.space` | `backend.stage.knowscroll.space` |
   | dev | `dev` | `app.dev.knowscroll.space` | `backend.dev.knowscroll.space` |

   The bare domain and `www` redirect to live. `dev` is the default branch; feature PRs target it.

2. **One machine, native services.**
   - Ansible (`ops/vps/ansible/`, previewed with `--check --diff`) sets up Caddy (automatic HTTPS), one
     PostgreSQL 16 cluster with a database and role per world, and Node 22.
   - Each world gets a Unix user, a systemd slice with CPU and memory budgets (live wins), and
     sandboxed templated units.
   - Docker is disabled.
   - Stage and dev databases are named `knowscroll_test_*`, so migration 0014's stand-in fence allows
     labelled simulated media there and never in live.
3. **Build once, promote the same bytes.**
   - CI bundles every backend program with all its dependencies (esbuild) plus the web app,
     migrations and content into one release. The server runs it with plain `node`: no TypeScript,
     no `node_modules`, no npm during a deploy.
   - The web reads its world from its hostname, so one bundle serves all three.
   - A promotion reuses the release already on the server.
4. **Server mode.** `NODE_ENV=production` runs with no development identity (`KS_DEV_TOKEN` is
   refused), trusts exactly the loopback proxy hop, and `/health` reports the world and commit.
   Development mode is unchanged.
5. **Deploys.**
   - A push to `dev` or `stage` runs `.github/workflows/deploy.yml` on GitHub's runners. It waits for
     `checks` to pass on that commit, then calls the server through a deploy key pinned to that world
     by a forced-command gate.
   - `ks deploy` verifies the release, migrates as the world's own user, links it, restarts, and
     checks health. If health fails, it puts the previous release back.
   - Deploys queue; they never cancel mid-migration.
   - There are no PR triggers and no self-hosted runner, because the repository is public.
6. **Promotion is a fast-forward** (`scripts/promote.sh`), so the three branches hold the same
   commits.
   - Rulesets block deletion and force-pushes on all three branches, and only the `promoters` team
     (the owner and XZNON) may update `main` and `stage`.
   - The agent acts through the owner's GitHub account, so GitHub cannot tell them apart. A Claude Code
     hook (`.claude/hooks/refuse-main-update.mjs`) refuses agent commands that update `main`.
7. **Nothing grows without a limit.**
   - Releases: the in-use ones plus the 3 newest unused are kept.
   - The journal is capped at 1 GB / 30 days.
   - Interrupted temp files are removed after a day.
   - A disk guard warns at 80 %, pauses deploys and optional work at 90 %, and recovers below 85 %.
   - Live media and live backups are never auto-deleted.
   - Postgres has `OOMScoreAdjust=-900`; dev is killed first under memory pressure.
8. **Cutroom.** Stage and dev share one Cutroom and Reel pool; live has its own. Only stage orders paid
   runs. This is designed in #199.

## Alternatives and why

- **Docker Compose per world:** cleaner isolation, but more memory on 2 cores, image builds, and a
  layer to debug. Rejected for now.
- **Running TypeScript through `tsx` in production:** measured at 1.3 s and 183 MB to ready, against
  0.1 s and 118 MB for the bundle.
- **Plain `tsc` output:** the workspace packages export `.ts` sources, so it would still load `.ts` at
  runtime.
- **Node's own type stripping for the app:** three classes use parameter properties, which are not
  erasable. The ops tool, which is erasable-only, does use it.
- **`workflow_run` deploys:** they run in the default branch's context, which defeats per-environment
  branch rules, and they carry the fork-branch-name trap. A push trigger that waits for `checks` is
  used instead.
- **Product flavours for Android:** adopted, but Android builds happen on the owner's Mac on request,
  so they are not part of this pipeline.

## Consequences

Dev and stage run on the VPS. The following remain later slices:

- live, with its backups (pre-deploy, nightly, weekly restore test, a copy on the Mac) and the one-time
  move of the owner's universe;
- the `agent` user replacing the root key;
- Cutroom services;
- Android flavours.

When the repository goes private, rulesets and protected environments need GitHub Team; the
switch-over checklist is in `docs/operations/environments.md`.

Proven on 2026-10-06/07:

- backend suite 1117/1117 and web 264/264;
- the release smoke test in server mode;
- an idempotent Ansible run;
- valid certificates on all eight names and internal ports closed;
- the deploy gate's refusals;
- a deploy to dev in 11 s;
- the disk guard taken to 93 % and back.

## Sources and verification

`docs/plans/environments/` (gates and research), `docs/operations/environments.md` (operating guide),
`ops/vps/`, `.github/workflows/deploy.yml`, `scripts/{build-release,smoke-release}.mjs`,
`scripts/promote.sh`.
