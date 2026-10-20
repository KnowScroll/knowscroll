# Checkpoint

Coordinator-owned. Hard cap ~120 lines. Verify Git, CI and deployed revisions before acting.

**Updated:** 2026-10-20 16:45 UTC · **Phase:** 2 implementation / real dev journeys · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222)

## Authority

- Owner authorised continuation through all remaining implementation phases on 2026-10-20; no routine pause before Phase 3 (D-023).
- Blueprint governs architecture and behaviour; committed v2.1 governs visuals. No PIO or Software Factory gates.
- Never update `main` or deploy production. Preserve total budgets, per-Reel-script approval and protected owner/legacy data.
- Automated suites run in GitHub Actions only; local hands-on app use, build, lint and typecheck are allowed.

## Verified state

| Item | Value / evidence limit |
|---|---|
| Integration | Through `880cc988` including #268/#273/#275/#272/#274/#276; takeover was clean `d852d440`. Source has0016/17 but0015 is still unmerged: do not deploy this gap to dev before combining ordered0015 |
| Worktree | `/Volumes/Mrigesh SSD/knowscroll-worktrees/v2-release` |
| dev health, 2026-10-20 16:01 UTC | Tested v2 `01b6ec0873cae89f43af6ee4a50dac0cd641b491`, artifact `1cc4b0ce5488b67b90b131d3fb08300ea73ded664224006b10c40121ee6c79df`, migration `0014_media_reels`, relay listening; deploy [39453618122](https://github.com/KnowScroll/knowscroll/actions/runs/39453618122) |
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
| `thin_journey_229` | #262 · `v2-229-thin-journey` | Merged7f639fc8 after accepted4285f599 + exact push/PR all six green/log inspection. Mail-race/anchor/scope/probe fixes retained; root browser5b0f0330 authored-fixture qualified evidence/block return; dev acceptance pending |
| `production_scope_232` | #232 foundation · `v2-232-production-scope` | Merged #266 as94d367cc after independent review and exact1a650 all six push+PR checks green (183integration); no provider calls |
| `scroll_production_232` | #232 · `v2-232-scroll-production` | #269 writerv4/writerpromptv3 source accepted at e4e88145 after fresh independent review; exact freshCI39459440436/PR39459448949 pending. Two CI fixture defects corrected without admission/harness changes. New private publication topic hook, ordered1..17 actual types/hash proof. Four terminal rejected jobs/11developmentcalls; no asset, no automatic resend |
| `media_reels_233` | #233 · `v2-233-media-reels` | #268 merged7b998766; record fix #275 mergedd3109e6f after independent review+all six01b6ec08. All3 real approved Cutroom imports created/exacthash, greenhouse replay unchanged. All3 actual dev web videos reached end and qualified: greenhouseq.9856/4obs,seasonsq.9971/4obs,tidesq.9808/3obs. Seasons agedseek15.75s→Retry→pausedready→explicitPlay→end SAMEexposure, real grant recovery verified |
| coordinator | #258 · `v2-249-android-lane` | Merged #258 as `957b7655` after independent source/log/artifact review; Scroll-block flow explicitly skipped; #249 stays open |

Workers do not edit checkpoint. Reports live in `agents/codex-230-model/`, `codex-230-renderers/`, `codex-229-journey/`, `codex-249-review/` under the SSD evidence area.

## Sequence

1. #254 fixes → independent targeted re-review → checks on actual head → squash into integration.
2. Deliberately update stacked #260 → #263, preserve fixes, inspect resulting diffs; review/check each actual candidate.
3. #262: preserve recovered history without force-push; fix resume, late writes, reading-fact versioning and interaction vocabulary; integrate ScrollArticle.
4. #258 lane reviewed/merged. B mandatory native fixture journey passed at4fc08e71; broader native journeys still required. Do not close #249 for lane setup alone.
5. Exercise admitted Scroll → reading → observations → persisted qualified evidence on dev.
6. Continue #232 (three real generated Scrolls, two interactive), #233 (real reuse playback), #234. Contracts #270/#271 merged. #273 diagnostics merged3d856ef5 after all six/log review. #272 mergeddf0a6524 after all six+native39450167726 APK/emulator actual4flows/22screenshots/noANR. #274 metadata/Composer merged41b7f43f after0d3349eb review/all six; source only, no API consumers yet. #276 merged880cc988 after57c87373 all6push+PR +native39455429724 APK/all4flows/22screens/noANR, logs/XML/screens reviewed. #277 Reelposition e3d82b9f all6pass/native39458364554 pending. #278 backend18/19 first6588 rejected inreview: receiptoperationgrammar, whole8192Bbufferbound, reversibleattributionhashcollision +invalidfixtureIDs; authorfixing. Clientcontroller/Explore/Saved active in own v2-234-encounter-client basede3d82b9f, apps/client-only. Then remaining phases.
7. Promote tested dev via `scripts/promote.sh stage`, preserve artifact identity; report and continue.

## Cautions

- D-018 total new v2 Cutroom allowance ≤ $2. Read-only audit: pool cap 700¢, settled 617¢, no open orders; D-018 grant/cap migration not applied. Read balance and obtain script approval before new commission.
- Actual harness `calls.json` records6/6 used; its allowance is exhausted. D-024 owner approved additional24 #232 calls (12 development+12 dev). Ledger now development11dispatched/0reserved/0unknown (1remain), dev0/12. Four terminal rejected jobs, no generated asset. Last greenhouse8ac49282: validclaims; writer primary expectedarray, repair json-refusal.v1 syntax/expected_comma_or_separator. Every attempt/usage retained; no call active or automatic resend. Do not transfer buckets or bypass failure brake.
- No model/network wait in DB transaction or HTTP navigation. Preserve atomic receipts, epochs, erasure and AccountScope isolation.
- GitHub-hosted CI only; no secret-bearing PR deployments or weakened/skipped required checks.
- Claude's main-update hook is not a Codex control; enforce the owner boundary explicitly.

## Runtime ownership and evidence

- Coordinator local disposable c229 DB port 55982/PID45986; API55991/PID73089/session53504; workerPID73165/session82748; edge55993/PID73260/session50181. Root owns cleanup; old child API/worker/edge had ended. No owner DB or provider accessed.
- Local reader screenshot `agents/coordinator/local-scroll-return-5b0f0330.jpg`; DB observation/evidence audit `local-current-exposure-262.txt`. Authored editorial fixture only, not generated-content acceptance.
- Root owns disposablePG16 port56632/PID38312, SSDtmp/pg-codex-232-20261020; ks232_real migrated0001..13+15 (isolatedwithout14; never add14outoforder). Enabled production generation1;11settledattempts/fourterminalrejections. API55994/PID46697 and edge55996/PID46699 source84821, worker providerNONE. Exact5b3052ed operator rebuilt/compiled diagnostics verified; provider session54270 endedexit2, no unattended generation. Agent typegen56678 ordered1..15 stopped.
- Root media fixture browser completed/closed; own bootstrap57766, worker58058 and restartedAPI79118 stopped. PG56433/PID82068 retained. Evidence agents/coordinator/media-ec515-browser.md + screenshots; synthetic only. Backend agent owns separate disposablePG56674/typegen; never runtime DBs.
- Dev01b6ec08 deployed16:01 UTC; worker80638 groupks-pool, API80650 no supplementary group; stage v2 inactive. Backup `/srv/knowscroll/backups/knowscroll_v2_dev/pre-deploy-20261020T160106Z-01b6ec0873ca.dump`0600/280052B; previous191d1558. Logs deploy-01b6ec08.log, reviewed rollback plan dev-media-rollout-plan.md. No new unit changes after first rollout.
- GET-only Cutroom audits/imports preserved in coordinator evidence; all3 actual approved media bytes/hashes/probes match, fixturefalse, idempotent greenhouse replay; pool remains700c/617c/83c. No new commission or v2spendgrant.
- Real dev browser report `agents/coordinator/dev-media-browser-01b6ec08.md`, final persisted audit `dev-media-evidence-01b6ec08-all-three.jsonl`, three `dev-reel-01b6ec08-*-qualified.png` screenshots. Qualified actual Scroll starterq.8732/43obs separately; authored, not generated. Later direct reopen created new exposure; not parkedBack semantics. Saved greenhouse persisted1item/1action. Seasons Retry/renewal progressed same exposure; ambiguous earlier greenhouse Retry progress remains unproved.
- Browser tab3 returnedExplore; consumed bridgePID35967 stopped, noactiveplayer/recorder. No bearer/grant persisted. Own schema codegen56679(17files) and56678(18/19source) stopped. Backendfixauthor maycreateNEW own disposable typegen only. RootruntimePG56632/55982/56433 protected.
- Source-only metadata/Composer274 exact0d3349eb all6 actualbackend/release logs inspected; archive76de74f9d5ef2aac8a905b6dcef1c597a72a12a543b8521305463517e25863c8,16migrations/latest17 (15gap), never deployed. Real Explore currently remains old empty screen.
- Devproduction plan `agents/coordinator/dev-scroll-production-plan.md` +independent `agents/codex-review-266/review-dev-scroll-production-plan.md` are prepared drafts, not execution approval. Need acceptedv4artifact/all6, actualDB/UTCusage/brake/generation, named allocation, concrete remote guardian/lock survivingSSHloss, noRestart, minimalinnerenv, exactscopeenable/disable and post-call DBrestore-liability preservation. Dev12 untouched.

## Next action

Complete #269 exactCI and ordered0015 integration before next deployment; root reserves dev-only model attempts only after concrete operator review. Leave remaining1development unused. Finish #277 native evidence, #278 Major fixes/re-review/CI and actual client Explore/Saved/retained Back; exercise realdev connectedjourneys then continue remainingphases. Tracker comment6295778237 links current3Reelproof. Fixtures, green CI and health alone do not prove complete journeys.
