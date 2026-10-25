# Status

**Updated:** 2026-10-25 · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222) · **Working flow:** `AGENTS.md` "How we work" (D-030) · **Handover:** [`docs/v2/handover.md`](v2/handover.md)

**Current phase:** F0–F4 are done and every slice runs on dev. F5 on dev is done: journeys with real services and a design-fidelity sweep. Stage and the `main` PR are out of scope for this run (owner, 25 Oct); stage still runs v1.

## Where things run

| Place | Revision | What it is |
|---|---|---|
| Integration branch `codex/release-knowscroll-v2` | schema 68 | All v2 work. `checks` green. Protected from deletion by its own ruleset. |
| `dev` branch and dev host (`https://app.dev.knowscroll.space`) | schema 68; the same tree as integration (exact commit: `/health`) | v2, promoted by PR after this page (the last promotion carries #459 and this page). |
| stage | `8982391f` | v1. The v2 stage world exists on the server but is not configured or promoted. |
| main | `e5fdc319` | v1. Owner-only. |

Dev settings beyond the defaults (`/etc/knowscroll/dev.v2.env`; edited by hand from the Ansible template's dev values, backups in `/root/dev.v2.env.bak-*`): `KS_PLANNER_ENABLED=1`, `KS_CARTOGRAPHER_ENABLED=1`, `KS_JEV_ENABLED=1`, `KS_REASONING_PRODUCTION_ENABLED=1`, `KS_SUPPLY_CREATE_DAILY_CAP=10`, `KS_SUPPLY_PLANNER_CREATE_DAILY_CAP=5`, `KS_SUPPLY_SCENARIO_DAILY_CAP=6`, `KS_SUPPLY_SCENARIO_THREAD_CAP=6`, `KS_MINIMAX_REQUEST_TIMEOUT_MS=300000`. `KS_REASONING_BACKGROUND_SHARE_PERCENT` uses its default (50). Sign-in mail is sent by AgentMail. The role `ks2_ops_reader` exists (no login) for the ops views.

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
