# Handover: KnowScroll v2 on dev (25 Oct 2026)

This run finished KnowScroll v2 through **dev**. Stage and the `main` PR were left out by the owner's choice.
Tracker: [#222](https://github.com/KnowScroll/knowscroll/issues/222). Current state: [`docs/STATUS.md`](../STATUS.md).

## Try it

Open **https://app.dev.knowscroll.space**, enter your email and use the link in the mail (sent by
AgentMail). A new account starts empty: read or watch a few things in Explore and your universe grows from
what you actually read.

A short tour:

1. **Explore:** swipe up (or, on desktop, ↓ on the focused player) for the next subject. Switch Reel ⇄ Scroll top right. Try a series (for
   example the Seasons or Tides Scrolls): the yellow Part tab moves along the series, the dashed tab to a
   related explanation. ⋯ holds every move, Share, Ask and Report.
2. **Keep:** save something, then find it in Keep.
3. **Universe:** after a few related Scrolls a system, star and planet form; open a planet and its regions.
4. **With a friend** (a second account): add each other in Friends, share a Reel into a thread, send a
   snippet (a Reel range, a passage or a block's setting), ask **What if…** and choose a direction, open the
   branch when it is ready, look at the map.
5. **Idea rooms:** open a room station on your universe map, join, talk, ask the AI Explainer or Skeptic
   (always labelled AI).
6. **Privacy:** Account → Privacy: pause recording, clear exploration, export, sharing and visibility.
7. **Desktop:** the same at full width (multi-pane Explore, Talk, Privacy); the keyboard map is under
   Account → Keyboard shortcuts.

## What was done in this run

Every slice below went through its own PR, one fresh review that reported blocking findings only, fixes,
green `checks`, and a dev promotion.

| Area | PRs |
|---|---|
| Generated library (54 Scrolls), topics, Planner, Cartographer, Composer buffers, Jev, production jobs, Universe, privacy and account | #393–#413 |
| Cutroom Reels (two new) and the real-money rule | #408, #417, #419, #424 |
| Conversations and share, operator views, native storage | #414–#416 |
| Explore as designed, threads and snippets, visibility and visits | #421, #425, #427 |
| What-if (two parts), idea rooms (two parts), desktop and accessibility (two parts) | #431, #433, #436–#439 |
| Model run churn, model budget share and Jev reuse | #428, #452 |
| Report and Not interested, request retry, series and related links | #446, #454, #457 |
| Design fidelity sweep and round 2 | #441, #443–#445, #447–#451, #453, #455, #456 |
| Journey fixes on dev | #442 |

Decisions made along the way are D-032 to D-059 in [`decisions.md`](decisions.md).

## Runtime evidence

- **Journeys on dev** with real sign-in, several disposable accounts, the real worker and MiniMax: results
  in #222 and below. Screenshots: `/Volumes/Mrigesh SSD/knowscroll-dev/v2/tmp/j222/` (first run) and
  `~/ks-fallback/tmp/j222/` (re-run).
- **Design fidelity:** [`design/fidelity.md`](design/fidelity.md) — 84 rows: 51 match, 22 differ, 2
  missing, 9 not checked, each with a reason and a before/after pair.

**Journeys on dev** (first run 24 Oct at `6dfb2d06`, re-run of the open steps 25 Oct at `3669673f`):

| Journey | Result |
|---|---|
| J1 encounter path | Pass. Format request is idempotent and never auto-switches; slider keeps the page still; series Part 2 and Related end cards work. Part/Related tabs on a **Reel** not run: dev's series links are Scroll to Scroll. |
| J2 content thread + What-if | Pass. One thread per create; no peer playback or "watching"; snippets carry revision and range only; What-if commissions only on a member's choice; speculative confirm; Preparing branch not selectable; return chip lands paused; "Opened by you" only for the opener. |
| J3 spatial | Pass. Map browsing writes no evidence; "From <region>" chip goes back like Back; "You were here"; visits show only shared parts; same room from two maps. |
| J4 recovery + privacy | Pass. Retry reuses the command id; catch-up in order under "While you were away"; revoked link reveals nothing; paused recording grows nothing and back-fills nothing; Clear advances the epoch and completes. |
| J5 Back step by step | Pass. Sheets close before navigation; closing a sheet resumes the Reel; Back lands paused at the same second. |
| Room | Pass. Join from the station; AI Explainer answers labelled; moderator pin; poll results only after voting; a room thread starts its own discussion. Report from a room message fixed in #459. |
| P03 and retry | Not interested + Undo pass; a saved Scroll marked Not interested still opens; abuse report receipt, the reported person sees nothing, moderator sees one report. Try again on "Couldn't prepare" not run: needs a real production failure. |

Found and fixed on dev: Reel did not resume after a sheet (#442); room report sheet closed itself (#459). Three
missing screen pieces from the first run were built (#448, #455, #456).

## Please confirm (decisions taken for you)

- **Reports about a deleted account** (D-055): abuse reports about a person who deletes their account are
  kept 90 days without any link to them, then purged; deleting it outright would let an abuser erase the
  evidence. The reporter's own reports go with the reporter.
- **Account settings on the device** (D-057): Ready notices, motion, text size and "Start Reels with sound"
  are stored per device and survive sign-out.
- **Background model share** (D-058): Jev, Cartographer and Planner may use at most 50% of the model
  budget, so What-if, room AI and requests keep working.

## Known gaps

- **Stage and `main`:** not done in this run. Stage still runs v1. Its v2 world exists on the server but
  needs the dev feature flags in `/etc/knowscroll/stage.v2.env`, `GRANT ks_pool_client TO ks2_stage`, then
  `scripts/promote.sh stage`, its own library run, `reel receive` and `rooms seed`.
- **Reels:** 7 Cutroom orders, 2 published. Cutroom's vision check (gate 5) stopped the others. Real fal
  spend was far above the pool's counted cents (about 5.6–6.6×, D-048). fal has $3.85 left of the
  owner's $9 top-up; ordering stops while the guard (balance − $5 ≥ $0.91) refuses.
- **Screen reader:** VoiceOver and TalkBack were not run; axe runs in CI. Please spot-check Explore and Talk.
- **iOS:** not exercised; Android runs in the emulator in Actions.
- **Not built:** What-if inside rooms; Reel branches (branches are Scrolls); retry of a failed branch;
  operator actions on reports; captions that follow narration (no caption track, D-054); a correction note
  on corrected content (no authored note in the content model); thumbnails on Keep cards (no field).
- **Design differences:** 22 rows in the fidelity table, each with its reason.
- **Jev calls:** it reuses assessments per subject for ten minutes, so a person swiping across many different
  subjects still makes about one call per encounter; the background share (D-058) keeps that from
  starving asked-for features.
- **Offline divider:** "While you were away" appears when a request failed during the gap; if the device is
  fully offline the query layer pauses and shows neither the banner nor the divider.

## Operations notes

- Server helpers (all for dev): `/root/reel.sh` and `/root/reel-order-one.sh` (Reel orders with the
  real-money guard), `/root/fal-balance.sh`, `/root/rooms.sh`, `/root/ks-dev-sign-in.sh` (disposable
  `@test.knowscroll.space` links only).
- `/etc/knowscroll/dev.v2.env` was edited by hand from the Ansible template's dev values; render it from
  Ansible next time the SSD tooling is used.
- The pre-F0 dev database copy `knowscroll_v2_dev_pre_f0_20261023` can be dropped.
- When the SSD is readable again: delete the browser session files `.state-*.json` in
  `/Volumes/Mrigesh SSD/knowscroll-dev/v2/tmp/j222/` and remove the worktree
  `/Volumes/Mrigesh SSD/knowscroll-worktrees/j222-rerun` (macOS blocked SSD access at the end of the run).
- Uncommitted work from worktrees made before the SSD outage is saved as patches in
  `/Volumes/Mrigesh SSD/knowscroll-dev/archive/pre-outage-worktrees-2026-10-24/`; it was superseded by the
  merged PRs.
