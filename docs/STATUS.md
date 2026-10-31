# Status

**Updated:** 2026-10-31 · **Tracker:** [#462](https://github.com/KnowScroll/knowscroll/issues/462) (v3 revamp; [#222](https://github.com/KnowScroll/knowscroll/issues/222) is the v2 history) · **Working flow:** `AGENTS.md` "How we work" (D-030) · **Handover (v2):** [`docs/v2/handover.md`](v2/handover.md)

**Current phase:** the v3 revamp (Universe, Scrolls, rooms, Talk). V0 is done; lanes U, S, T and R run in parallel, then the library waves and the final pass. Designs and the change map: `docs/v2/design/v3/`, `docs/v2/v3-revamp/`. Rulings D-060 to D-093; slice decisions from D-100.

| Lane | Merged | Open or next |
|---|---|---|
| U Universe | U-0 renderer (#501), U-1 look data (#513), U-2 space views (#521), U-3 quiet sweep (#519), U-4 globe and landed map (#529), U-5 search, orbit dial, Simple views (#534), Universe test fixes (#543) | U-6 friend visit and animations |
| S Scrolls | S-0 to S-3 (#503–#531: v2 Scrolls, the stage reader, Call it, the Final call, landmarks), S-5 Composer policy v1 and S-5b its numbers (#539, #554), S-6a regenerate and the answer check (#544), S-8a/b/c nine drawing kits (#540, #549, #551) | S-4 landmarks on the Universe (#561), S-6b kit recipes marked, library waves, S-7 Ask, S-8d new blocks, S-9 |
| T Talk | T-A to T-D (#504, #527, #533, #537: thread on a phone, look, SEEN, places), T-E Call it together (#555), T-F What-if cards (#560) | — |
| R Rooms | R-1 to R-3 (#505, #514, #528: Campfire, residents, asks), R-4 faces and backdrops (#535, #545, #553, #558) | R-5 today and the sky (#557), R-6 to R-10 |

Dev check fixes, round 1: #552 (issue #548).

**Decision numbers** are reserved in blocks so parallel slices do not collide: U D-100–D-119, S D-120–D-139 then D-180–D-210 and D-214 onward, T D-140–D-159 then D-211–D-213, R D-160–D-179.

**Migration numbers** are assigned in merge order: dev refuses a migration whose name sorts before one it has applied, so an open PR renumbers to the next free number just before it merges. Integration and dev are at `0084_scenario_answers`; R-5 takes `0085`.

## v3 build session (not the owner's Mac)

The v3 session runs on a friend's Windows PC with GitHub Write and VPS root SSH, and no provider keys (D-061). It translates the owner's paths in `AGENTS.md`:

| Owner's path | This session |
|---|---|
| `/Volumes/Mrigesh SSD/knowscroll-product` (shared checkout) | `C:/Users/XZNON/Knowscroll-v2` |
| `/Volumes/Mrigesh SSD/knowscroll-worktrees/<name>` | `C:/Users/XZNON/knowscroll-worktrees/<name>` |
| `/Volumes/Mrigesh SSD/knowscroll-dev/v2/tmp/<agent>/` | `C:/Users/XZNON/knowscroll-dev/tmp/<agent>/` |
| Commits as `Legend101Zz` | Commits as `XZNON` |

The checkout uses `core.autocrlf=false` (CI expects LF). A few tests fail only on this machine (media tooling, Windows timeouts, Docker clock drift); CI is the gate. The v3 design PDFs are kept outside Git in `C:/Users/XZNON/knowscroll-dev/design-v3/`. Real model calls run only on the server, through the dev worker and operator commands.

## Where things run

| Place | Revision | What it is |
|---|---|---|
| Integration branch `codex/release-knowscroll-v2` | schema 84 | All v2 and v3 work. `checks` green. |
| `dev` branch and dev host (`https://app.dev.knowscroll.space`) | `77c411f8`, schema 84 | v3 through T-E and T-F (exact commit: `/health`). |
| stage | `8982391f` | v1. Out of scope for this run. |
| main | `e5fdc319` | v1. Owner-only. |

Dev settings beyond the defaults (`/etc/knowscroll/dev.v2.env`; edited by hand, backups in `/root/dev.v2.env.bak-*`): `KS_PLANNER_ENABLED=1`, `KS_CARTOGRAPHER_ENABLED=1`, `KS_JEV_ENABLED=1`, `KS_REASONING_PRODUCTION_ENABLED=1`, `KS_SUPPLY_CREATE_DAILY_CAP=10`, `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP=5`, `KS_SUPPLY_SCENARIO_DAILY_CAP=6`, `KS_MINIMAX_REQUEST_TIMEOUT_MS=300000`, `KS_REASONING_GLOBAL_REQUESTS_PER_DAY=1000`, `KS_REASONING_GLOBAL_TOKENS_PER_DAY=10000000`. For room AI (30 Oct): `KS_REASONING_ROOM_ENABLED=1`, `KS_REASONING_ROOM_GENERATION=1`, `KS_REASONING_ROOM_REQUESTS_PER_DAY=150`, `KS_REASONING_ROOM_TOKENS_PER_DAY=1500000`, `KS_REASONING_AMBIENT_SHARE_PERCENT=30`. Composer policy (31 Oct, D-190): `KS_COMPOSER_POLICY=v1`. `KS_SUPPLY_SCENARIO_THREAD_CAP` is no longer read (D-158). Sign-in mail is sent by AgentMail.

## What works on dev (v3)

- **Universe:** the 3D map with looks, the globe, the landed map and region cards, search, the orbit dial, Simple views; room stations with their emblems.
- **Scrolls:** v2 Scrolls with the stage reader, Call it with sparks, the Final call and its payoff; nine drawing kits; Seasons Part 1 regenerated with the Final call (the other Seasons parts are being retaken after review). Every library Scroll is read by a person before `release`.
- **Recommendation:** Composer policy v1 (a pull-up leaves the topic more often), `activity.v1`, format learned per play level, `jev.2`; play results never feed ranking, evidence or formation.
- **Talk:** threads on a phone, replies and reactions, SEEN, the Paper theme, who is on which part, Call it together, What-if answer cards.
- **Rooms:** Campfire, Nova and Halley (AI, labelled), asking them by name, every room's face and a painted backdrop (MiniMax image model, $0.042 of the $1 cap).
- Everything from v2 keeps working (see the v2 handover).

## Design fidelity

`docs/v2/design/fidelity.md` lists every difference from the v3 designs with a one-line reason; the full v3 sweep is part of the final pass.

## Known gaps and owner decisions

Owner decisions taken on the owner's behalf are listed on #462 under "Waiting for owner". v2 gaps: [`docs/v2/handover.md`](v2/handover.md).

## Code to improve as you touch it

- `reasoning/application/execute-attempt.ts`: `executeAttempt` is one 300-line function. Split it into named steps like `propose.ts`.
- Root `lint` needs a 6 GB heap on the merged tree; typed lint will need splitting or more memory as the code grows.
- Room backdrops: the image model signs its prints whatever the prompt says; the band hides the outer tenth (D-177). A server-side crop would make the stored picture clean too.
