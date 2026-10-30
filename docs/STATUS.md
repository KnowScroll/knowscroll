# Status

**Updated:** 2026-10-30 · **Tracker:** [#462](https://github.com/KnowScroll/knowscroll/issues/462) (v3 revamp; [#222](https://github.com/KnowScroll/knowscroll/issues/222) is the v2 history) · **Working flow:** `AGENTS.md` "How we work" (D-030) · **Handover (v2):** [`docs/v2/handover.md`](v2/handover.md)

**Current phase:** the v3 revamp (Universe, Scrolls, rooms, Talk). V0 is done; lanes U, S, T and R are running in parallel. Designs and the change map: `docs/v2/design/v3/`, `docs/v2/v3-revamp/`. Rulings D-060 to D-093; slice decisions from D-100.

| Lane | Merged | Open or next |
|---|---|---|
| U Universe | U-0 three.js renderer gate (#501), U-1 look data (#513) | U-2 space views, U-3 quiet sweep |
| S Scrolls | S-0 writer spike (#503), S-1a stage physics (#507), S-1b v2 admission and coverage v2 (#508), S-1c Stage + Spine reader (#511, #515), S-1d next leaves the series (#510) | S-1e Seasons v2 behind a review gate (#516), S-2 Call it and the play module |
| T Talk | T-A thread on a phone (#504) | T-B Universe look and DM basics |
| R Rooms | R-1 Campfire, presence, keep-out (#505) | R-2 residents (#514) |

**Decision numbers** are reserved in blocks so parallel slices do not collide: U D-100–D-119, S D-120–D-139 then D-180–D-199, T D-140–D-159, R D-160–D-179.

**Dev on 30 Oct:** runs `4a56e4a2` (V0, S-0, T-A, R-1, S-1a; migration `0069_room_campfire`). The promotion with U-0, S-1b and S-1c (#512) merged to `dev` but its deploy was refused by a flaky reader test, since fixed (#515); the next promotion carries it. T-A and R-1 were used on dev at 390 × 844 and 1440 × 900.

## v3 build session (not the owner's Mac)

The v3 session runs on a friend's Windows PC with GitHub Write and VPS root SSH, and no provider keys (D-061). It translates the owner's paths in `AGENTS.md`:

| Owner's path | This session |
|---|---|
| `/Volumes/Mrigesh SSD/knowscroll-product` (shared checkout) | `C:/Users/XZNON/Knowscroll-v2` |
| `/Volumes/Mrigesh SSD/knowscroll-worktrees/<name>` | `C:/Users/XZNON/knowscroll-worktrees/<name>` |
| `/Volumes/Mrigesh SSD/knowscroll-dev/v2/tmp/<agent>/` | `C:/Users/XZNON/knowscroll-dev/tmp/<agent>/` |
| Commits as `Legend101Zz` | Commits as `XZNON` |

The checkout uses `core.autocrlf=false` (CI expects LF). A few tests fail only on this machine (media tooling, Windows timeouts); CI is the gate. The v3 design PDFs are kept outside Git in `C:/Users/XZNON/knowscroll-dev/design-v3/`.

## Where things run

| Place | Revision | What it is |
|---|---|---|
| Integration branch `codex/release-knowscroll-v2` | schema 68 | All v2 work. `checks` green. Protected from deletion by its own ruleset. |
| `dev` branch and dev host (`https://app.dev.knowscroll.space`) | schema 68; the same tree as integration (exact commit: `/health`) | v2, promoted by PR after this page (the last promotion carries #459 and this page). |
| stage | `8982391f` | v1. The v2 stage world exists on the server but is not configured or promoted. |
| main | `e5fdc319` | v1. Owner-only. |

Dev settings beyond the defaults (`/etc/knowscroll/dev.v2.env`; edited by hand from the Ansible template's dev values, backups in `/root/dev.v2.env.bak-*`): `KS_PLANNER_ENABLED=1`, `KS_CARTOGRAPHER_ENABLED=1`, `KS_JEV_ENABLED=1`, `KS_REASONING_PRODUCTION_ENABLED=1`, `KS_SUPPLY_CREATE_DAILY_CAP=10`, `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP=5`, `KS_SUPPLY_SCENARIO_DAILY_CAP=6`, `KS_SUPPLY_SCENARIO_THREAD_CAP=6`, `KS_MINIMAX_REQUEST_TIMEOUT_MS=300000`. `KS_REASONING_BACKGROUND_SHARE_PERCENT` uses its default (50). Raised for v3 room AI on 30 Oct (CHANGE-MAP §3): `KS_REASONING_GLOBAL_REQUESTS_PER_DAY=1000`, `KS_REASONING_GLOBAL_TOKENS_PER_DAY=10000000` (were 300 and 3,000,000; backup `/root/dev.v2.env.bak-20261030T115551Z`). Sign-in mail is sent by AgentMail. The role `ks2_ops_reader` exists (no login) for the ops views.

**Migration numbers** are assigned in merge order: dev refuses a migration whose name sorts before one it has applied, so an open PR renumbers to the next free number just before it merges.

## What works on dev

- **Sign-in** by email link (AgentMail), sessions, export, account deletion, privacy Clear, Pause recording.
- **Library:** 54 Scrolls by `MiniMax-M3.1-Flash` (32 interactive), 6 systems, 17 planets; 11 series and related moves admitted (`content admit-continuity`).
- **Reels:** two new Cutroom Reels (stars-fusion, exoplanet-transit), each the twin of a Scroll, plus three imported v1 Reels.
- **Explore** as designed (E01–E08, N01, A01), Keep (S01), request states and retry (E07), Part and Related tabs.
- **Personal universe:** Planner, Cartographer (paced, D-052), Jev (reuses assessments, D-058), formation, Universe screens U01–U08, region chip and "You were here".
- **Social:** friends, conversations, share links, content threads with snippets, What-if and Another perspective with the map (X01–X04), idea rooms with labelled AI inhabitants, polls and quizzes (R01–R03), visibility and friend visits.
- **Safety:** Not interested, content-error and abuse reports (P03), room moderation, Operator screen.
- **Platform:** desktop layouts (D01–D05, V01), keyboard map, axe in CI, native encrypted storage and Android emulator journeys.

## Design fidelity

`docs/v2/design/fidelity.md`: 84 rows — 51 match, 22 differ, 2 missing, 9 not checked. Each difference has a one-line reason.

## Known gaps and owner decisions

See [`docs/v2/handover.md`](v2/handover.md).

## Code to improve as you touch it

- `reasoning/application/execute-attempt.ts`: `executeAttempt` is one 300-line function. Split it into named steps like `propose.ts`.
- Root `lint` needs a 6 GB heap on the merged tree; typed lint will need splitting or more memory as the code grows.
- A Composer test (`compose.test.ts`) failed once locally with seed 672395464; investigate before it flakes in CI.
