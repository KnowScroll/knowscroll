# Checkpoint

Coordinator-owned. Hard cap ~120 lines: older detail moves to the tracker and issues. Verify Git, CI and deployed revisions before acting on anything here.

**Updated:** 2026-10-19 17:00 UTC · **Phase:** 1 · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222)

## Where things are

| Item | Value |
|---|---|
| Integration branch | `codex/release-knowscroll-v2` @ `98d51da4` (worktree `/Volumes/Mrigesh SSD/knowscroll-worktrees/v2-release`) |
| Legacy marker | tag `legacy/v1-final` → `106c4701` |
| dev world | **v2** `d7346d51` (S1.2), artifact `430c37a6…`, DB `knowscroll_v2_dev` at migration `0006_reasoning_ledger`, relay listening, Socket.IO via Caddy OK. v1 kept: `knowscroll_test_dev`, rollback target `106c4701` |
| stage world | v1 `8982391f` (v2 promotion planned after Phase 2 journeys pass on dev) |
| live | not deployed (placeholder); owner-only |
| VPS ops | Ansible applied from `9acf2ab6` (ks v2 manifests, v2 units, Caddy paths, nightly backup 02:23 UTC, weekly restore check Sun) |
| SSD work area | `/Volumes/Mrigesh SSD/knowscroll-dev/v2/` (discovery, evidence, design renders, agent scratch, coordinator scripts in `agents/coordinator/`) |

## Owner gate

**Phase 2 does not start without the owner's explicit approval (owner, 2026-10-19).** Finish Phase 1 (S1.3 #226, S1.4 #227, S1.6 #229), report, and ask. The pulled-forward Phase 2 items #230 (PR #254, head is a TEMPORARY diagnostic commit) and #231 (uncommitted work in `v2-231-harness`; 5 real MiniMax calls already made) are **paused** — do not resume or merge them before approval.

## Done

- Phase 0 (#223). S1.1 workspace + CI (#224, PR #252). S1.2 backend foundation (#225, PR #253). S1.5 infrastructure (#228, PRs #251 + #256): release built once in `checks`, deployed to dev by `deploy.yml`, rollback v2↔v1 exercised, backups + restore check verified.

## Open PRs / active agents (each in its own SSD worktree)

| PR | Sub-issue | State |
|---|---|---|
| #254 `codex/230-scroll-model` | S2.1 part 1 `scroll-document.v1` (Phase 2) | **paused by owner gate**; head is a temporary diagnostic commit |
| #255 `codex/227-client-foundation` | S1.4 client foundation | review BLOCK (web Enter on links) → fixes in progress |

S1.2 merged (#253, `d7346d51`, deployed to dev). Running: S1.3 identity (#226). Paused by the owner gate: #254, #231.

## Owner decisions (answered 2026-10-19, D-018…D-021)

Cutroom up to $2 for new v2 Reels (pool cap → 900¢ in S4.2); Android builds + emulator journeys in GitHub Actions (real phone later by the owner); `checks` required on `dev` (ruleset `25423111`); personal-context roles may use MiniMax for real users. Open: none.

## Known gaps / cautions

- The main-update hook only loads for sessions started inside a checkout; a session started from `~/Desktop` is not protected by it.
- `ks`: if killed between switching `current` and the health check, the old release is unreferenced and a later cleanup could delete it (accepted edge case).
- Socket.IO through Caddy is unproven until #253's gateway is deployed.

## Next action

Finish Phase 1: merge #255 after its fixes, finish S1.3 (#226), build S1.6 thin journey (#229) on dev, report, then ASK the owner before starting Phase 2.
