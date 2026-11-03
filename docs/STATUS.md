# Status

**Updated:** 2026-11-03 · **Tracker:** [#462](https://github.com/KnowScroll/knowscroll/issues/462) (v3 revamp; [#222](https://github.com/KnowScroll/knowscroll/issues/222) is the v2 history) · **Working flow:** `AGENTS.md` "How we work" (D-030) · **Handover:** [`docs/v2/v3-revamp/handover.md`](v2/v3-revamp/handover.md) (v2: [`docs/v2/handover.md`](v2/handover.md))

**Current phase:** the v3 revamp is built and on dev: the new Universe, V3 Scrolls, R3 rooms and T3 Talk, with the backend and algorithm change behind each screen. The fidelity sweep, the journeys and the handover are done. Stage, live and the `main` PR are out of scope for this run.

## Where things run

| Place | Revision | What it is |
|---|---|---|
| Integration branch `codex/release-knowscroll-v2` | schema 104 | All v2 and v3 work. `checks` green. |
| `dev` branch and dev host (`https://app.dev.knowscroll.space`) | `c34737e3`, migration `0104_draft_recording_paused` | v3 complete (exact commit: `/health`). |
| stage | `8982391f` | v1. Out of scope for this run. |
| main | `e5fdc319` | v1. Owner-only. |

Dev settings beyond the defaults are listed in the handover ("Recovery and rollback"). Env backups: `/root/dev.v2.env.bak-*`.

**Decision numbers** run to D-393 (v3 from D-060). **Migration numbers** are assigned in merge order: dev refuses a migration whose name sorts before one it has applied, so an open PR renumbers to the next free number just before it merges.

## What works on dev (v3)

Every item below was used on dev at 390 × 844 and 1440 × 900 in this run; the evidence is listed in the handover.

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
