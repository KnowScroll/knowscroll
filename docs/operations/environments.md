# Environments: running dev, stage and live on the VPS

How to operate KnowScroll's worlds on the Hostinger VPS ([ADR-0049](../decisions/0049-environments-on-one-vps.md),
[#201](https://github.com/KnowScroll/knowscroll/issues/201)). The design and its reasons are in
`docs/plans/environments/`. Never paste a secret, password or key value into an issue, PR, log or chat.

## The worlds

| World | Branch | Web app | Backend | Data | Who changes it |
|---|---|---|---|---|---|
| dev | `dev` | https://app.dev.knowscroll.space | https://backend.dev.knowscroll.space | preseeded; can be reset at any time | anyone's PR merge, the agent, a manual deploy of any commit |
| stage | `stage` | https://app.stage.knowscroll.space | https://backend.stage.knowscroll.space | preseeded; changes only on promotion | promotion from dev (agent, owner, XZNON) |
| live | `main` | https://app.knowscroll.space | https://backend.knowscroll.space | the owner's universe | promotion from stage (**owner or XZNON only**) — *not deployed yet* |

`/health` on any host answers `{status, database, world, commit}`, so you can see which build a world runs.

## Server

- **Host:** `187.126.119.96` (`srv2036699.hstgr.cloud`), Ubuntu 26.04, 2 vCPU, 8 GB, 100 GB.
- **Access:** SSH keys only. Password and keyboard-interactive login are off
  (`/etc/ssh/sshd_config.d/00-knowscroll.conf`). Hostinger's browser terminal still works; it logs in
  with a key it injects. The agent's key is `~/.ssh/knowscroll_vps_agent` on the owner's Mac
  (`ssh knowscroll-vps`).
- **Firewall:** ufw allows only 22, 80 and 443. Postgres (5432), the APIs (4310/4320/4330) and Caddy's
  admin port listen on 127.0.0.1 only.
- **Layout:**

  ```
  /srv/knowscroll/releases/<commit>/   one built release, shared by every world that runs it
  /srv/knowscroll/<world>/current      → the release this world runs; previous → the one before
  /srv/knowscroll/<world>/media/       the world's KS_MEDIA_ROOT (private to its user)
  /srv/knowscroll/<world>/releases.log one JSON line per deploy
  /etc/knowscroll/<world>.env          the world's settings and secrets (root:ks-<world>, 0640)
  /etc/knowscroll/secrets/             generated per-world secrets and shared mail settings (root, 0700)
  ```

- **Services per world:** `ks-api@<world>`, `ks-worker@<world>` and `ks-maintenance@<world>`, all under
  `ks-world@<world>.target` and the `ks-<world>.slice` (CPU and memory budget).

## Setting up or changing the server

Everything on the server comes from `ops/vps/ansible/`, run from the owner's Mac. Ansible lives in a
virtualenv on the SSD at `$KS_DEV_ROOT/tools/ansible-venv`.

```sh
ops/vps/ansible/run.sh --check --diff   # preview exactly what would change
ops/vps/ansible/run.sh                  # apply
```

A second run should report `changed=0`. Secrets are generated on the server and read by Ansible only
with `no_log`. One file is copied by hand, once:

- `/etc/knowscroll/secrets/shared/agentmail.env` holds `AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID` and
  `KS_OWNER_EMAIL`.
- It was copied from the owner's `.env` on 2026-10-07 without printing. Dev and stage share that
  inbox for now.

## Deploying

- **Automatically:** merge a PR into `dev`, or promote into `stage`. `.github/workflows/deploy.yml`
  waits for `checks` to pass on that commit, then:
  1. builds the release (or reuses the one already on the server);
  2. runs `ks deploy|promote <world> <commit>` through the world's deploy key;
  3. checks `/health` from outside.
- **A branch on dev:** Actions → deploy → Run workflow → `ref` = the branch or commit. Dev only.
- **By hand from the Mac** (the agent, dev only):

  ```sh
  pnpm build:release --out "$KS_DEV_ROOT/releases-local" --commit $(git rev-parse HEAD)
  ssh knowscroll-vps "flock /run/knowscroll/deploy.lock ks deploy dev <commit>" \
    < "$KS_DEV_ROOT/releases-local/release-<commit>.tar"
  ```

What `ks deploy` does:

1. Refuses if the disk is critical.
2. For stage and live, refuses any commit that is not the branch tip.
3. Verifies the release's hashes.
4. Runs `migrate` (and, for dev and stage, `seed`) as the world's own user.
5. Links the release, restarts the world, and waits up to 90 s for `/health` to report the commit.
6. If health fails, links the previous release back and restarts.

A migrated database is never rolled back automatically.

## Promoting

```sh
scripts/promote.sh stage   # dev's healthy commit → stage (agent, owner, XZNON)
scripts/promote.sh live    # stage's healthy commit → main (owner or XZNON only)
```

The script:
- reads the lower world's commit from its `/health`;
- refuses anything that is not a fast-forward, not on the lower branch, or without passing `checks`;
- pushes that commit to the next branch, which triggers the deploy.

The next world runs the same bytes. GitHub rulesets let only the `promoters` team (the owner and XZNON)
update `main` and `stage`. The agent's Claude Code hook refuses `promote.sh live` and any push to
`main`.

## Day to day on the server

```sh
ssh knowscroll-vps ks status                       # every world: commit, health, services, last deploy, disk
ssh knowscroll-vps ks rollback dev                 # back to the previous release (code only)
ssh knowscroll-vps journalctl -u 'ks-*@dev' -f     # follow a world's logs
ssh knowscroll-vps journalctl -u ks-disk-guard -n 20
```

## Cleanup and the disk guard

| What | Rule | When |
|---|---|---|
| Releases | Keep any release a world uses now or used last, plus the 3 newest others | after every deploy, and nightly (`ks-cleanup.timer`, about 03:30 UTC) |
| Temp files | Interrupted uploads and media imports older than 1 day | nightly |
| Journal | Capped at 1 GB and 30 days | journald |
| apt | Old kernels, unused packages and the cache cleaned by unattended upgrades | apt timers |
| Live media and backups | **Never deleted automatically** | — |

`ks-disk-guard.timer` runs every 10 minutes:

| Disk use | What happens |
|---|---|
| ≥ 80 % | Warning |
| ≥ 90 % | Writes `/run/knowscroll/disk-critical`: deploys are refused, Cutroom and generation (when present) are paused, and emergency cleanup runs (2 newest unused releases kept, journal vacuumed to 500 MB) |
| < 85 % (after critical) | Clears the flag and restarts what it paused |

The critical and recovery path was proven on 2026-10-07 by filling the disk to 93 % and removing the
filler. Pausing services is unproven, because no pausable service existed yet.

## The shared Reel pool and Cutroom (#199, ADR-0050)

Dev and stage share **one Cutroom** (`ks-cutroom@pool`, 127.0.0.1:8797, the real MiniMax and fal
providers) and **one spend record**: the `knowscroll_pool` database, which holds their shared $5.
Live gets its own Cutroom later.

- **Who orders.** Either world may order a Reel from an approved script, and every Reel appears in
  both.
- **Paid once.** The order claims the script's request id in `knowscroll_pool` first. The other
  world only receives it, at 0¢.

**Upstream Cutroom runs exactly as it ships, at a pinned commit.** Nothing in the Cutroom repository
changes; its code is copied from the owner's Mac.

```sh
git -C "/Volumes/Mrigesh SSD/Cutroom" archive --format=tar <commit> \
  | ssh knowscroll-vps ks cutroom-install <commit>
ssh knowscroll-vps ks cutroom-restart        # refused while a paid order is open
```

`ks cutroom-install` unpacks the tree under `/srv/knowscroll/cutroom/releases/<commit>`, then runs
upstream's own `pnpm install --frozen-lockfile --prod`. It switches `current` and restarts only when
no paid order is open: a restart mid-run would make Cutroom run that job again after its 4 h lease,
and pay again for work in flight.

| Path | What |
|---|---|
| `/srv/knowscroll/cutroom/current` | the pinned Cutroom source tree it runs |
| `/srv/knowscroll/cutroom-pool/data/` | Cutroom's SQLite (private to `ks-cutroom`) |
| `/srv/knowscroll/cutroom-pool/artifacts/` | finished files, readable by the `ks-pool` group (`ks-dev`, `ks-stage`); paid, so never cleaned automatically |
| `/srv/knowscroll/cutroom-pool/QUESTIONS.md` | where Cutroom reports cap refusals; `ks status` shows its last lines |
| `/etc/knowscroll/cutroom-pool.env` | its settings plus the provider keys (root:ks-cutroom, 0640) |
| `/etc/knowscroll-cutroom/pool.budget.md` | KnowScroll's per-reel cap for it ($0.75), a second lock behind the $5 |
| `/etc/knowscroll/secrets/cutroom/providers.env` | `MINIMAX_API_KEY` and `FAL_KEY`, copied once by hand from the owner's Mac (`FAL_KEY` takes the value of `FAL_AI_KEY`, which is never renamed); never in Git or logs |

How the service is started:
- The start wrapper holds stdin open with a FIFO, because upstream stops when stdin ends.
- systemd stops it with `SIGINT`, the signal upstream handles.
- It refuses to start a real narration port without a real voice (`English_Graceful_Lady`).

**Each world's generation worker** (`ks-generation@<world>`) does two jobs:
- it follows that world's orders;
- every minute it syncs with the pool: it settles finished orders, and creates a receive job for each
  Reel the pool has made whose approved script the world holds.

**Operator commands** run inside a world, as that world's user, through `ks run`:

```sh
ssh knowscroll-vps ks run <world> generation-cli pool-status
ssh knowscroll-vps ks run <world> generation-cli order --brief-id <id> --grant-id <id> \
  --approval-ref "PR #N" [--until plan|video] [--ceiling-cents 75]
ssh knowscroll-vps ks run <world> publication evaluate --reel-id <id> --policy publication-v2 --decide auto
ssh knowscroll-vps ks run <world> publication mint --reel-id <id>
```

One-time setup, per world:
1. `generation-cli register-engine --origin http://127.0.0.1:8797 --contract-revision <pin>
   --artifact-root /srv/knowscroll/cutroom-pool/artifacts --provider-mode live --declared-by <you>`
2. `generation-cli set-live-cap --cap-cents 500 --set-by "owner 2026-10-07: $5 for dev and stage"`
3. `generation-cli create-grant --mode live --cap-cents 500 --authorization-ref <ref> --expires-at <date>`

Each world also keeps its own cap: at most 500¢, as a second lock.

`ks deploy` applies the pool's own migrations, as Postgres acting for its owner role `ks_pool`,
before each world's migrations (`/etc/knowscroll/pool.env`). A pool migration must therefore keep
working with the older world code still running on the other world.

### Publishing and Scroll writing on their own (#199)

- **Publishing.** With `KS_AUTO_PUBLISH_POLICY=publication-v2` set in a world's settings
  (`auto_publish_policy` in `group_vars`), its generation worker publishes each real Reel on its
  own, once a minute:
  - it judges each newly imported Reel under the policy;
  - if every gate passes, it mints the Reel into the feed;
  - a refused Reel stays imported, and its gate results say why.

  The `publication` commands above are then only needed by hand.
- **Scroll writing** (ADR-0046's Quartermaster). With `scroll_supply: true`, a world's projection
  worker gets `KS_SCROLL_TRANSPORT=minimax` and the token-plan `MINIMAX_API_KEY`. The key comes from
  `/etc/knowscroll/secrets/shared/minimax.env`, copied once by hand from the owner's Mac. The worker
  then writes Scrolls from reading demand, through the same checks.
- **One-time route setup.** Each world needs its writing route and the pages it may write from,
  installed once:

  ```sh
  ssh knowscroll-vps ks run <world> install-supply --database knowscroll_test_<world> \
    --plan content/scroll-supply-plan.json --transport minimax --request-cap 150
  ```

  The request cap is that world's bucket of writing requests (at most 150). The token plan's quota
  check runs before every send.

## Adding the live world (later slice)

1. Add `live` to `ks_worlds` in `ops/vps/ansible/group_vars/all.yml`: port 4310, database `knowscroll`,
   role `ks_live`, the largest budget.
2. Create the `production` deploy key and secret.
3. Add `main` to `deploy.yml`.
4. Add backups:
   - a verified pre-deploy backup before any live migration (ADR-0047);
   - a nightly dump;
   - a weekly restore test;
   - a copy pulled to the Mac.
5. Move the owner's universe once, with a per-table count comparison (`docs/plans/environments/03-program-design.md`).

## Going private later

Rulesets, protected environments and environment secrets on a private repository need GitHub Team. In
this order:

1. Upgrade the org.
2. Make the repository private.
3. Confirm that rulesets `24594426` and `24608344`, the `dev`, `stage` and `production` environments,
   and the `promoters` team are still enforced.
4. Give the server a read-only way to run `git ls-remote` (a deploy key or token), because `ks deploy`
   checks branch tips over public HTTPS today.
