# Architecture: dev, stage and live on one VPS

Gate 2. Status: in progress. It builds on the approved Gate 1 (`01-product.md`) and on the server
as inspected read-only on 2026-10-06.

## The server as it is (observed 2026-10-06)

| Fact | Value | Consequence |
|---|---|---|
| OS | Ubuntu 26.04.1 LTS (`resolute`), kernel 7.0, x86_64 | Packages come from current repos |
| CPU, memory, disk | 2 × AMD EPYC 9354P, 7.7 GiB RAM, 96 GB free, **no swap** | CPU is the scarce resource; add swap |
| Preinstalled | Docker 29.8 + Compose v5.6 (no containers), Hostinger's Monarx scanner, unattended security upgrades (on), chrony (UTC, in sync) | Docker publishes ports past any firewall, so it needs a decision |
| Firewall | ufw inactive; Docker's nft tables only | Only SSH listens today |
| SSH | **key-only since 2026-10-06** (`00-knowscroll.conf`); Hostinger's console logs in with an injected key | Done; see 00-status |
| Node | Ubuntu offers **22.22.1**; KnowScroll requires `>=22.23.0 <23` | Use NodeSource `node_22.x` (served for this release) |
| PostgreSQL | Ubuntu offers **18**; KnowScroll is built and tested on **16** (CI uses `postgres:16`) | Use the PGDG repo's 16 (served for `resolute`) |
| ffmpeg | Ubuntu offers **8.0.1** | Meets Cutroom's 8.x requirement |
| Caddy, nginx | Ubuntu offers Caddy 2.6.2 (old) and nginx 1.28 | Caddy from its official repo, for automatic HTTPS |
| Build tools | none (`build-essential` available) | Cutroom's SQLite driver compiles natively |

## Fit: what runs where

One machine, three worlds, one database server, one web front door.

```
            Internet (80/443 only; 22 for SSH)
                           │
                     ┌─────┴─────┐
                     │   Caddy   │  automatic HTTPS for all 8 names
                     └─────┬─────┘
     ┌─────────────────────┼─────────────────────┐
  live (main)         stage (stage)          dev (dev)
  app. / backend.     app.stage. / …         app.dev. / …
  ├ web (static)      ├ web (static)         ├ web (static)
  ├ API :4310         ├ API :4320            ├ API :4330      (127.0.0.1 only)
  ├ worker            ├ worker               ├ worker
  ├ generation        ├ generation           ├ generation
  └ Cutroom :8787     └ Cutroom :8797        └ Cutroom :8807  (127.0.0.1 only)
     real providers      real, capped           stand-ins only, $0
                           │
            PostgreSQL 16 (127.0.0.1:5432, one cluster)
      knowscroll · knowscroll_test_stage · knowscroll_test_dev
```

- **Every process is a systemd service** running as that world's own Unix user (`ks-live`,
  `ks-stage`, `ks-dev`). No world can read another's files or secrets.
- **Each world is a `systemd` slice** with a CPU and memory budget, so live always wins:

  | Slice | CPU | Memory |
  |---|---|---|
  | live | weight 400 | 3 GiB |
  | stage | weight 100, ≤ 1 core | 1.5 GiB |
  | dev | weight 50, ≤ 1 core | 1.5 GiB |

  Postgres gets 1 GiB of shared buffers. A 4 GiB swap file absorbs ffmpeg spikes.
- **The web app is served as static files by Caddy.** On each `app.` host, Caddy also forwards
  `/v1/*` and `/health` to that world's API. The browser therefore talks to one origin, and the
  existing cookie sign-in (ADR-0034, SameSite=Strict) works unchanged. Each `backend.` host is
  the same API for the Android app.
- **The bare `knowscroll.space` and `www` redirect to `app.knowscroll.space`.** Each `app.` host
  serves `/.well-known/assetlinks.json` for its flavour's App Links.
- **Each world has its own Cutroom checkout and data**, pinned to its own Cutroom revision, so dev
  can try a newer pin before stage does. Cutroom stays loopback-only (its v1 contract) and talks
  only to its own world.

### Layout on disk

```
/srv/knowscroll/<world>/
  app/            git checkout of the deployed commit (read-only to the service user)
  web/            the built web bundle for that commit
  cutroom/        Cutroom checkout at the world's pinned revision
  cutroom-data/   Cutroom SQLite, artifacts, questions/budget files
  media/          KnowScroll's content-addressed media (KS_MEDIA_ROOT)
  releases.log    one line per deploy: time, commit, migrations applied, result
/etc/knowscroll/<world>.env        secrets and settings, mode 0640, root:ks-<world>
/etc/knowscroll/<world>.cutroom.env  Cutroom's provider keys, readable only by that world's Cutroom
/var/backups/knowscroll/           live database backups, mode 0700
```

## Code changes inside KnowScroll (all named in Gate 1)

1. **API server mode.** `apps/api/src/main.ts` refuses `NODE_ENV=production` and always enrols
   `KS_DEV_TOKEN`. The guard predates identity (#2, closed). Server mode will:
   - start without the development token, and refuse to start if one is set;
   - require `KS_WEB_ORIGIN`, a fixed `KS_CSRF_SECRET` and a real mail sender;
   - keep the `127.0.0.1` binding, which is exactly right behind Caddy;
   - trust exactly one proxy hop, so client addresses and secure cookies are correct.
2. **Web production build.** Lift `refuseProductionBuild()` in `apps/web/vite.config.ts` (same
   stale #2 guard). Build one bundle per world with its name baked in for the label.
3. **Android flavours** `dev`, `stage` and `live`:
   - `applicationIdSuffix` `.dev` or `.stage`, so all three install side by side;
   - app names "KS Dev" / "KS Stage" / "KnowScroll";
   - per-flavour `KS_API_BASE` (`https://backend.<world>…`) and App Links host;
   - the environment label from the Gate 1 mockup.
4. **Environment label on web and Android**, driven by the world's name. Live shows none.
5. **Docs:** CONTRIBUTING, AGENTS and `docs/operations/deployment.md` move from "PR to main, owner
   runs it on the Mac" to the new flow.

## Endpoints

No new product endpoints. Existing ones, as reached from outside:

- `https://app.<world>/` serves the web app; `/v1/*` and `/health` proxy to that world's API.
- `https://backend.<world>/v1/*` and `/health` serve the API for Android. `/health` already exists
  and answers only when the database does.
- `https://app.<stage|dev>/download` is the latest phone build for that world, behind sign-in.

## Data

- **One PostgreSQL 16 cluster**, listening on 127.0.0.1 only. Each world has a database and its
  own role, with no cross-access:

  | World | Database | Role |
  |---|---|---|
  | live | `knowscroll` | `ks_live` |
  | stage | `knowscroll_test_stage` | `ks_stage` |
  | dev | `knowscroll_test_dev` | `ks_dev` |

- **Why stage and dev are named `knowscroll_test_*`.** Migration 0014's stand-in fence already
  allows simulated Reels to become playable only in databases with that prefix. Naming stage and
  dev this way lets their feeds show labelled simulated Reels. Live's database can never satisfy
  the fence, so simulated media cannot reach the owner's universe, enforced by the database
  itself. No KnowScroll test suite ever runs on this server, so nothing will treat these as
  disposable.
- **Live receives the owner's universe once** (Gate 1 decision 7):
  1. On the Mac, stop the API and worker, then `pg_dump` the owner database and verify the dump
     as `deployment.md` does.
  2. Copy the dump and `$KS_MEDIA_ROOT` to the server.
  3. `pg_restore` into `knowscroll`, then migrate if live's code is newer.
  4. Compare row counts for every table against the Mac; they must match.
  5. The owner checks the result in the app.

  The Mac database is kept, untouched, as an archive until the owner retires it.
- **Seeding stage and dev.** Both get the shared library, the substrate and a scripted test
  reader, so the real Cartographer forms places from what exists today. Dev can be reset at any
  time with one command. Growing the library to about 100 Scrolls and adding Reels belongs to the
  Cutroom plan (#199), which runs on these worlds.
- **Backups (live only):**
  - a verified `pg_dump` before every live deploy that migrates (the existing rule, ADR-0047);
  - a nightly dump kept 7 days, plus the media folder;
  - an off-server copy, whose destination is question 4 below.

  Backups are personal data (ADR-0035 §6): mode 0600 in a 0700 folder, never in Git or logs.

## Flow: how a change travels

```
feature branch ──PR──▶ dev ──fast-forward──▶ stage ──fast-forward──▶ main
   (squash merge)       │      (agent, owner,    │     (owner or XZNON)  │
                        ▼       XZNON)           ▼                       ▼
                 deploy to dev           deploy to stage           deploy to live
```

1. **CI runs on every push and PR**, as today, on GitHub's own runners. There is never a
   self-hosted runner, because the repo is public.
2. **A push to `dev`, `stage` or `main` triggers a deploy job** after CI passes for that exact
   commit:
   - The job builds the web bundle (and, for dev/stage, the Android APK) on GitHub.
   - It connects to the server as user `deploy`, with a key that can run only one command:
     `ks-deploy <world> <commit>`. The SSH key line uses `command=` and `restrict`.
   - The deploy key lives in a GitHub Environment (`dev`, `stage`, `production`). `production`
     pauses for a reviewer: the owner or XZNON.
3. **`ks-deploy` on the server**, run as the world's own user with narrow sudo:
   1. Checks the commit is the tip of that world's branch.
   2. Fetches it and installs dependencies (frozen lockfile).
   3. **For live: takes and verifies a backup before any migration.**
   4. Migrates, swaps in the new code and web bundle, and restarts the world's services.
   5. Polls `/health` and checks the reported version.
   6. If the code fails health, it puts the previous commit back. A migrated live database is
      never rolled back automatically; that is the owner's restore decision, as in
      `deployment.md`.
   7. Appends a line to `releases.log`.
4. **Promotion is a fast-forward**, never a merge commit. That keeps the branches literally
   `main ⊆ stage ⊆ dev`. `scripts/promote.sh stage|live` pushes the lower branch's deployed
   commit up, after checking:
   - the target is an ancestor (fast-forward only);
   - CI is green on that commit;
   - the lower world reports that commit as healthy.

   On this Mac, a Claude Code hook refuses agent commands that update `main` (Gate 1 decision 6).
5. **The phone builds for dev and stage** come from CI. They are signed with a non-release test
   key, uploaded by the same deploy, and served at `/download`. Live's build goes to Google Play
   with the owner's release keystore (release input 3).

## Access

- **The agent's day-to-day account is `agent`, not root.** It can:
  - read every world's logs and status;
  - restart and redeploy dev and stage, and reset dev;
  - call live's `/health` and read live's service status.

  It cannot read live's secrets, database or media. Gate 1 promised exactly this.
- **Setup runs as root.** The final setup slice moves the agent to `agent` and removes its key
  from root. After that, root is reachable only through Hostinger's console, plus the owner's own
  key if they add one.
- **Firewall:** ufw denies all incoming traffic except 22, 80 and 443. Postgres, the APIs and
  Cutroom listen on 127.0.0.1 only.

## External

| Service | Used by | Names (never values) |
|---|---|---|
| GitHub Actions + Environments | CI and deploys | `KS_DEPLOY_SSH_KEY`, `KS_ANDROID_TEST_KEYSTORE` (+ passwords) |
| Hostinger DNS | the 8 names → `187.126.119.96` | managed in hPanel (done) |
| Let's Encrypt via Caddy | HTTPS certificates | none |
| AgentMail | sign-in links | `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` per world |
| MiniMax, fal | live and stage Cutroom; KnowScroll worker reasoning where enabled | `MINIMAX_API_KEY`, `FAL_KEY` in each world's own env file |
| Google Play | live's Android release | release keystore (owner input) |

**Spend.** Dev's Cutroom runs stand-ins only, $0, and refuses real provider settings. Stage's
real-reel spend counts against the owner's $2 Cutroom cap (#199). Live's limits are set when live
first generates.

**Going private later** (Gate 1 decision 5): rulesets, required reviewers and environment secrets
on a private repo need GitHub Team. The switch is one checklist: upgrade, make private, re-check
that ruleset `24594426`, the environments and the `promoters` team are still enforced.

## Questions for you at this gate

1. **Native services or Docker?** I recommend **native systemd services**, as drawn above. That
   means the least overhead on 2 cores, logs in one place the agent can read (`journalctl`), and
   the same commands the repo already uses. Docker Compose per world gives tidier isolation and
   easy resets, but costs memory, needs image builds and adds a layer to debug. Which?
2. **The preinstalled Docker.** Unused today, and anything it publishes bypasses the firewall. I
   recommend **stopping and disabling it** (reversible), unless you choose Docker in question 1.
3. **Sign-in mail on stage and dev.** You'll sign in to all three worlds from your phone, so each
   needs real email. Options:
   - one AgentMail inbox shared by all three (links say which world they are for);
   - an inbox per world (cleaner);
   - dev and stage write links to a file that the agent reads to you (no mail cost, but clumsy).

   Which?
4. **Off-server backups of live.** Choose one or more:
   - Hostinger's weekly snapshot only;
   - a nightly copy pulled to the Mac's SSD whenever it's on;
   - a cheap object store (for example Backblaze B2, about $0 at this size).
5. **Enforcing "owner and XZNON only" for live and stage.** All three of you are admins, so
   GitHub can only tell you apart through an org team. I'd create a `promoters` team (you,
   XZNON), so only that team can update `main` and `stage`. Asrani-Aman can still open PRs into
   dev. This adds no protection against the agent, which uses your account. Yes?
