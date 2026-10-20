# Checkpoint

Coordinator-owned. Hard cap ~120 lines. Verify Git, CI and deployed revisions before acting.

**Updated:** 2026-10-20 15:07 UTC · **Phase:** 2 recovery / fix-and-review round · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222)

## Authority

- Owner authorised continuation through all remaining implementation phases on 2026-10-20; no routine pause before Phase 3 (D-023).
- Blueprint governs architecture and behaviour; committed v2.1 governs visuals. No PIO or Software Factory gates.
- Never update `main` or deploy production. Preserve total budgets, per-Reel-script approval and protected owner/legacy data.
- Automated suites run in GitHub Actions only; local hands-on app use, build, lint and typecheck are allowed.

## Verified state

| Item | Value / evidence limit |
|---|---|
| Integration | `codex/release-knowscroll-v2` at `dd4412cf` after #258/#254/#260/#267/#266/#263 merges; no new deployment; takeover was clean `d852d440` |
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
| `scroll_model_230` | #254 · `v2-230-scroll-model` | Merged #254 as `a640a57e` after independent review + exact-head green; timing scheduling #267 merged `deb0cb26`; every test/threshold preserved, exact-head push + PR all six checks passed |
| `renderers_230` | #260 + #263 · `v2-230-renderers` / B branch | A merged47f826eb, B mergeddd4412cf after accepted4fc08e71 + exact push/PR all six checks; native39439430873 APK/emulator passed all four flows/22screenshots, actual report/log/screenshots inspected; fixture only |
| `thin_journey_229` | #262 · `v2-229-thin-journey` | `4285f599`: integration/B history merge accepted; c50→head only exact B Maestro flow + checkpoint; fresh push39444052392/PR39444060762 release pending. Prior source/fixture-mail race fixes retained; root browser5b0f0330 authored-fixture qualified evidence/block return |
| `production_scope_232` | #232 foundation · `v2-232-production-scope` | Merged #266 as94d367cc after independent review and exact1a650 all six push+PR checks green (183integration); no provider calls |
| `scroll_production_232` | #232 · `v2-232-scroll-production` | PR #269d6881cc: bounded prompt-v2 independently accepted, all six Actions39443485528 success (238integration/12production). Real v1 writer rejected3calls; v2 claims rejected2calls; no asset. Terminal rows preserved; focused claims diagnosis active |
| `media_reels_233` | #233 · `v2-233-media-reels` | PR #268ec51584a: Retry-after-transport-error fix source accepted; CI39444566278 running. Root found stuck-error UI despite ready video after fresh Retry; rebuilt actual browser recheck pending. Real import/native acceptance pending; no paid calls |
| coordinator | #258 · `v2-249-android-lane` | Merged #258 as `957b7655` after independent source/log/artifact review; Scroll-block flow explicitly skipped; #249 stays open |

Workers do not edit checkpoint. Reports live in `agents/codex-230-model/`, `codex-230-renderers/`, `codex-229-journey/`, `codex-249-review/` under the SSD evidence area.

## Sequence

1. #254 fixes → independent targeted re-review → checks on actual head → squash into integration.
2. Deliberately update stacked #260 → #263, preserve fixes, inspect resulting diffs; review/check each actual candidate.
3. #262: preserve recovered history without force-push; fix resume, late writes, reading-fact versioning and interaction vocabulary; integrate ScrollArticle.
4. #258 lane reviewed/merged. B mandatory native fixture journey passed at4fc08e71; broader native journeys still required. Do not close #249 for lane setup alone.
5. Exercise admitted Scroll → reading → observations → persisted qualified evidence on dev.
6. Continue #232 (three real generated Scrolls, two interactive), #233 (existing real Cutroom import/playback). Prerequisite Reel contracts PR #270 source accepted/f097pushgreen, awaits262/263. #234 contracts97ad all six push/PR green; context/action-lineage/parked-Back follow-up active in v2-234-explore-contracts, consumers await merged contracts; then remaining phases.
7. Promote tested dev via `scripts/promote.sh stage`, preserve artifact identity; report and continue.

## Cautions

- D-018 total new v2 Cutroom allowance ≤ $2. Read-only audit: pool cap 700¢, settled 617¢, no open orders; D-018 grant/cap migration not applied. Read balance and obtain script approval before new commission.
- Actual harness `calls.json` records 6/6 MiniMax calls used (last 2026-10-20 07:04 UTC); its allowance is exhausted. Reconcile all attempts before further calls. Dev attempt/usage tables empty. D-024 owner approved additional 24 #232 calls (12 development + 12 dev); shared ledger records development5dispatched/0reserved/0unknown (7remain), dev0/12. Both real jobs rejected; no admitted asset. Every attempt/usage retained in provider-allowance-232.json; no automatic resend.
- No model/network wait in DB transaction or HTTP navigation. Preserve atomic receipts, epochs, erasure and AccountScope isolation.
- GitHub-hosted CI only; no secret-bearing PR deployments or weakened/skipped required checks.
- Claude's main-update hook is not a Codex control; enforce the owner boundary explicitly.

## Runtime ownership and evidence

- Coordinator local disposable c229 DB port 55982/PID45986; API55991/PID73089/session53504; workerPID73165/session82748; edge55993/PID73260/session50181. Root owns cleanup; old child API/worker/edge had ended. No owner DB or provider accessed.
- Local reader screenshot `agents/coordinator/local-scroll-return-5b0f0330.jpg`; DB observation/evidence audit `local-current-exposure-262.txt`. Authored editorial fixture only, not generated-content acceptance.
- Root owns additional disposablePG16 port56632/PID38312, SSDtmp/pg-codex-232-20261020; freshks232_real migrated0001..13+15 from84821b0 (isolatedlocal schema without media14), production root enabled atgeneration1 for authorized bounded operator jobs;5settledattempts, v1/v2terminalrejections. API55994/PID46697 and edge55996/PID46699 source84821; worker providerNONE. Root rebuilt operator d6881cc for v2; no unattended production jobs.
- Root media fixture runtime: bootstrap/edge56435/PID57766, API56434/PID58057, worker58058, PG56433/PID82068; root session62360 owns cleanup. Labelled synthetic video; root IAB tab2 paused/error awaiting ec515 rebuild.
- VPS read-only preflight evidence `agents/coordinator/vps-preflight-20261020-1423.md`: dev API/worker active, current/stage identities unchanged, existing0600backups, ample disk.
- Read-only real Cutroom audit confirms three approved completed videos/checksums/probes: `agents/coordinator/cutroom-read-audit-20261020.jsonl`. No import/playback or new commission claimed.

## Next action

Finish Scroll fixes and Android review, obtain independent reviews/current CI, then integrate the existing chain. Update tracker/checkpoint after material merges, failures and decisions. Fixtures, green CI and health alone do not prove complete journeys.
