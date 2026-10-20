# Checkpoint

Coordinator-owned. Hard cap ~120 lines: older detail moves to the tracker and issues. Verify Git, CI and deployed revisions before acting on anything here.

**Updated:** 2026-10-20 07:10 UTC · **Phase:** 2 (approved by the owner 2026-10-20) · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222)

## Where things are

| Item | Value |
|---|---|
| Integration branch | `codex/release-knowscroll-v2` @ `d467f664` + checkpoint commits (worktree `/Volumes/Mrigesh SSD/knowscroll-worktrees/v2-release`) |
| Legacy marker | tag `legacy/v1-final` → `106c4701` |
| dev world | **v2** `d467f664` (S1.3), artifact `c1d138fc…`, DB `knowscroll_v2_dev` at `0008_ops_operator_sign_ins`, relay listening; API + worker run as `ks2-dev`. Deployed by `deploy.yml` dispatch (run 39381429679). v1 kept: `knowscroll_test_dev`, rollback target `106c4701` |
| stage world | v1 `8982391f` (v2 promotion after the Phase 2 journeys pass on dev, D-004) |
| live | not deployed (placeholder); owner-only |
| VPS ops | Ansible applied from `d467f664` on 2026-10-20 (ok=109 changed=8): `ks2-<world>` users, `<world>.v2.env` sign-in settings, CSP + `X-Frame-Options`, unit sandboxing. Logs in `knowscroll-dev/v2/agents/coordinator/ansible-*-d467f664.log` |
| SSD work area | `/Volumes/Mrigesh SSD/knowscroll-dev/v2/` (evidence, design renders, agent scratch, coordinator prompts/scripts in `agents/coordinator/`) |

## Done

- Phase 0 (#223). Phase 1: S1.1 (#224, PR #252), S1.2 (#225, PR #253), S1.3 identity (#226, PR #257), S1.4 client foundation (#227, PR #255), S1.5 infrastructure (#228, PRs #251 + #256).
- S1.3 on dev verified 2026-10-20 (dev deployment, real database): operator link → peek 200 → redeem 200 (403 without Origin, 400 on reuse) → session epoch 1 → `GET /v1/saved` 200 with `X-KS-Scope` (409 without/wrong scope, 401 without session) → audit row → sign-out → 401. Evidence on #226.
- S1.6 thin journey (#229) moved into the first Phase 2 wave (needs `scroll-document.v1` from #254).

## Phase 2 plan (order)

1. #254 (S2.1 part 1) finish + re-review + merge; #231 S2.2 harness PR.
2. #229 S1.6 thin journey on dev; #230 part 2 Scroll renderers in `packages/ui` (both after #254).
3. #232 S2.3 Scroll production (≥ 3 real generated Scrolls, ≥ 2 interactive) — after #231, #230.
4. #233 S2.4 media + Reel player + Cutroom reuse import (greenhouse, seasons-v5, tides-v4) — after #229.
5. #234 S2.5 Explore (Composer v0, actions, Saved, UI states; journeys J1, J5 on dev) — after #232, #233.
6. Promote the tested dev revision to stage (`scripts/promote.sh stage`); report Phase 2; **ask the owner before Phase 3**.

## Active agents (Sonnet 5.5; each in its own SSD worktree)

| Work | Branch / worktree | State |
|---|---|---|
| #230 part 1 finish (PR #254) | `codex/230-scroll-model` · `v2-230-scroll-model` | running: drop temporary commit, rebase, M1 ruling, fix-list check, CI |
| #231 S2.2 harness | `codex/231-harness` · `v2-231-harness` | running: commit WIP, rebase (migration → `0009`), finish brief, PR. 5 of 6 real MiniMax calls used |

Briefs: `knowscroll-dev/v2/agents/coordinator/prompt-*.md`.

## Coordinator rulings this session

- #254 M1: the full-grid simulation proof runs only on the admission path (server); the client parse path is structural and cheap (Hermes has no JIT). CI budgets: admission block < 10 ms, document < 200 ms; client block < 1 ms, document < 20 ms. No engine-specific numeric approximations (`**`/`Math.*` stay).

## Owner decisions

In force: D-018 Cutroom $2 (Phase 4), D-019 Android in Actions, D-020 `checks` required on `dev`, D-021 MiniMax for personal roles. Open before live: identity N2 (sign-in budget saturation; options in the identity README).

## Known gaps / cautions

- This session was started from `~/Desktop`, so the main-update hook is not loaded: discipline only.
- Mailed sign-in through AgentMail is not proved end to end on dev (operator links only); native sign-in binding is off on every world.
- `ks`: if killed between switching `current` and the health check, the old release is unreferenced and a later cleanup could delete it (accepted edge case).
- Playwright MCP screenshots land in `~/Desktop/.playwright-mcp`; move only your own files to the SSD.

## Next action

Review and merge #254 (Sonnet re-review first); then start #229 and #230 part 2; review #231 when its PR is green.
