# Shared delivery checkpoint

## 2026-09-22 UI refinement successor — #72 / #4

Current local branch: `codex/72-ui-experience-audit`, started from clean `c9c3e72` on the
external SSD. The dated [audit](design/2026-09-21-ui-audit.md) supersedes earlier claims of visual
completion below. Both actual clients were inspected before changes. Shared local typography,
cartographic source-backed worlds, local world inspection, consistent navigation, real Web Keep,
responsive layouts and native reader hierarchy are implemented. Final evidence lives in
[journeys/evidence/ui-refinement-2026-09-21](journeys/evidence/ui-refinement-2026-09-21/README.md).

Native foreground/recreation retains System/Keep only after same-universe, same-epoch reconciliation.
The privacy journey reproduced the old stale-system-after-Clear defect; migration 0025 and both
Clear/Reset now erase that private projection transactionally. Shared source catalog and exact-retry
boundaries remain. Request privacy-lane review (#4) on the draft before merge. No owner migration,
owner data reset or provider run occurred. Test data/app are separate and disposable.

**Not full v1:** region/Star/galaxy evolution, relationships, world-scoped discovery, native
pause/export/Reset parity, production identity recovery, real Reels and journeys A–I remain open.
Do not render fictional growth to fill these gaps. Next action: review final captures and the draft
against the canonical references, then specify the remaining evidence-backed evolution contracts.
The older snapshot below is retained as historical evidence, not current branch/runtime truth.

Updated 2026-09-20 (Claude Code coordinator). Coordinator-owned current steering object, not a
transcript. Replace this snapshot when reality changes; preserve prior evidence and rationale through
Git, issues and [delivery history](operations/delivery-history.md).
**Live copy protocol:** during a wave the coordinator edits this file uncommitted in the main
checkout (so compaction reloads it); the committed copy lands with a wave PR. After a merge,
re-apply anything newer here before running `git checkout -- docs/CHECKPOINT.md`.

## Outcome and authority

Full v1 means all journeys A–I, polished mobile **and desktop**, real Cutroom generation through
import/publication/playback, reasoning, semantic/living/social experience and owner acceptance.
[Release contract](product/v1-release.md) and [#72](https://github.com/KnowScroll/knowscroll/issues/72)
remain authoritative and open. Owner Alpha is intermediate. Read [system navigation](operations/system-navigation.md).

## Verified source versus observed runtime

| Fact | Evidence and practical consequence |
|---|---|
| Main | **`bf9610c`** (PR #127, migration ordering); `a867aea` (#125 composer), `9f96645` (#124 privacy panel), `ef468aa` (#122 Android system level), `bd0cc3f` (#121 web system level) |
| Code migrations | `0001`–`0016`, **`0017`** (evidence-backed worlds) and **`0020`** (privacy lifecycle) on main; owner database still at 0009 |
| Owner database | `pnpm state` 2026-09-19T18:29Z: **0001–0009 only**; API false; heartbeat 2026-09-17. **No owner rollout of 0010–0016** |
| Identity | Single-user magic link (ADR-0026) + AgentMail delivery (ADR-0027) on main. **Proved with real mail 2026-09-20** (#109): sent, delivered to `knowscroll@agentmail.to`, read back over the API, link consumed, session issued `origin: magic_link`, replay refused 401. Owner database still unmigrated, so the owner cannot yet sign in to *their own* universe |
| Android | Sourced Scroll, sources, deliberate next, Keep, Trace revisit, bounded Clear, why-this sheet, device sign-out. Sheet state across recreation: #97. **Old scaffold visual language; UI slice not started** |
| Desktop | **The agreed Cosmos/Living Observatory interface is on main** (#110): head band, centred stage, truth pill adjacency, `↓` reads-then-advances, reduced motion, axe clean. Dev-only loopback auth still |
| Reasoning | SQL primitives only; Ask `recorded_only`; no paid dispatch, no mobile Ask (ADR-0016) |
| Cutroom upstream | `origin/main` `86d6e2c` (active author XZNON). Canonical clone `/Volumes/Mrigesh SSD/cutroom` at `52a62dd`, untouched |
| Cutroom runtime (ours) | Pinned detached worktree `/Volumes/Mrigesh SSD/cutroom-worktrees/runtime-86d6e2c8b742`. Use `/usr/local/bin/corepack` (nvm corepack is broken) |
| Real providers | Upstream model/image/video/voice/sensors are **stand-ins**; ffmpeg real. So no Reel can be genuinely eligible yet |

## The generated-Reel chain, and its honest blocker

Source now carries the whole chain: brief → budgeted job → Cutroom attempt (request bytes persisted
before POST, reconciled by original id) → verified import into content-addressed SSD storage →
seven publication gates at policy `publication-v1` → minted `asset` of kind Reel → authenticated
`GET|HEAD /v1/media/:sha256` with Range. Feed offers Reels only to clients sending `kinds=Scroll,Reel`,
so existing readers are unaffected.

**A generated Reel cannot become eligible in a real universe until** (a) upstream Cutroom ships real
providers, (b) a Visual Witness implementation with authorized model dispatch exists — `witness_alignment`
is required and structurally `unavailable` — and (c) gates run at policy. Stand-in media is fenced by
the database itself to disposable `knowscroll_test_*` databases. None of this is worked around.

## Delivered — #106 (PR #108 → `29c9914`)

AgentMail `MagicLinkSender`: one POST, bounded timeout, bounded response read, no retry, no redirect
following; `KS_MAIL_SENDER` selects the sink or AgentMail and production never falls back to the sink;
a send failure is one structured stderr line of `httpStatus`/`reason`/`messageId` and changes nothing
a caller can see. Independent review accepted the worker's commit; reproducing it, the coordinator
found the timeout covered only the header phase — a provider stalling mid-body would hang the
unauthenticated `POST /v1/auth/magic-link` forever — and fixed it with a red-then-green test. A second
independent review of that fix re-derived the defect and proved both new tests non-vacuous.
Lane verification 12/12 + 660/660, typecheck clean, CI green on four jobs.

## Reproduced baseline on main `431e93d` (2026-09-20, coordinator)

`pnpm test` **638/638 pass** (12 + 626), exit 0, 214s. `pnpm --filter web typecheck` clean and
`pnpm --filter web test` 5 files pass. Any lane merged from here must hold this line or explain why.

## After the SSD eject and reconnect (verified 2026-09-20, coordinator)

The drive was ejected and is back. Verified rather than assumed: repository intact at **`ff2202e`**,
only `docs/CHECKPOINT.md` modified (the live copy); three worktrees as expected. **Every runtime process
died** — the PostgreSQL cluster, the Cutroom stand-in engine (PIDs 6937/6939) and the owner preview are
all gone. Cluster restarted with `./scripts/db-start.sh` and listening on 55432. `pnpm state` re-read:
owner database still **0001–0009**, API false — unchanged by the eject. Android toolchain checked:
`adb` on PATH, AVD `KnowScroll_API36` present, no device attached.

**Not restarted yet:** the Cutroom stand-in engine, and the owner preview. Neither is needed for the
Android slice; restart on demand.

## Running processes on this Mac (not guaranteed across reboot or SSD eject)

- **Cutroom stand-in engine** from main since 2026-09-19T22:00Z: instance
  `$KS_DEV_ROOT/cutroom/instances/owner-local-standin`, **API PID 6937 on 127.0.0.1:4390**, **worker PID 6939**,
  providers `standin`, no stand-in script (a real request fails at the first model call — honest).
  `CUTROOM_BASE_URL=http://127.0.0.1:4390` is set in the owner `.env` (that line only). SIGTERM both PIDs to stop.
- **Owner-facing demo** started 2026-09-20 on throwaway database `knowscroll_demo_ui`: API on
  127.0.0.1:4310, web on **http://127.0.0.1:4392**. Owner data untouched. Kill by port when done.

## Owner decisions and unresolved gates

- **Decided:** Cutroom runs on this Mac; source, SQLite, media, caches, logs on SSD.
- **Decided:** completed/failed private prompts retire after seven days; Clear immediate.
- **Decided 2026-09-20:** KnowScroll does **not develop or modify Cutroom**; integrate only against the
  published [reel-contract](https://github.com/KnowScroll/Cutroom/blob/main/docs/features/reel-contract.md).
- **Decided 2026-09-20:** live test cap **$2 total**, only **after upstream ships real providers**; not
  authorized now, and enforced in migration 0013. H3 = fal [MiniMax H3 Max](https://fal.ai/minimax-h3-max),
  key in owner `.env`, used only by Cutroom's providers (value never read).
- **Decided 2026-09-20:** desktop surface = TypeScript web app (ADR-0022, #92).
- **Decided 2026-09-20:** sign-in is an **email magic link** and **v1 is single-user** (ADR-0026).
- **Decided 2026-09-20:** mail runs through **AgentMail**, inbox and sign-in address `knowscroll@agentmail.to`,
  key in `AGENTMAIL_API_KEY` (ADR-0027). No worker lane is given the key.
- **Decided 2026-09-20:** UI work proceeds **web first, then Android**, matching the agreed interface
  exactly, with no new steering from the owner.
- **Resolved 2026-09-20:** the owner replaced the AgentMail key; `GET /v0/inboxes` now returns
  `knowscroll@agentmail.to`. [#109](https://github.com/KnowScroll/knowscroll/issues/109) closed with the
  full loop proved on a disposable database. Two client-side gotchas recorded there: AgentMail message
  ids must be percent-encoded in a path, and the consume route is `POST /v1/auth/session` with the token
  in the body — not a POST to the GET-only confirmation URL.
- **Open:** owner rollout of migrations 0010–0016 — separate, evidence-backed, not attempted.
- **Open:** a #94 worker once echoed a lane `DATABASE_URL` (with the local PostgreSQL password) into its
  own terminal. Swept: present in no repo file, tracked content or artifact — only in three local worker
  transcripts beside the `.env` files that already hold it. Agent definition hardened (`161090f`).
  **Rotation offered to the owner; not done, no answer.**
- Historical [#57](https://github.com/KnowScroll/knowscroll/issues/57) stays open; cause unknown.

## Active lanes (2026-09-21 morning)

| Branch | Worktree | Slice | State |
|---|---|---|---|
None. All seven wave PRs are merged (#118, #120, #121, #122, #124, #125, #127).

All four wave lanes are **merged**: #118 Android Cosmos, #120 web Cosmos, #121 web system level,
#122 Android system level, #124 privacy panel, #125 composer coverage. Main is at `a867aea` plus
the privacy and composer merges.

**#126, found by restarting the demo from main and not by any test.** Privacy merged as `0020`;
the composer's migrations then merged *behind* it as `0018`/`0019`, so **every database already
carrying `0020` was permanently unable to migrate forward** -- `runMigrations` refuses, correctly,
because the applied set is no longer an ordered prefix. The owner database is unaffected (still at
`0009`, so it applies everything in order). CI could not see it: `scripts/test.sh` builds a fresh
database per run, so everything rebuilt from scratch stayed green while every long-lived database
broke. Same blind spot as #115, from a third direction.

Fixed by renumbering to `0022`/`0023`/`0024`, which is only safe while the sole databases carrying
`0018`/`0019` are disposable -- an argument for doing it immediately rather than later. Proved
against a real database: a genuine pre-composer ledger of 18 migrations ending at
`0020_privacy_lifecycle.sql` now migrates forward through all three. A committed
`packages/db/migrations/RELEASED.txt` plus a test in `tests/migrations.test.ts` makes the *class*
fail in CI instead of in a database; proved red with a fake `0018` inserted behind.

**The composer lane's remote branch was stale and the builder correctly refused to force-push over
it** (that was on its "never do" list). Resolved by pushing the rebased history under a new name,
`claude/113-composer-coverage`, rather than rewriting `claude/114-composer`.

**#113's guarantee is proved, not asserted.** Red: under the hash-only tie-break all six minor
sources went **unoffered across 15 consecutive decisions** -- deterministic, because the FNV-1a
hash separation was precomputed rather than left to chance. Green: every source offered by
**decision 3**, against an asserted bound of 6. The restructuring of `tests/worlds.test.ts` was
shown necessary too: restoring the original file reproduced #113's exact failure class, 6 of 12
failing with `seeded library must contain an orbits Scroll`. The ranking change is a **new policy
version** (`composer-signals-v2`, migration `0021`) with `v1` left immutable, per
`packages/core/AGENTS.md`'s rule that ranking changes never edit a code constant in place.

**Merge order mattered and cost a PR.** `claude/112-cosmos-ui` carried #111's *red* fidelity tests
without the restyle that turns them green, so its Android job failed (#117, closed). Android had to
land first; the web commits were then cherry-picked onto `89288d9` as #120.

Merged and removable: `claude/113-worlds`, `claude/115-privacy`, `claude/111-android-ui`,
`claude/112-web-cosmos`, `claude/116-system-view` (superseded by `-2`). `claude-handoff` (#88) and `revisit` remain from
earlier work.

## Delivered — #107 (PR #110 → `ff2202e`): why six rounds

The builder's restyle was structurally good and its evidence was real, but three defects were invisible
to every check it ran: screenshots assert nothing about behaviour and jsdom has no layout. Reproducing it
found five, including the page scrolling instead of the article, which silently emptied reading-position
persistence. Each subsequent review then rejected the **coordinator's own fixes**:

1. Round 1 (builder): stage jumped 170px on opening Sources; page scrolled, not the article; `↓` took
   reading away from the keyboard; the "intermittent flake" was that rebinding, not timing; `Kept` dimmed.
2. Round 2 (mine): the `≤700px` rail collapse was dead code (cascade order), leaving **Keep unreachable**
   at 700×560 and similar; the bounded reader clipped the why-sheet; the three-track grid was an
   undeclared invention that broke centring.
3. Round 3 (mine): the source sheet clipped the same way one element over, hiding **evidence access**
   (law 9); and the cascade bug was **recreated** while fixing it. Fixed structurally: every base rule
   now sits above the media queries that narrow it.
4. Round 4 (mine): reading position was silently inert below 700px — the JS watched an element that no
   longer scrolls. It had been masked by round 3's dead media query, which kept the article scrollable by
   accident. One bug was hiding another.
5. Round 5 (mine): rejected for a **false claim**, not a defect — the commit and evidence said dual
   listeners meant a resize across the breakpoint did not strand the reader; measured, it dropped them to
   the top and their next scroll overwrote the stored depth. Made true rather than softened: depth now
   migrates as a fraction of the scrollable range.

Lesson recorded rather than smoothed over: "the journey passes" predicted correctness poorly three times
running. Tests are now verified **red before green** — run against the pre-fix source to prove they fail —
because one earlier case (`1024×560`) turned out not to discriminate at all.

## Morning of 2026-09-21: what the owner can open, and what is still in flight

The owner asked for a morning demo on **app and web** covering identity and privacy, the complete
UI, discovery and reasoning, and living worlds -- a **tested vertical slice of each** -- and
specifically to see **two planets and one solar system**.

**Merged overnight (CI green):** PR #112 -> `974ba24` evidence-backed semantic worlds (migration
`0017`, ADR-0028); PR #114 -> `3dcb492` privacy lifecycle pause/export/reset (migration `0020`,
ADR-0030). `claude/113-worlds` and `claude/115-privacy` are therefore behind main; their worktrees
can be removed.

**In flight this morning, in dependency order** (111 must land first: `claude/112-cosmos-ui`
carries #111's red fidelity tests but not the restyle that makes them green, which is exactly why
PR #117's Android job failed):

| PR | Branch | Slice | State |
|---|---|---|---|
| [#118](https://github.com/KnowScroll/knowscroll/pull/118) | `claude/111-android-cosmos` | Android Cosmos interface + a way to prove it | CI running |
| [#117](https://github.com/KnowScroll/knowscroll/pull/117) | `claude/112-cosmos-ui` | the web Cosmos/LO rebuild, spec sec.4b/5b/5c, demo populator | waiting on #118 |
| — | `claude/116-system-view` | the system level on web: two planets, one system | verified locally, PR after #117 |
| — | `claude/117-android-system` | the system level on Android ([#116](https://github.com/KnowScroll/knowscroll/issues/116)) | worker in flight |
| — | `claude/114-composer` | real ranking (#5) | **blocked on [#113](https://github.com/KnowScroll/knowscroll/issues/113)**, an owner policy call |

**The two planets and the system are real, and were read off a running API.** On demo database
`knowscroll_demo_morning`, `GET /v1/worlds` returns `derivationMethod: shared_source_v1` and one
system of two worlds: *NASA · Orbits and Kepler's Laws · DEMO DATA* (9 Scrolls, 9 seen -> FULLY
EXPLORED) and *NASA · Stars* (8 Scrolls, 3 seen -> MORE TO EXPLORE). Two source URLs -> two worlds
-> one system, derived from recorded exposures and recomputable from the event log. Nothing is
invented; the demo library is marked so a screenshot can never pass as runtime evidence.

**Owner-facing demo running now** (kill by port when done): API **127.0.0.1:4310** and web
**http://127.0.0.1:4392** from the `116-system-view` worktree against `knowscroll_demo_morning`.
The owner database is untouched. The previous demo processes had died with the SSD eject; these
are new.

**#120 merged a completely dead web surface, and every check was green. This is the single most
important finding of the wave.** `f8efeca` shipped `apps/web`'s `.strict()` universe schema without
`recordingPausedAt`, a field ADR-0030 had already added to `GET /v1/universe` when #114 merged. Every
universe load failed against a healthy 200 server. Running the web journey against `f8efeca` fails
**12 of 12** specs that touch the app, each at ~8.6s because the universe never loads. `bd0cc3f`
(#121) carries the fix, so main is repaired -- but only because that lane happened to contain it.

Nothing would have told us: CI's `backend` and `android` jobs both passed (neither runs the
journey, #115), and `apps/web`'s unit tests use a **hand-written** `universeOf()` fixture, so when
the server grows a field the fixture does not -- fixture and schema keep agreeing with each other
while both disagree with the server. The coordinator reproduced #120's typecheck and tests and
found them clean; they were clean *and the product was dead*.

Recorded on #115 with the failing output, plus the fix that would have prevented rather than
merely detected it: derive the client fixture from `packages/contracts` so it cannot drift.

**Merged main `bd0cc3f` is now journey-verified: 40/40 passed** against a real disposable
API/worker/PostgreSQL (`knowscroll_test_5d2c5f4e998690ee`, 2026-09-21T12:13Z). The broken window
between `f8efeca` and `bd0cc3f` is closed.

**Three fidelity defects the coordinator found by looking at the running build**, none of which
any assertion in this repository was watching for: the body canvas was laid out over the whole
screen so its bottom row ran under the "Enter Scroll" block; the map's scale label read
"SYSTEM VIEW" on Android while being an inert `Text` (a claim to a depth that surface could not
reach); and the system level was missing the dock that sec.5b calls the shared frame. All three
fixed, and `apps/web/e2e/91-universe-canvas-collisions.spec.ts` now measures the collision in a
real browser at both tested widths -- jsdom has no layout, and a screenshot asserts nothing.

**Identity is not demonstrable on web, and the reason is architectural rather than missing work.**
`apps/web` has no sign-in surface at all: by ADR-0022 the client *never holds a bearer token* --
`api/client.ts` says in its own header that it must never import, construct or reference one -- and
the Vite dev/preview proxy injects `Authorization` Node-side. A real web sign-in therefore needs a
session the browser can carry (a cookie, or an equivalent), which is a change to that security
boundary and belongs to #2, not to a morning. The magic-link loop itself is proved end to end
(#109, real mail, real inbox, replay refused 401) and Android has the signed-out screen and device
sign-out. Recorded as a gap with its cause, not worked around.

**What this wave does not deliver, and the owner is told:** social (#11), rooms and inhabitants
(#10 beyond geography), real Cutroom generation (blocked upstream on real providers and a Visual
Witness), the owner-database rollout of `0010`-`0020`, and journeys B-H.

## Next work

1. **Land what is in flight**: #122 (Android system level), #119 (web privacy panel), and the #113
   composer coverage guarantee once the owner has had a chance to overrule the recommendation.
2. **[#115](https://github.com/KnowScroll/knowscroll/issues/115): wire the web journey into CI, and
   derive `apps/web`'s test fixtures from `packages/contracts`.** Today proved why -- a merge passed
   every check while the web surface was completely dead. The fixture change prevents that class of
   defect rather than merely detecting it, and it is the cheaper of the two.
3. **[#123](https://github.com/KnowScroll/knowscroll/issues/123): the three timing-sensitive backend
   tests that flaked under CI load.** Not urgent in itself; urgent because a suite that cries wolf
   trains everyone to ignore a real red run.
4. **Identity on the web surface** is blocked on an architectural decision, not on work. ADR-0022
   keeps the browser from ever holding a bearer token, so a real sign-in needs a session the browser
   can carry. That belongs to #2 and needs the owner.
5. **The owner rollout of migrations `0010`-`0020`** on the owner's own database -- separate,
   evidence-backed, still not attempted.
6. Rooms and inhabitants (#10 beyond geography), social (#11), and real Cutroom generation, which
   stays blocked upstream on real providers and a Visual Witness.

## Progress reporting

[Project](https://github.com/orgs/KnowScroll/projects/1), issues #2–#12, [Owner Alpha](https://github.com/KnowScroll/knowscroll/milestone/2), #72.
Issue counts are bookkeeping, not a v1 percentage. Workers are Sonnet (`claude-sonnet-5`, forced);
the coordinator reproduces every claim before merge.

## The repository is now PUBLIC (2026-09-21, owner decision)

GitHub Actions stopped starting jobs mid-wave: *"The job was not started because recent account
payments have failed or your spending limit needs to be increased."* Public repositories get free,
unmetered standard runners, so the owner made `KnowScroll/knowscroll` **public** to restore CI,
intending to revert later. CI resumed immediately and is markedly faster (android 46s where it had
been 3m+), which incidentally supports #123's diagnosis that those flakes were runner contention.

Two things the owner was told and decided anyway, recorded so nobody re-litigates them:

- **Reverting to private does not undo exposure.** Forks, clones and caches survive it. If anything
  sensitive is in history, the remedy is rotation, not re-privatising.
- **Reverting also restores metered billing**, so the same block returns unless the payment or
  spending limit is fixed first.

A four-surface exposure audit was run at the moment of the switch — git history blobs including
deleted files, tracked files and workflow definitions, the committed evidence artifacts
(screenshots of a running app, axe dumps, receipts), and the GitHub surface itself (issues, PR
bodies, commit messages). A preliminary check before the switch found no real `.env` ever committed
(only `.env.example`) and no secret-shaped content across the last 400 commits.

**Still outstanding from before:** the local PostgreSQL password a #94 worker once echoed into a
transcript. Rotation was offered and never done. It is not in tracked content, and the database is
loopback-only, but it is the one known credential with a recorded exposure history.
