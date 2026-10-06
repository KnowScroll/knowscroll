# Status: Environments — dev, stage and prod on the VPS

Issue: #201 · Branch: `claude/environments` ·
Worktree: `/Volumes/Mrigesh SSD/knowscroll-worktrees/environments` · Base: `e5fdc319`

Process: the four-gate workflow (Product → Architecture → Program Design → Slices). Each gate
stops for the owner's explicit approval. No implementation code, server change or GitHub setting
change before the Gate 4 slice plan is approved. Read-only inspection of the VPS is allowed once
the owner has added the agent's SSH key.

- Gate 1 — Product: in progress
- Gate 2 — Architecture: pending (needs read-only VPS access first)
- Gate 3 — Program Design: pending
- Gate 4 — Slice plan: pending

## Slices

Written at Gate 4.

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
