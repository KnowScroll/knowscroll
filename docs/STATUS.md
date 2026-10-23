# Status

**Updated:** 2026-10-23 · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222) · **Working flow:** `AGENTS.md` "How we work" (D-030)

The Codex coordinator was stopped on 2026-10-23. Its 708-line checkpoint is replaced by this page (the old text is in Git history at `d9fa95c5:docs/CHECKPOINT.md`).

## Where things run

| Place | Revision | What it is |
|---|---|---|
| Integration branch `codex/release-knowscroll-v2` | `d9fa95c5`, schema 44 | All v2 work. `checks` green. |
| dev host (`app.dev.knowscroll.space`) | `476baec5`, schema 35 | v2 deployed by hand on 22 Oct; 29 commits behind integration. |
| `dev` branch | `106c4701` | Still v1. v2 was never promoted through the D-002 PR. |
| stage | `8982391f` | v1. |
| main | `e5fdc319` | v1. Owner-only. |

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
- `erasure-registry.ts`: a 680-line prose manifest is hashed at import time.
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

## Next

Follow the phase plan in #222.
