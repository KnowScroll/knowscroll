# Checkpoint

Coordinator-owned. Keep near120lines; verify Git, CI and actual services before acting.

**Updated:** 2026-10-20 20:02 UTC · **Phase:** 2 actual dev journeys /3 source /4 contracts · **Tracker:** [#222](https://github.com/KnowScroll/knowscroll/issues/222)

## Authority

- Owner authorised all remaining phases; continue after milestones/compactions, no routine phase pause (D023).
- Blueprint governs behaviour, committed v2.1 governs visuals. No PIO or Software Factory.
- Never update main or deploy production. Stage only verified scripts/promote.sh stage; D002 dev PR/mergeback remains separate.
- All automated suites/release checks run in GitHub Actions only. Local build/lint/typecheck/fresh own SSD schema codegen/manual app inspection allowed.
- No provider/network wait inside DB transaction or HTTP navigation. Personal root/epoch/receipt+required pg-boss work atomic; no second outbox.
- Preserve owner checkout/DB, legacy databases/pool/media, dirty/rebase recovery and all old attempts. No reset/clean/force/rebase-abort.
- All worktrees/cache/temp/media/evidence on mounted `/Volumes/Mrigesh SSD`. Original knowscroll-product checkout remains older main with unrelated edits.

## Current identities

| State | Exact identity / evidence limit |
|---|---|
| Integration source | Application tip `06c9bccab14b527fa1b79dbbdc3b89b4fe208a4d`, tree36c96ff0, source22, includes Planner286/carrier287/Contentcoverage288/clientcap289. Checkpoint-only tip can advance. Exact integrated06c checks39487731451 still pending at this checkpoint |
| Actual dev | `6bff5a649b228ed8e9583f5b6307d3c5ef123e6b`, archive `96f0faaa5c3f02599ed21e3e289db67ce56f53b4f4c5f0635e22c1d4f4cb3e30`, latest0020/relay listening. Trusteddeploy39477456334 healthy18:45:39UTC, exactsourcechecks39475624009 all6; backend350/API32/PG313/boot56/release20 inspected |
| Fresh dev audit | 19:57:44UTC pre22-actual20-readonly-audit.jsonl: actual20 checksums exact, API88473/worker88474, normal productionoff, original scopefalse/gen1, all4operator unitsPID0/empty, no producer,7settledattempts/29093reportedtokens/brakes0 |
| Actual stage | Legacy `8982391fe6a0dae385fc6e3013bf46b093d2d9d9`, generationPID1063, source/startup DB classification unchanged; no v2 stage promotion |
| Limits | Health/greenCI/source/gallery are distinct from generated content, actual browser/DB/provider/emulator/physical-device acceptance |
| Working area | `/Volumes/Mrigesh SSD/knowscroll-dev/v2/agents/`; coordinator evidence below is relative to coordinator/ unless stated |
| Integration WT | `/Volumes/Mrigesh SSD/knowscroll-worktrees/v2-release` |

## Completed and retained foundations

- #223–228/#231 closed. Existing recovery codex-recovery-20261020T132246Z preserves initial refs/index/dirty files/rebase metadata. Historical Claude work not resumed; unrelated processes untouched.
- #254 DSL/model, #267 timing, #260/#263 renderers, #262 thin journey, #258 native lane, #266 production scope, #269 production, #268/#275 real Cutroom reuse all merged after independent review/exact checks. Do not restart them; earlier checkpoint history/details recoverable in Git and tracker.
- #270/#271 contracts, #272 Scroll position, #276 retained recorder, #277 Reel position, #274 Composer metadata, #280 full-video gesture surface, #278 navigation/activity and #279 connected client merged. #279 actual APK/emulator39470431994 passed4flows/22screens; source76859e77 accepted. Gallery fixture, not signed-in native acceptance.
- #281 PC2b83a0bd and #283 Composer-PC adaptera4d999dd accepted/all6: required PC capability/noEvidencefallback, available0 remains0, provisional routing_only, no newmath. Historical evidence completeness remains not_asserted; oldglobalcoveredFacets empty/unavailable.
- #282 static-feedback privacy54421c1b and #284 policyv5/writerv4 feedbackfcb5729a accepted/all6; safe allowlisted issue codes only, arbitrary messages/rawfailed drafts remain unstored. Existing min4/copy9/DSL/provenance/one-repair kept.
- #285 tooling merged6b: onlyplan2d0ce7a2/systemb147a3bc installed18:42:22UTC, root644. Other4tool bytes/inodes unchanged, original backup `/srv/knowscroll/backups/ks-tools/pre-250-20261020T184222Z-3da148f2d437` verified. STOP+DISABLEv2 before dump/DDL, exact-schema guard on activation/rollback; old code cannot restart against unknown/ahead SQL. No automatic DBrestore.
- #286 Planner mergeda469c3ca after accepted779/ordinary291/all6push39479500110+PR39479508088; root37paths exact779/outside3d/treeb306 proof. Integrateda469push39484088687 all6/PG329/Planner13/role3/backend356/API32/boot56/release29. Source21 only; KS_PLANNER_ENABLED default0/no paidallowance. Retry-liveness P1 and repeatedunknown edge fixed; delayed claim-fenced wake uses samepg-boss/ledger.
- #287 carrier merged7bd2fc9a after ca55/cc618 independentreview/exactboth39484896233+39484902353 all6; actualPG343/format14/carrier34/prompt6/Planner13/boot56/release29. Root10featureblobs exactca55/outside3632, tree9b8f1196 proof. Optional M3 native single-output-data-object, auto ONLY/no executor/forceddecoderguarantee. Legacy hp2 bytes unchanged; no role consumer in this foundation.
- #288 Contentcoverage mergedbcb042a5 after correctedc77/528d independentreview/exactboth39484828189+39485081984 all6. Root13paths exactc77/outside7bd/treec8415bd1; integratedbcb39486145558 all6/PG348/backend397/API32/boot56/release29 inspected. Exact22SQL. Empty shipped semantic approval list/defaultdeny; static factual top-level ALL-OF leaves only, canonical concepts and current head SHARE fencing. No actual map/PCcoveredfacet/planet.
- #289 capability bug merged06c9bcca after acceptedf422/ordinary2beedf/exactpush39486510472+PR39486518333 all6; actualclient93/UI367/boot56/schema22/release29. Root4paths exactf422/outsidebcb/tree36c96ff0 proof. Encounter declares Reel+Scroll while original Scroll-only route/registry remains unchanged. Actual dev still old6b; playback repair not yet deployed.

## Actual content and browser evidence

- All3 owner-approved real Cutroom imports: greenhouse2074e431, seasons62d6e4d5, tidese41b2917. Full bytes/SHA/duration/probe/import receipts in dev-media evidence. All3 actual older-dev web videos reached end and qualified (q.9856/.9971/.9808). Seasons aged seek15.75s→Retry→pausedready→explicitPlay→end SAMEexposure verified; earliergreenhouseRetry cause ambiguous. No new commission.
- 6b controller actual starter Scroll asset267de10e/rev1/exposure01a15aad-f0a9/session01a15aad-f029 qualifiedq.8963/coverage.7926 and PCcontribution stored. Authored/no admitted topics: no topic adaptation or structural formation inferred.
- Controlled Keep→Explore retained EXACTscrollTop1380.9090576171875/sameexposure/session/recorder lineage; navigation_revision0/returnedfalse/Rfalse. Later Composer decision used advanced PCwatermark59:163:163 rather than initial0:42:0, completenessnot_asserted.
- Savedfilters worked; savedgreenhouseOpen exhausted withzero candidates because actual stored session declared Scroll only. This real defect motivated289. Real Reel→PCtopic→Composer acceptance waits next deploy/newsession.
- Controlled Likeoff/on changed actionrevision5→6, activity2.3963→2.8963 withsameq/noR/no navigation; no accumulated bonus. SavedScrollremove→emptyScrollfilter→ExploreSavefalse→Save→restoredlist persistedSaved2→1→2, sameall6exposures. Earlier18:58 actions actor unknown; no automatic-action bug inferred. Reader parked in Keep.
- Report dev20-controller-pc-journey.md; snapshots dev20-{park-before,park-after,navigation-capabilities,controlled-unlike,controlled-relike,controlled-remove-saved,controlled-save-restored}.json. CurrentSaved2 supersedes dated predeploySaved1 preservation evidence.
- No generated Scrolls yet; no physical-device acceptance. #232/#234/#235/#237/#249 remain open.

## Provider/spend authority — persistent across turns

- Historical harness6/6 exhausted separately. D024 authorises additional24 for #232 split12development+12dev. Current external provider-allowance-232.json: development11used/0reserved/0unknown (1left); dev7used/0reserved/0unknown (5left). Do not transfer buckets, reset UTC/role/brakes/generation or infer another allowance.
- Four development jobs and two dev jobs rejected;18 dispatched calls total. Devv4 joba6bbf49c used3; devv5 job48193b88 used4, terminal18:54:26/audit18:55:30. V5 claimsprimarytoo_small<4→repairsuccess; writerprimarycopied_passage9words→repairbareJSONunexpected_token8147chars. Exact raw content/token unknown by privacy design. All usages/receipts/old jobs retained; no asset published/no active attempt.
- V5 actualrunning Node89108 UID991/GID976/groups[]/EffPrmInhAmb0/NNP1 and rootguardian89089E0 both inheritedFD4/deploy.lockinode5073 captured. Both exited; no liability. Original4/5 configs/intents NEVER rerun/relabelled.
- Newv6 operator SOURCE ONLY independently accepted guardianf64eb3d4d75dffca46eb3259fb6e73791c0f15bc038a62dc816c4b5dbfd48bdf, launcher unchanged74e1cb13. Rootreverse/AST proof review-operator-profile-v6.{md,json}; exact22/policyv6/writerv5 onlydelta. No config/intent/allocation. Claimsv3 checked in future frozen source. Source23 requires separatelyreviewed profile.
- Current5devleft cannot fund3fresh claims+writer jobs minimum6calls. No Planner/Cartographer/Quartermaster paid grant. Budget decision only when concrete missing requirement; continue independent work.
- D018 newv2 Cutroom ≤$2 total + per-script owner approval + actual sharedpool preflight. Existingpool700c/617settled/83remaining/no openorders; D018 cap migration not applied. No new script/commission/capchange authorised by source work.

## Active source/review ownership

| Agent / issue | Worktree, branch, frozen state |
|---|---|
| structured_output_232 / #232 author finished | `232-output-consumer`, codex/232-output-consumer, draftPR290 head0bcd001c5bff19f4961696d8fc69422cad4b8b94 (ordinary06c). Policyv6/claimsv3/writerv5 opt-in, original-prose instructions, six owned files; validators/min4/copy9/max4/one-repair/roles/gen exactunchanged. Initial7f CI caught transientdiagnostic replay-test mismatch; test-only6f9fix keeps exact persistedsummary/noextracalls +quota/rows assertions. Newpush39487911994/PR39487919946 pending; actualbothPG354/production55/backend397/API32/format14/Planner13 +pushboot56/schema22 passed |
| review_context_235 / #232 independentreview ACTIVE | Accepted allsource/testfix/ordinaryunion0bcd,6blobs exact6f9/outside06c/all22immutable/client4exactf422, tree5585d91e. Waiting finalactualall6/backend/build/release logs; report agents/review-232-output-consumer/report.md |
| review_coverage_237 / #237 consumer author ACTIVE | `237-personal-coverage`, codex/237-personal-coverage, exclusive0023. Evidence certificate + PC indexed topic/facet/unit witnesses/refcounts, live current Evidence/Contenthead revalidation, old globalcoveredFacetsEMPTY/Composer unchanged. Frozen3230b5985772e6954f4284307d13462058dcaaf9/25ownedblobs exactb322/outside06c/all22priorSQL preserved; draftPRpending. Staticchecks passed/codegen56738 STOPPED, sevenPGfixtures await Actions. No live maps/geography/provider |
| supply_contracts_239 / #239 author ACTIVE | `239-supply-contracts`, codex/239-supply-contracts, draftPR291 head7b91e8e706466c032906fc26e9ae821051a44d80/fourblobs exact572f/outside06c. Schemas/index/README/tests ONLYtopic+variant/createimmutable receipt/currentstatus/cancel; no routes/stubs. Series/relatedneed futureContentauthority, E07list/retry explicitly deferred. Push39488314287 pending; independentreview stillneeded |

Native289 frozenclient featuref422 run39486002904: APK118846473035SUCCESS, emulator118853246563RUNNING. No emulator acceptance until logs/artifacts/4flows/screens inspected; optional PRnative skips were absence run-native label, not draft status. Root owns final candidate/actualUI/deploy/reviews; workers never edit checkpoint.

## Operational next steps and recovery

1. Finish290 focusedreview/newexactall6. Preserve all six accepted production blobs/strictvalidators; merge with separate verify→mutate calls, prove rootactualtree and run integratedexactCI. Elect an immutable source22candidate before any23merge; checkpointtips are not deployment identity.
2. New22 rollout plan dev-22-rollout-plan.md NOTEXECUTED. Freshbackup/approvedcandidate/archive/actualmetadata/unit/PID/legacy/ledger/config gates required. Tool250 alreadyinstalled; do not reinstall or broaden permissions. Stopv2 before dump/allDDL. Existing18:45dump377905B/root600/SHA98470f40... retained; a NEW pre-DDLdump required.
3. Known21recovery a469 archive01b494c15f9e774095d23998746a1bc5969e67640879c76732d6db1728b08f6d/68,997,120B/all21SQL independently exactGit, recovery-21-a469c3ca/verification.json. Known22recovery528d archive276f4c6f00d82f1413386b8f6b94e3847ef5b118ceecefd587b953b9c3bdd6d9/69,160,960B/rootall22SQL proof recovery-22-528d0f50-verification.json; independent reviewer checked all18,420file/link hashes. CI-only/localverified, neitherhostactivated/provenrecovery.
4. Old20 code cannot be activated after21/22 (missing Planner erasers); old20 recovery archives incompatible. Partial21/22DDL requires exact-schema compatible recovery or reviewed forward completion; unknownschema staysstopped. No automaticrestore/discarded postdump spend/privacy liability.
5. Deploy elected source22 via trusted manualdevworkflow exactref/artifact only afterreview. Recheck all22 actualchecksums/health/newPIDs/productionoff/all7oldreceipts/media/Saved2/legacy; then actualReloadnewsession→Reel+Scroll→qualifiedPCtopic→Composer/Saved/Back/actions. New paidnamedallocation ONLY after concreteconfigreview/remainingallowance.
6. Review23 + contracts291 independently; continue237Cartographer/238scenes,239–240supply/Cutroom,241–245social,246–249privacy/platform and250actualstage. New sharedcontracts precede consumers. No broad social/provider activity fabricated; no routinephasepause.

## Protected local processes

Root c229 PG55982/PID45986, API55991/PID73089, worker73165, edge55993/PID73260. Production disposablePG56632/PID38312 ks232_real has0001..13+15 (NEVER add14outoforder), oldAPI55994/PID46697/edge55996PID46699, worker84821providerNONE. MediaPG56433/PID82068 retained, its bootstrap/worker/API stopped. Bridge55997/PID35967 stopped/no sign-inURLpersisted. Ownschema56678/56679/56727/56683/56736/56737/56738 stopped; no owner55432 or unrelatedprocess touched. Lateragentmustverify actualownershipbeforecleanup, never patternkill.
