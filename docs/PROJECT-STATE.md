# Project state

Updated: 2026-09-16 (Asia/Kolkata). **Reliability, privacy and bounded MiniMax certification verified; reasoning primitives and J004 synthetic fault proof verified; durable SQL fairness and frozen context authority verified; next milestone: Owner Alpha.** This file describes durable status; it does not guarantee a process is running now. Run `pnpm state` for a timestamped observation.

## What exists

- Private monorepo: [KnowScroll/knowscroll](https://github.com/KnowScroll/knowscroll).
- Private [Project](https://github.com/orgs/KnowScroll/projects/1), 12 initial issues and four delivery milestones.
- Kotlin/Compose Android skeleton; build, lint, real emulator keep/return and Activity recreation verified.
- Real Fastify API, PostgreSQL Ledger, SQL jobs and separate deterministic worker.
- Three sourced editorial Scrolls. Exposure and idempotent keep admission; Accounts/Trace projection; next feed excludes kept assets.
- First migration: `0001_bootstrap.sql`; checksummed execution, pinned legacy adoption and ordered-migration drift rejection. No additional domain migration in wave one.
- Android restores the current Scroll, reading position and retry identities after process death; returning to Universe starts a fresh transient browsing history.
- J001 checks persisted decision/exposure/event/job/Accounts/Trace/source lineage. A repeatable isolated runner launches API and worker separately and rejects a deliberately mismatched verifier database.
- Migration `0002_identity_epochs.sql`: operator-provisioned device sessions with hashed tokens, expiry/revocation, private universe ownership and composite lineage constraints. The existing development token enrolls once without restart reactivation.
- Decision/Ledger/job privacy epochs and universe-first locking. Stale queued work is discarded without projection; a busy universe does not block another ready universe. J002 proves two-session isolation over real HTTP and separate worker processes.

- Migration `0003_history_clear.sql` and retryable Clear Scroll history: one locked transaction removes scoped bootstrap encounters and saved Traces, advances the privacy epoch, preserves the caller session and shared library, and invalidates other sessions. Android confirms the effects, persists uncertain requests and binds cached state to its universe.

- Pinned AI SDK/MiniMax certification adapter, fsynced attempt journal and explicit quota-gated CLI. Three live synthetic cases passed on September 16: exact JSON, native thinking/tool call and native continuation. This separate tool does not dispatch ordinary product jobs.

- [ADR-0012](decisions/0012-reasoning-admission-and-reconciliation.md) and strict shared reasoning metadata schemas define durable admission/dispatch uncertainty and late usage after privacy clear. Migration `0004_reasoning_storage.sql` and [storage/privacy helpers](operations/reasoning-storage.md) implement a separate private graph, retained accounting, history-clear erasure, strict receipt append and bounded cleanup. Migration `0005_reasoning_runtime.sql` and [atomic execution primitives](operations/reasoning-runtime.md) add fenced admission, single-use dispatch authorization, unknown-outcome recovery, cumulative settlement and an unwired worker invocation boundary. [J004](journeys/J004.md) verifies separate-process faults, late accounting and interruption cleanup with local fixtures. [ADR-0013](decisions/0013-bounded-reasoning-fairness.md) and the [deterministic fairness model](operations/reasoning-fairness.md) now validate bounded class/universe service and replay/accounting counterexamples. Migration `0006_reasoning_fairness.sql` and [durable SQL fairness](operations/reasoning-sql-fairness.md) now persist bounded class/universe turns and atomically claim/reserve work; cumulative corrections and debt survive clear/restart. Product dispatch remains disabled.

- Migration `0007_sealed_reasoning_context.sql` and [authorized frozen Scroll context](operations/reasoning-context.md) compile literal selected Keep evidence with complete displayed Scroll bytes, immutable Job/session binding and exact typed dependencies. Concrete local SQL authority now checks this context during internal fair admission and dispatch authorization. No product provider call or proposal application is enabled.

## What is not built

The complete Composer, semantic bridge/hypothesis layer, meaningful world evolution, generated Reels, production reasoning admission/dispatch, long-horizon runtime, Cutroom adapter, rooms, social Blend, offline sync and production identity. They remain explicit target scope in [architecture/target](architecture/target/README.md) and issues #2–#12. The MiniMax adapter is certified only for the bounded development cases below. The ordinary ReasoningProvider remains unready, and Cutroom remains a port declaration.

## Current decisions

Native Android, TS API/worker, PostgreSQL, one product monorepo, external Cutroom. [ADRs](decisions/README.md) own these choices. [Product definition](product/definition.md) owns product laws. [Design direction](product/design-direction.md) resolves the two prototypes. [Component map](architecture/component-map.json) owns responsibility boundaries.

## Evidence and limits

See [J001](journeys/J001.md). Backend implementation and HTTP journey passed. Three real Android instrumentation checks passed: sourced Scroll keep/return with Activity recreation; unavailable API; compact-screen recovery. Screenshots and source hashes are in the linked evidence. [GitHub CI](https://github.com/KnowScroll/knowscroll/actions/runs/35007382446) passed backend and Android checks for `b95b2de`. No user usefulness, load capacity, production deployment or model compatibility claim follows from those checks.

Wave-one review and combined runtime proof: [J001 evidence](journeys/evidence/wave1-integration/README.md). Twelve backend tests and two verifier rejection tests passed; all five Android instrumentation phases passed, including force-stop/cold relaunch with the same reading position and retry identities. These checks do not prove a lost response after admission, physical-device eviction timing, frame performance or user usefulness.

Wave-two review and runtime proof: [session integration evidence](journeys/evidence/wave2-integration/README.md). Thirty backend tests, two verifier rejection tests, J001, J002 and all five Android phases passed. Interrupted J002 left no new databases or API/worker processes. Migration preserved hashes and counts for every original domain table; existing history was not reset.

Wave-three review and runtime proof: [clear-history evidence](journeys/evidence/wave3-integration/README.md). Thirty-eight backend tests, two verifier rejection cases, isolated J001/J002/J003 and six Android privacy phases passed. Exact retries survive a dropped committed response and process death; foreign local universe bindings cannot dispatch a clear. Existing reading/keep/restore regression results and dated development observations are recorded alongside those receipts.

Wave-four proof: [certification evidence](journeys/evidence/wave4-certification/README.md). Sixty-six backend tests, two verifier rejection cases, J001/J002/J003 and all three live MiniMax cases passed. The run made three requests with 6,360 reserved units; usage and capability limits are recorded separately. No migration, owner history mutation or Android source change occurred.

Protocol-design checks for #42: typecheck and 75 total backend tests passed, including nine new contract tests. Sol and Terra reviews accepted the corrected state/receipt/privacy design. These checks do not prove SQL admission, J004 or a new product journey.

Storage/privacy #44: [database and regression evidence](journeys/evidence/reasoning-storage/README.md). Typecheck, 91 total backend tests (12 baseline + 79 additional), two verifier rejection cases and isolated J001/J002/J003 passed. Sol storage tests and an independent Terra review caught and verified a full-retention-cascade fix; privacy tests cover rollback, retained-only accounting, old-epoch usage and older-clear replay after later work. These results do not establish atomic admission or J004.

Atomic primitives #45: [SQL/HTTP and regression evidence](journeys/evidence/reasoning-runtime/README.md). Typecheck, 130 total backend tests (12 baseline + 118 additional), two verifier rejection cases and isolated J001/J002/J003 passed. Admission/reconciliation tests cover lock waits, stale fences, all-or-nothing reservations, unknown outcomes, cumulative nullable usage and overages. The integrated HTTP fixture verifies committed intent before dispatch, clear during a pending response and late settlement without private resurrection. This is one-process fixture proof, not J004 or product provider execution.

J004 #46: [separate-process fault evidence](journeys/evidence/reasoning-faults/README.md). Thirteen scenarios passed with four local fixture HTTP requests; independent SIGTERM/SIGINT checks observed no remaining child process groups or disposable database. Typecheck, 149 backend tests (including 19 receipt-verifier checks), two existing verifier rejection cases and J001–J003 passed. Actual worker kills, recovery fences, no replay, API clear/late usage, cumulative accounting, cap rollback and blocked-universe progress are covered. Lost acknowledgement is injected after a real commit. Automatic requeue, provider execution and production fairness remain unproved.

Fairness policy/model #54: [deterministic evidence](journeys/evidence/reasoning-fairness/README.md). Twelve dynamic traces and 23 focused tests passed after independent Terra review, alongside 172 total backend tests, J001–J004 and interruption cleanup. The traces cover unequal work, idle borrowing and returning demand, bounded scans, unknown holds, rate rollover, corrections/debt and snapshot replay. They do not prove concurrent SQL fairness, provider window timing, production capacity or useful reasoning. The SQL implementation is [#55](https://github.com/KnowScroll/knowscroll/issues/55).

Durable fairness #55: [SQL evidence](journeys/evidence/reasoning-sql-fairness/README.md). Real PostgreSQL tests cover atomic rollback, competing clients, blocked heads, maximum requests, weighted unequal-cost service, equal universe service, saved inner turns, bounded return and concurrent clear/CAS fencing. Original-window late accounting and a real disposable PostgreSQL process restart are verified. J001–J004 and the interruption checker pass. These are synthetic authority/receipt fixtures; no provider execution, automatic provider window clock, production capacity or usefulness follows.

Cleanup reliability #57: [interruption evidence](journeys/evidence/reasoning-cleanup/README.md). PR #58 repaired a reproduced repeated-signal window and added safe diagnostics plus single, repeated, mixed-signal and child-failure checks. Reviewed-head Linux backend and Android CI passed. A later reproduced idle PostgreSQL pool error is also handled, with a sixth disposable-backend interruption case and safe CI artifacts. Both reviewed-head Linux suites passed for PR #59. The historical Linux failure did not retain enough information to establish its exact cause; #57 remains open.

Frozen context #60: [SQL/authentication evidence](journeys/evidence/reasoning-context/README.md). Typecheck and 230 backend tests passed, including independent Sol privacy and Terra SQL adversarial cases. J001–J004, six cleanup cases, twelve fairness traces and a disposable PostgreSQL restart regression passed. Original-session binding rejects session substitution; exact typed reads reject relevant drift while unrelated Keep remains valid. No provider call, proposal application or semantic usefulness is claimed.

Last development observation: `2026-09-16T13:10:36Z`. API healthy, worker heartbeat fresh, six released migration checksums present; three completed jobs remain present. Migration 0006 preserved all existing rows across 22 tables and the five previous checksums. This observation predates migration 0007. The earlier wave-three emulator observation showed both existing Traces and the privacy control at epoch zero; it was not rerun in this backend-only wave. Run `pnpm state` for current status.

## Next work after durable SQL fairness

[Coordination #29](https://github.com/KnowScroll/knowscroll/issues/29) records the clear-history wave; [#21](https://github.com/KnowScroll/knowscroll/issues/21) and [#13](https://github.com/KnowScroll/knowscroll/issues/13) retain earlier delivery evidence. Parent epics remain open. ADR-0010 defines implemented bootstrap clear and separates future pause, semantic reset, account deletion, backup retention and typed semantic proposal read sets.

Wave-four [coordination #37](https://github.com/KnowScroll/knowscroll/issues/37) records completed provider certification. [#42](https://github.com/KnowScroll/knowscroll/issues/42) accepts the production reasoning admission and unknown-outcome protocol under #7. [#44 storage/privacy](https://github.com/KnowScroll/knowscroll/issues/44) implements the first database slice. [#45 atomic admission/reconciliation](https://github.com/KnowScroll/knowscroll/issues/45) implements the development primitives. [#46 J004 fault proof](https://github.com/KnowScroll/knowscroll/issues/46) verifies the synthetic protocol harness. [#54 bounded fairness policy/model](https://github.com/KnowScroll/knowscroll/issues/54) accepts the scheduling contract with deterministic counterexamples. [#55 durable SQL fairness](https://github.com/KnowScroll/knowscroll/issues/55) implements the accepted policy. [#60](https://github.com/KnowScroll/knowscroll/issues/60) implements frozen direct context and typed read validation. [#62](https://github.com/KnowScroll/knowscroll/issues/62) is the next bounded retirement slice, pending the owner’s cancelled/expired-context retention choice. Proposal operations and lifecycle gates remain in the [implementation plan](operations/reasoning-implementation-plan.md); ordinary product provider jobs remain disabled. Keep #2 public identity/recovery and #4 full privacy lifecycle explicit; clear history does not complete either. The semantic, recommendation and cosmic/social target remains unchanged.

## Component lanes

| Lane | Start | Ownership |
|---|---|---|
| Mobile | [#3](https://github.com/KnowScroll/knowscroll/issues/3) | apps/mobile; renderer/navigation contracts coordinated first |
| Core | [#4](https://github.com/KnowScroll/knowscroll/issues/4), then #5/#6 | events, privacy lifecycle, full Composer and semantic substrate |
| Reasoning | [#7](https://github.com/KnowScroll/knowscroll/issues/7) | worker runtime; atomic primitives and J004 synthetic proof complete; durable fairness and frozen context verified; proposal/lifecycle gates remain |
| Coordinator | [#2](https://github.com/KnowScroll/knowscroll/issues/2), [#12](https://github.com/KnowScroll/knowscroll/issues/12) | identity boundary, shared contracts, integration and journey evidence |

The owner reports a token plan of 300 million tokens per five hours. ADR-0011 verifies the subscription route and enforces a much smaller cap plus a quota preflight before every certification request. Three live calls ran in wave four; post-run quota was 99% interval / 95% weekly. This is a dated shared-plan observation, not a current balance or cash-spend authorization. Cutroom needs a reachable configured host and file-import transport. No provider key is needed for the sourced-Scroll journey. Do not paste credentials into issues or commits.

Prepared checkout paths, branch names, ports and databases: [parallel worktrees](operations/worktrees.md).

## Operational limitation

Private-repository branch protection is unavailable on the current GitHub plan (HTTP403). CI and PR workflow are configured; required checks/reviews are not server-enforced. The repository remains private.
