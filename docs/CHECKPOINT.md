# Checkpoint

Coordinator-owned. Hard cap ~120 lines. Verify Git, CI and deployed revisions before acting.

**Updated:** 2026-10-20 13:30 UTC · **Phase:** 2 recovery / fix-and-review round · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222)

## Authority

- Owner authorised continuation through all remaining implementation phases on 2026-10-20; no routine pause before Phase 3 (D-023).
- Blueprint governs architecture and behaviour; committed v2.1 governs visuals. No PIO or Software Factory gates.
- Never update `main` or deploy production. Preserve total budgets, per-Reel-script approval and protected owner/legacy data.
- Automated suites run in GitHub Actions only; local hands-on app use, build, lint and typecheck are allowed.

## Verified state

| Item | Value / evidence limit |
|---|---|
| Integration | `codex/release-knowscroll-v2` at `d852d440325d42d0e691e3116d40cf090f919bbc` before this refresh; clean at takeover |
| Worktree | `/Volumes/Mrigesh SSD/knowscroll-worktrees/v2-release` |
| dev health, 2026-10-20 | v2 `d852d440325d42d0e691e3116d40cf090f919bbc`, artifact `dccc91bdf11113578e783ec6c3ff88880c3b54ee1a99e664308cd77f148c88d0`, migration `0009_reasoning_harness`, relay listening |
| stage health, 2026-10-20 | v1 `8982391fe6a0dae385fc6e3013bf46b093d2d9d9`; no v2 promotion yet |
| Evidence limit | Health establishes deployment identity, not generation or connected journey acceptance |
| SSD evidence | `/Volumes/Mrigesh SSD/knowscroll-dev/v2/` |
| Legacy checkout | `knowscroll-product` stays on older main with unrelated edits; never switch/reset it |

## Completed foundations

- #223–#228 and #231 closed; preserve completed foundations.
- Harness PR #259 merged as `d852d440`; dev deploy [39394534551](https://github.com/KnowScroll/knowscroll/actions/runs/39394534551). Failure-brake follow-up belongs with the first production roles.
- Prior operator identity/dev real-database verification is on #226. Mailed sign-in remains unproved and native binding off.

## Recovery and ownership

Snapshot: `/Volumes/Mrigesh SSD/knowscroll-dev/v2/agents/coordinator/codex-recovery-20261020T132246Z/`.
It preserves Git refs, index, dirty files, patches and rebase metadata. Historical Claude processes had no active child work at takeover; no unrelated process was killed.

| Sol/high agent | Existing PR / worktree | Assignment state |
|---|---|---|
| `scroll_model_230` | #254 · `v2-230-scroll-model` | `782ee0a9`, clean; reconcile review, CSP/jitless, admission/client boundaries |
| `renderers_230` | #260 + #263 · `v2-230-renderers` / B branch | A `a4cce2ea` + 14 dirty/2 untracked files preserved; B `21772cff`; vocabulary, visibility, scope fences and gestures |
| `thin_journey_229` | #262 · `v2-229-thin-journey` | Rebase recovered to `3d5fb268`; original/remote `88279257` preserved; no force-push |
| coordinator | #258 · `v2-249-android-lane` | `b4a19828`; review actual native artifacts; #264/#265 are DO NOT MERGE probes |

Workers do not edit checkpoint. Reports live in `agents/codex-230-model/`, `codex-230-renderers/`, `codex-229-journey/`, `codex-249-review/` under the SSD evidence area.

## Sequence

1. #254 fixes → independent targeted re-review → checks on actual head → squash into integration.
2. Deliberately update stacked #260 → #263, preserve fixes, inspect resulting diffs; review/check each actual candidate.
3. #262: preserve recovered history without force-push; fix resume, late writes, reading-fact versioning and interaction vocabulary; integrate ScrollArticle.
4. Review #258 APK/emulator logs/artifacts. Do not close #249 for lane setup alone.
5. Exercise admitted Scroll → reading → observations → persisted qualified evidence on dev.
6. Continue #232 (three real generated Scrolls, two interactive), #233 (existing real Cutroom import/playback), #234 (Explore/navigation/Saved); then remaining phases.
7. Promote tested dev via `scripts/promote.sh stage`, preserve artifact identity; report and continue.

## Cautions

- D-018 total new v2 Cutroom allowance ≤ $2. Read actual spend/reservations/unknowns and balance before paid calls; each script requires approval.
- Prior harness brief reported 5/6 MiniMax calls used. Reconcile real attempts before treating any allowance as available. No provider call made during recovery.
- No model/network wait in DB transaction or HTTP navigation. Preserve atomic receipts, epochs, erasure and AccountScope isolation.
- GitHub-hosted CI only; no secret-bearing PR deployments or weakened/skipped required checks.
- Claude's main-update hook is not a Codex control; enforce the owner boundary explicitly.

## Next action

Finish Scroll fixes and Android review, obtain independent reviews/current CI, then integrate the existing chain. Update tracker/checkpoint after material merges, failures and decisions. Fixtures, green CI and health alone do not prove complete journeys.
