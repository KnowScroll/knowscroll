# Reasoning storage and privacy proof — issue #44

Date: September 16, 2026. Parent [#7](https://github.com/KnowScroll/knowscroll/issues/7); design [#42](https://github.com/KnowScroll/knowscroll/issues/42); implementation [#44](https://github.com/KnowScroll/knowscroll/issues/44).

## Scope and review

Migration 0004 adds private reasoning execution records and separate retained accounting. The history-clear transaction erases private records while preserving unresolved usage duties. Internal helpers append strictly bound receipts and purge eligible accounting after all duties close and the retention horizon passes.

The coordinator owned the schema, integration and documentation. Sol implemented the storage tests and began the privacy helper; Terra completed the helper after a Sol capacity failure. A separate Terra reviewer inspected the actual migration, tests and privacy implementation. Each implementation lane used its own SSD worktree and disposable PostgreSQL test database.

Review and tests corrected a real full-cascade deletion failure: settlement adjustments needed a cascading reservation foreign key. Direct retained-child deletion remains forbidden. Privacy review also removed an early return that could skip retained accounting, covered queued Jobs with no Attempts, rejected unknown receipt origins, and preserved the original closure time across later history clears.

## What this proves

- Fresh installation and populated 0001–0003 upgrade preserve existing rows and migration checksums; repeated migration is a no-op.
- PostgreSQL rejects foreign-scope links, invalid retry lineage, duplicate identities, repeated permit transitions, wrong reservation/adjustment units and mutation of immutable evidence.
- New clear erases the private graph and releases only unconsumed commitments. Possibly sent work retains accounting and cannot regain output authority. Failure rolls back the combined operation.
- Late original usage can bind an old epoch after clear without resurrecting private state. Exact retries are idempotent and conflicting receipt reuse fails.
- Older clear replay returns its original receipt before touching later reasoning activity.
- Cleanup requires erased private Attempts, closed financial/remote/reconciliation/idempotency duties and the 30-day horizon. Full eligible accounting deletion cascades retained evidence; unknown work is not TTL-refunded.

## Limits and next action

All new reasoning records and provider-result metadata in these tests are fixtures in disposable PostgreSQL data. No live provider request, authenticated public receipt endpoint, atomic admission, settlement algorithm, scheduler, private-graph retirement worker or J004 process-crash proof is part of #44. No Android source changed or new emulator claim is made. Product reasoning remains disabled.

[#45](https://github.com/KnowScroll/knowscroll/issues/45) consumes these storage interfaces for atomic admission and reconciliation. [#46](https://github.com/KnowScroll/knowscroll/issues/46) owns J004; parent #7 remains open. See the [storage guide](../../../operations/reasoning-storage.md) and [implementation plan](../../../operations/reasoning-implementation-plan.md).

## Verified results

[Execution metadata](execution.json) pins source commit `01e0667` and the reviewed source/test hashes. Subsequent changes in the delivery commit update documentation and evidence only.

| Check | Result |
|---|---|
| TypeScript | [Typecheck passed](typecheck.txt) |
| Backend tests | [91 passed](backend-tests.txt): 12 baseline + 79 additional, including eight new storage groups and seven privacy tests |
| Verifier rejection cases | [2 passed](verifier-negative.txt) |
| Isolated J001 | [Passed](J001.txt), including wrong-runtime rejection |
| Isolated J002 | [Passed](J002.txt), [receipt](j002-receipt.json) |
| Isolated J003 | [Passed](J003.txt), [receipt](j003-receipt.json) |

The reasoning tests use disposable data; J001–J003 exercise the existing product journeys in separate API/worker processes. J004 remains unimplemented. CI backend and Android results are recorded on the delivery PR and issue handoff.
