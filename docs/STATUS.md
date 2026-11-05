# Status

**Updated:** 2026-11-05 · **Tracker:** [#661](https://github.com/KnowScroll/knowscroll/issues/661) (owner feedback), [#462](https://github.com/KnowScroll/knowscroll/issues/462) (v3 revamp; [#222](https://github.com/KnowScroll/knowscroll/issues/222) is the v2 history) · **Working flow:** `AGENTS.md` "How we work" (D-030) · **Handover:** [`docs/v2/v3-revamp/handover.md`](v2/v3-revamp/handover.md) (v2: [`docs/v2/handover.md`](v2/handover.md))

**Current phase:** the v3 revamp is built and on dev: the new Universe, V3 Scrolls, R3 rooms and T3 Talk, with the backend and algorithm change behind each screen. The fidelity sweep, the journeys and the handover are done. Stage, live and the `main` PR are out of scope for this run.

## Where things run

| Place | Revision | What it is |
|---|---|---|
| Contributor PR base and target | `dev` | Start from freshly fetched `origin/dev` (D-394). |
| Dev host | [Live revision and migration](https://app.dev.knowscroll.space/health) | Verify the deployed commit after each merge to dev. |
| stage | `8982391f` | v1. Out of scope for this run. |
| main | `e5fdc319` | v1. Owner-only. |

Dev settings beyond the defaults (`/etc/knowscroll/dev.v2.env`, edited by hand; backups in `/root/dev.v2.env.bak-*`): `KS_PLANNER_ENABLED=1`, `KS_CARTOGRAPHER_ENABLED=1`, `KS_JEV_ENABLED=1`, `KS_REASONING_PRODUCTION_ENABLED=1`, `KS_SUPPLY_CREATE_DAILY_CAP=10`, `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP=5`, `KS_SUPPLY_SCENARIO_DAILY_CAP=6`, `KS_MINIMAX_REQUEST_TIMEOUT_MS=300000`, `KS_REASONING_GLOBAL_REQUESTS_PER_DAY=1000`, `KS_REASONING_GLOBAL_TOKENS_PER_DAY=10000000`. Room AI: `KS_REASONING_ROOM_ENABLED=1`, `KS_REASONING_ROOM_GENERATION=1`, `KS_REASONING_ROOM_REQUESTS_PER_DAY=150`, `KS_REASONING_ROOM_TOKENS_PER_DAY=1500000`, `KS_REASONING_AMBIENT_SHARE_PERCENT=30`, `KS_ROOMS_FEED_ENABLED=1`, `KS_ROOMS_STARS_PER_DAY=10`. Recommendation: `KS_COMPOSER_POLICY=v1`. Asks: `KS_SUPPLY_ASK_DAILY_CAP=20`, `KS_SUPPLY_ASK_PERSON_DAILY_CAP=5`, `KS_SUPPLY_QUICK_ANSWER_DAILY_CAP=20`. Scouts are off (`KS_ROOMS_SCOUTS_ENABLED` unset). How to turn each off: the handover, "Recovery and rollback".

**Decision numbers** run to D-393 (v3 from D-060). **Migration numbers** are assigned in merge order: dev refuses a migration whose name sorts before one it has applied, so an open PR renumbers to the next free number just before it merges.

## What works on dev (v3)

Every item below was used on dev at 390 × 844 in this run, and at 1440 × 900 where the fidelity table shows a shot. The handover lists the evidence and what was not seen on dev.

- **Universe:** the three.js map with planet looks, the globe and landed map, region cards, search, the orbit dial, Simple views, friend visits, first-open and fly-in animations, landmarks as one folding card. Browsing writes no evidence.
- **Scrolls:** the stage reader with drawing kits; calls, sparks and the Final call; moving between Parts with "your place is kept"; the recap; the seven-row ••• sheet; Seasons Part 1 with the plot twist and cited distances (revision 4).
- **Ask:** ask orders (5 of 5 Ready on dev, each checked sentence by sentence against the library's sources) and Quick answers. Limits say which cap is full.
- **Recommendation:** Composer policy v1, format learned per topic, `jev.2`. Play results never feed ranking, planning, evidence or formation.
- **Talk:** the T3 thread on phone and desktop, places, Call it together and its reveal, What-if cards and branches, the new-since line, "In this chat".
- **Rooms:** Campfire, labelled AI residents with a feed and caps, Today, Spot the flaw, debates, the live Launch and its replay, the sky with each star's moment, flair, Watch together, moderation and reports.
- **Content:** 52 v2 library Scrolls released (21 with a stage), all read before release.

## Design fidelity

[`docs/v2/design/fidelity-v3.md`](v2/design/fidelity-v3.md): one row per v3 frame and width, before and after, each difference with its decision or an owner call (17 owner calls). The v2.1 table stays in `docs/v2/design/fidelity.md`.

## Known gaps and owner decisions

See the handover ("Known gaps", "Waiting for owner") and #462 "Waiting for owner".

## Code to improve as you touch it

- `reasoning/application/execute-attempt.ts`: `executeAttempt` is one 300-line function. Split it into named steps like `propose.ts`.
- Room backdrops: the image model signs its prints whatever the prompt says; the band hides the outer tenth (D-177). A server-side crop would make the stored picture clean too.
- The social inbox reads a thread's series with a few queries per root (`seriesOfRoots`); batch them.
- A native build older than #651 reads a document with stage figures or a reveal as invalid; there is no capability gate (D-384).
