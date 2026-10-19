# Checkpoint

Coordinator-owned. Hard cap ~120 lines: older detail moves to the tracker and issues. Verify Git, CI and deployed revisions before acting on anything here.

**Updated:** 2026-10-19 · **Phase:** 0 → 1 · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222)

## Where things are

| Item | Value |
|---|---|
| Integration branch | `codex/release-knowscroll-v2` (worktree `/Volumes/Mrigesh SSD/knowscroll-worktrees/v2-release`) |
| Legacy marker | tag `legacy/v1-final` → `106c4701` |
| Architecture snapshot source | branch `codex/72-personal-universe-architecture` @ `2a302917` |
| dev world | v1 at `106c4701` (`knowscroll_test_dev`); v2 not deployed yet |
| stage world | v1 at `8982391f`; v2 not deployed yet |
| live | not deployed (placeholder); owner-only |
| SSD work area | `/Volumes/Mrigesh SSD/knowscroll-dev/v2/` (discovery, evidence, design renders, caches, tmp) |

## Phase status

- **Phase 0 (#223):** discovery done (reports in `docs/v2/discovery/`); tracker #222 + sub-issues #223–#250 created as native sub-issues; v1 code/docs removed on the integration branch; new instructions, decision log (D-001…D-011) and carried-forward facts committed. Remaining: green `checks` on the pushed head.
- **Phase 1 (#224–#229):** next. Start with S1.1 (workspace + pinned matrix + CI), then S1.2/S1.3/S1.4 in parallel worktrees, S1.5 infrastructure, S1.6 thin journey.

## Owner decisions open (details on #222)

1. Cutroom budget for a new commission (pool has 83¢ of $7). 2. Mobile builds in CI / physical device. 3. Required `checks` on `dev`. 4. Personal-context model roles beyond test accounts. Defaults are stated on the tracker; work continues.

## Active agents

None.

## Known gaps / cautions

- The main-update hook only loads for sessions started inside a checkout; a session started from `~/Desktop` is not protected by it.
- `ks` cleanup deletes releases it does not know; v2 must be taught to it before the first v2 deploy (S1.5).
- No database backups exist on the VPS today (S1.5 adds them for v2).

## Next action

Push Phase 0, confirm `checks` green, then begin S1.1 with the verified dependency matrix.
