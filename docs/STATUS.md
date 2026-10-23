# Status

**Updated:** 2026-10-24 · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222) · **Working flow:** `AGENTS.md` "How we work" (D-030)

**Current phase:** F0 done; F1 (real Scrolls) and the first F2 slices in progress. A Claude coordinator (Opus 5.5) runs the finishing phases with Sonnet 5.5 agents. Agent briefs are on the SSD in `knowscroll-dev/v2/agents/`.

## Where things run

| Place | Revision | What it is |
|---|---|---|
| Integration branch `codex/release-knowscroll-v2` | `9b82c754`, schema 44 | All v2 work. `checks` green. Protected from deletion by its own ruleset. |
| `dev` branch and dev host (`app.dev.knowscroll.space`) | `992bbfdf`, schema 44 | v2, promoted through the D-002 PR (#392) on 24 Oct. Database recreated empty first. |
| stage | `8982391f` | v1. |
| main | `e5fdc319` | v1. Owner-only. |

## What works on dev today (F0, 24 Oct)

Checked with a disposable account (`f0-asha@test.knowscroll.space`) at phone width:

- Operator sign-in link → "Continue as …" → signed in.
- Explore opens a Reel (three approved v1 Cutroom Reels were imported) and plays it. The authored starter Scroll "Why the sky is blue" reads well.
- Universe shows its empty state; Talk says conversations are not available; Keep is empty.
- **Broken:** "Next subject" serves the Reel you are already watching (Composer does not exclude the current exposure). Being fixed in #234.
- **Far from the design:** the Explore Reel screen has no overlay actions, topic chip or progress; Keep and Talk use operational copy ("End of this traversal"). The Scroll reader shows a dev-only evidence panel.
- No generated content exists yet, so there are no topics, no planets and no Scroll twins for Reels.

Local baseline on the Mac: typecheck and lint pass; 944 of 953 integration and 601 of 604 backend unit tests pass. The 12 failures are media and Cutroom import tests that refuse macOS's `/var → /private/var` temp symlink; they pass in CI.

## What exists and works in source

Covered by `checks` (unit tests plus about 885 integration tests against real PostgreSQL):

- **Foundation:** Nest API and worker around a framework-free core; Kysely; pg-boss with in-transaction enqueue; `withPersonalScope`; command receipts; erasure registry; NOTIFY plus Socket.IO hints for the universe scope.
- **Identity:** magic-link sign-in, sessions, AccountScope.
- **Scrolls and Reels:** `scroll-document.v1` with 17 block types and the renderer; MediaStore with range delivery; Reel player; import of existing Cutroom Reels.
- **Explore:** Composer v0 (eligibility, mode fit, MMR, exploration), navigation sessions, recorder, observations, evidence qualification and activity, Saved/Keep with places and Undo.
- **Personal context:** projections; Planner and Cartographer roles exist but are **off by default** (`KS_PLANNER_ENABLED=0`, `KS_CARTOGRAPHER_ENABLED=0`).
- **Universe:** geography, scene projection, a layered-SVG map, region encounters, formation presentation.
- **Supply:** user content requests with Reuse and Join; no Create path.
- **Reasoning harness:** business runs, attempt ledger, MiniMax adapter.
- **Cutroom:** commissioning and receiving code, **off by default**, never used for a real order.
- **Social:** Friends graph, rosters, invites.
- **Privacy:** selective Clear; Pause recording (merged in #388, never exercised on a running system).
- **Client:** sign-in, Explore, Reel/Scroll, Keep, Universe, Friends (reached only from Talk), Account, Privacy.

## What is missing

- **Generated Scrolls:** none accepted, ever. Each writer attempt failed output parsing or validation (tool JSON invalid, schema mismatch, invalid diagram cells). Production runs only from an operator command; no worker job is registered (`modules/content/production/README.md`).
- **Topics on content:** the topic-coverage approval list is empty, so no content carries topics and the reading-to-planet loop cannot fire (`modules/content/README.md`).
- **Connected loops:** Planner→Composer, Composer supply gap→Quartermaster and Quartermaster→production are not wired. Worker-prepared Composer buffers and Jev are absent.
- **Social half (blueprint §14, §17):** content shares and the share landing, conversations, content threads, snippets, the episode navigator, What-if and perspective explorations, the Scenario Planner, idea rooms with moderator and AI inhabitants, friend visit (U06), and visibility settings (F02).
- **Privacy and account:** export, account deletion, session management and share revocation.
- **Platform and operations:** desktop multi-pane layouts (D01–D05), the Operator screen, ops views and the journey CLI, native persistent storage (it is memory-only today), and Android journeys beyond the gallery.
- **Design fidelity:** about 40% of the v2.1 phone frames are wired. Keep, Friends and Universe look like utility screens rather than the designs.
- **Delivery:** the dev promotion PR, real-service journeys J1–J5, stage, and the release handover.

## Code to improve as you touch it (audit, 23 Oct)

- `modules/experience/application/navigation.ts`: `prepare()` is 236 lines with single-letter names. Its snapshot-trimming loop re-serialises up to 100 times.
- `reasoning/application/propose.ts`: `makeBoundPersonalHarness` is a 194-line closure with shared mutable flags, and an opportunistic purge its TSDoc omits.
- `modules/social`: the roster cursor is AES-encrypted with a process-random key, so cursors die on restart and cannot work across instances.
- `modules/*/adapters/erasure.ts`: each builds its Clear dispositions with the same `Object.fromEntries` boilerplate and a post-hoc `clearExploration` assignment. (`erasure-registry.ts` is a plain list since #403.)
- `reasoning/domain/output.ts`: walks Zod internals.
- About 67 words are glued to numbers in READMEs ("Migration0028"), and README tails are organised by issue number.

## Unmerged work kept on origin

| Branch | What it is |
|---|---|
| `codex/242-core-recovery-observable-state`, `codex/242-ui-final-core-corrections` | Conversations client core and UI, work in progress. No backend. |
| `codex/249-native-current44`, `codex/249-native-provider-fixture`, `codex/249-native-sdk-harness` | Encrypted native storage, work in progress. |
| `codex/374-social-http`, `codex/363-formation-backend` | Probably superseded by #386 and #375; check before reuse. |
| `codex/240-beam-angle-script` (PR #379) | An owner-approved Sun-angle Reel script. |

## Housekeeping done on 23 Oct

- **Worktrees and scratch:** 139 worktrees removed (all were clean). About 43 GB of Codex scratch deleted from `/Volumes/Mrigesh SSD/knowscroll-dev/v2/`.
- **Archive:** `/Volumes/Mrigesh SSD/knowscroll-dev/archive/codex-v2-2026-10-23/` holds every local branch and every deleted remote branch as git bundles, Codex's text records, and the evidence screenshots.
- **Removed from the repo:** the dead workflows for Codex's v12 launch proof and their fixtures.
- **GitHub:** closed Codex child issues whose code merged, closed v1 issues replaced by v2, and closed the probe PRs.

## Active agents

| Agent | Issue | Branch / worktree | What |
|---|---|---|---|
| w232 | #232 | `claude/232-working-writer` | Scroll writer on `MiniMax-M3.1-Flash`, visible failures |
| t237 | #237 | `claude/237-library-topics` | 50–60 recipe library plan; code-owned topic coverage |
| c234 | #234 | `claude/234-composer-buffers` | Worker-prepared buffers, Jev, the "Next repeats" bug |
| p236 | #236 | `claude/236-planner-loop` | Planner on, wired to Composer and Quartermaster |

Each agent's worktree is `/Volumes/Mrigesh SSD/knowscroll-worktrees/<issue>-<slug>` and its PostgreSQL runs under `knowscroll-dev/v2/tmp/<agent>/`.

## Provider facts learned

- `MiniMax-M3.1-Flash` refuses `thinking: {type: "disabled"}` (HTTP 400, code 2013). Use `adaptive` and discard thinking blocks.
- fal balance on 24 Oct: $11.99, enough for the $4 Reel budget.

## Next

Merge the F1 slices, run production jobs for the library on dev, then the F2 loops and Reels (#222).
