# Wave one: reviewed integration evidence

Observed September 15, 2026 UTC (September 16 in India). Coordination [#13](https://github.com/KnowScroll/knowscroll/issues/13); implementation PRs [#17](https://github.com/KnowScroll/knowscroll/pull/17), [#18](https://github.com/KnowScroll/knowscroll/pull/18), [#19](https://github.com/KnowScroll/knowscroll/pull/19).

## Outcome and source binding

The sourced-Scroll journey retains its deterministic API → Ledger/job → worker → Accounts/Trace path. Migration files now have checksums, Android restores the current reading session, and the backend verifier rejects plausible HTTP results without the matching persisted path. No semantic worlds, models or generated assets were fabricated.

The coordinator verified backend changes at integration commit `ec5f84adbb28d6c3ee431549b4040ab8ec7ea37e` (the exact revision is in `http.json`) and the combined Android system at `2a5a51305272e8351da62dee815dd13384fe3471`. Source hashes accompany both receipts. Local documentation/CI changes were uncommitted during the runs; backend `git.dirty` records this, while the Android manifest records file hashes. PR squash commits differ from these preserved integration commits without changing the tested implementation files.

## Receipts

- [HTTP and PostgreSQL lineage](http.json), [separate-process runner result and decoy rejection](backend-runner.json).
- [SIGTERM after service startup](cancellation.json): API port closed, worker exited, no generated databases remained.
- [Android environment and source hashes](android-environment.json), [before process death](android-before.json), [after restoration, keep and return](android-after.json).
- [Before screenshot](android-before.png), [restored screenshot](android-restored.png), [compact screen](android-compact.png). Coordinator visually inspected these; the restored screen is visibly drawn at position 516.
- Five instrumentation results: [prepare](processDeathPrepare.txt), [restore/keep/return/next](processDeathRestoreKeepReturnAndNext.txt), [sourced keep and recreation](sourcedScrollKeepAndReturn.txt), [unavailable](unavailableIsHonest.txt), [compact recovery](compactLayoutAndRecovery.txt).

## Commands and results

`pnpm typecheck` passed. `pnpm test` passed 12 tests, including eight PostgreSQL migration subtests. `pnpm exec tsx --test scripts/journey-verifier.test.ts` passed two rejection cases. `pnpm exec tsx scripts/run-isolated-journey.ts` passed the real path and the deliberate wrong-database check. `python3 scripts/android-journey.py` assembled the app/test APKs and passed all five phases; Gradle build/lint also passed in the mobile lane and CI.

The existing development database adopted the pinned 0001 checksum without changing its two completed jobs. Repeated migration was a no-op. Disposable databases and the journey app were used for repeated interactions; personal history was not reset.

## Limits and next decision

A migration-file checksum does not attest an old database against manual schema changes. Database lineage does not prove exclusive worker execution. SIGKILL/host failure can prevent cleanup. Reading position is persisted after a 200 ms settle or disposal; arbitrary kill during active motion is not proved. No post-admission response-loss injection, physical-device eviction timing, performance benchmark, provider compatibility or product usefulness claim follows from these tests.

Next settle identity ownership and privacy-epoch/read-set contracts (#2/#4), then release dependent work under #7. The full recommendation, semantic bridges, cosmic worlds, rooms and social scope remain in the target architecture.
