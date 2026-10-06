# Status: Environments — dev, stage and prod on the VPS

Issue: #201 · Branch: `claude/environments` ·
Worktree: `/Volumes/Mrigesh SSD/knowscroll-worktrees/environments` · Base: `e5fdc319`

Process: the four-gate workflow (Product → Architecture → Program Design → Slices). Each gate
stops for the owner's explicit approval. No implementation code, server change or GitHub setting
change before the Gate 4 slice plan is approved. Read-only inspection of the VPS is allowed once
the owner has added the agent's SSH key.

- Gate 1 — Product: APPROVED 2026-10-06 (answers recorded in 01-product.md)
- Gate 2 — Architecture: APPROVED 2026-10-06 (recommended answers adopted; see 03-program-design.md "Defaults")
- Gate 3 — Program Design: APPROVED 2026-10-07 (rewritten with the owner's changes)
- Gate 4 — Slice plan: APPROVED 2026-10-07 (owner: finish setup, deploy dev and stage overnight)

## Slices

- [x] Slice 0 — key-only SSH, DNS, GitHub branches + ruleset + default `dev` (2026-10-06)
- [x] Slice 1 — server baseline via Ansible (2026-10-07: applied, idempotent, 8 names on Let's Encrypt, internal ports closed)
- [x] Slice 2 — server mode + build once (2026-10-07: tests first; suite 1117/1117, web 264/264, release smoke in CI)
- [x] Slice 3 — deploy tool + pipeline (2026-10-07: `ks` + gate + timers installed; manual dev deploy 11 s; deploy.yml + environments + world-pinned keys)
- [x] Slice 4 — stage + fast-forward promotion, promoters team, agent hook (2026-10-07: dev → stage promoted `f6e0eb86` by fast-forward; the ruleset admitted it as a `promoters` bypass; stage deployed in 22 s by reusing the release, no rebuild)
- [x] Slice 5 — cleanup and crash safety (2026-10-07: filled to 93 %, deploys refused, emergency cleanup, recovered; pausing services unproven, none existed)
- [x] Slice 6 — docs and handoff (2026-10-07: ADR-0049, operations/environments.md, CONTRIBUTING/AGENTS/README/deployment, CHECKPOINT; links in #201)

## Owner-requested exception before Gate 4

On 2026-10-06 the owner asked for the server to be SSH-protected as soon as the agent has key
access. That one change, **password login off and key-only root**, is made before Gate 4 because
the box is otherwise open to password guessing. Everything else (users, firewall, services) waits
for the slice plan. The Hostinger web console stays a way in that does not depend on SSH.

## Done ahead of Gate 2, at the owner's request (2026-10-06)

The owner asked for the server to be accessed and secured, and for GitHub to be set up. These
steps are low-risk and easy to undo, and every architecture option needs them:

- **DNS verified.** At Hostinger's servers and at 1.1.1.1, `knowscroll.space`, `www`, `app`,
  `backend`, `app.stage`, `backend.stage`, `app.dev` and `backend.dev` all resolve to
  `187.126.119.96`.
- **GitHub branches.** `stage` and `dev` were created at `main`'s commit `e5fdc319`, so
  `main ⊆ stage ⊆ dev` holds trivially.
- **GitHub ruleset `24594426`** ("environment branches: no deletion, no force-push") is active
  on `main`, `stage` and `dev` with no bypass actors. Squash merges into `dev` and fast-forward
  promotions are still allowed. Undo:
  `gh api -X DELETE repos/KnowScroll/knowscroll/rulesets/24594426`.
- **The default branch is `dev`** (was `main`), so new PRs target it. Draft PRs #200 and #202 were
  retargeted to `dev`. Undo: `gh api -X PATCH repos/KnowScroll/knowscroll -f default_branch=main`.
  CONTRIBUTING and AGENTS still say "PR to main". Updating them is a Gate 4 slice.
- **Promotion rights (owner, 2026-10-06):** the owner and **`XZNON`** may promote to stage **and
  to live**. `Asrani-Aman` may not. All three are repo admins, so GitHub can only enforce this
  through an org team used as a ruleset bypass actor. That is a Gate 2 decision.
- **SSH is key-only** (done 2026-10-06, verified from outside). Host key
  `SHA256:YDrqOgWcpt62KObaOMuTDcc8URSm87kG/aD6qeqpcBM`.
  - `/etc/ssh/sshd_config.d/00-knowscroll.conf` sets `PasswordAuthentication no`,
    `KbdInteractiveAuthentication no` and `PermitRootLogin prohibit-password`. It sorts before
    Hostinger's `50-cloud-init.conf`, which had allowed passwords; sshd keeps the first value it
    reads.
  - `AuthorizedKeysFile` also reads `/etc/ssh/authorized_keys.d/%u`, which holds the agent key, so
    Hostinger's console key-injection into `/root/.ssh/authorized_keys` cannot remove it. The
    console's RSA line (`expiry-time=…`) had no trailing newline, and that is why the first
    pastes failed.
  - Verified: a new key login works, and a password attempt gets `Permission denied (publickey)`.
  - Undo: delete `00-knowscroll.conf`, then `sshd -t && systemctl reload ssh`.
  - On the Mac, `ssh knowscroll-vps` is an alias in `~/.ssh/config`, and the host key was added
    to `~/.ssh/known_hosts`.

## Running now (2026-10-07)

| World | Web app | Backend | Commit |
|---|---|---|---|
| dev | https://app.dev.knowscroll.space | https://backend.dev.knowscroll.space | `f6e0eb86` (deployed by CI from the #202 merge) |
| stage | https://app.stage.knowscroll.space | https://backend.stage.knowscroll.space | `f6e0eb86` (promoted; the same release folder as dev) |
| live | https://app.knowscroll.space | — | placeholder; live slice not started |

Both worlds hold the 23 editorial Scrolls and the substrate (seed). No reading history has been seeded
yet; the scripted reader and the larger library belong to #199. Only `KS_OWNER_EMAIL` can sign in
(single owner).

## Relationship to the Cutroom plan

`docs/plans/cutroom-integration/` (#199, branch `claude/9-cutroom-integration`) depends on this
feature. Its "test universe" becomes **stage** (seeded, real reels within the cap). **Dev** is the
free proving ground with stand-in reels only. The owner said its Gate 1 "looks great"; it is
re-presented for approval with that one change once this plan settles.

## Notes for a fresh session

Owner decisions in chat on 2026-10-06:

1. **A Hostinger VPS** (2 vCPU, 8 GB RAM, 100 GB disk, 8 TB bandwidth), freshly installed, for
   KnowScroll only. It currently uses password login. **The password must never be sent in chat.**
   The owner adds the agent's public key in hPanel; then password and root login are switched off.
2. **Domain `knowscroll.space`** (registered 2026-10-06 at Hostinger; DNS on Hostinger's
   `dns-parking.com`). Proposed hosts are `app.<env>.knowscroll.space` for the UI and
   `backend.<env>.knowscroll.space` for the API, where env is prod, stage or dev. The prod naming
   is an open question at Gate 1.
3. **Three environments if they fit, otherwise two.** Each has its own database, configuration,
   secrets and Cutroom.
   - main = prod, with real data and no seeded or test data.
   - stage = a preseeded database for the owner to try things.
   - dev = a preseeded database where the AI builds and tests.
   - Invariant: **main ⊆ stage ⊆ dev**.
   - *Gate 3 review (owner):*
     - one Postgres with a database per world;
     - stage and dev share one Cutroom Reel pool (`cutroom-pool`), while live has `cutroom-live`;
     - releases are built in CI (esbuild) and the server runs plain `node`;
     - the agent has full control of dev.
   - XZNON may also promote, including to live (owner, 2026-10-06).
4. **Promotion rights.** The AI may merge into dev and promote dev → stage once a change works.
   **Only the owner promotes to main.**
5. **The repo stays PUBLIC for now** to avoid GitHub cost. It goes private later, when the owner
   starts paying. That switch is planned, not silent: rulesets on a private repo need GitHub Team.
6. **The agent keeps using the owner's GitHub account** (`Legend101Zz`); no bot account or App.
   Consequence, stated honestly: GitHub cannot tell the owner and the agent apart, so "only the
   owner promotes to main" rests on agent discipline, backed by a Claude Code hook on the Mac that
   refuses agent commands that update `main`, and by a ruleset that blocks the accidents that would
   actually hurt.
7. **Prod receives the owner's existing universe** from the Mac's PostgreSQL (`127.0.0.1:55432`),
   moved once with a verified backup under `docs/operations/deployment.md`. "Clean" means no test
   or seeded data.
8. **Android:** prod ships on Google Play. Stage and dev must be installable on the owner's phone.
   The app is native Android only; iPhone uses the web app.
9. **The agent has standing SSH access** to watch execution, logs and health.

Facts verified on 2026-10-06:

- Repo `KnowScroll/knowscroll`: public; squash-merge only; no branch protection, rulesets or
  environments. Org plan is `free`. The admins are `Legend101Zz`, `XZNON` and `Asrani-Aman`.
- `apps/api/src/main.ts` refuses `NODE_ENV=production` ("implement production authentication
  before deployment") and enrols `KS_DEV_TOKEN` as a session at start. Identity issue #2 is
  CLOSED, and magic-link, device-session and cookie sign-in exist (ADR-0026/0034/0035), so this
  guard predates them.
- `apps/web/vite.config.ts` refuses a production build, citing the same #2.
- Android (`apps/mobile/app/build.gradle.kts`) has only debug/release build types. Release needs
  the keystore, an `https` `KS_RELEASE_API_BASE` and an App Links host (release inputs 1–3 in
  `docs/operations/release-inputs.md`). The domain now answers input 1.
- The agent's SSH key was generated on 2026-10-06 at `~/.ssh/knowscroll_vps_agent` (ed25519, no
  passphrase, Mac only). Only the `.pub` half is shared.
