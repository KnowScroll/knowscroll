# Project state

Updated: 2026-09-16 (Asia/Kolkata). **Reliability, privacy and bounded MiniMax certification verified; reasoning admission protocol accepted; next milestone: Owner Alpha.** This file describes durable status; it does not guarantee a process is running now. Run `pnpm state` for a timestamped observation.

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

- [ADR-0012](decisions/0012-reasoning-admission-and-reconciliation.md) and strict shared reasoning metadata schemas define durable admission/dispatch uncertainty and late usage after privacy clear. This is a reviewed design contract; no SQL reasoning runtime or product dispatch is enabled.

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

Last development observation: `2026-09-16T06:26:19.515Z`. API healthy, worker heartbeat fresh, all three migration checksums present; two completed jobs remain present. The earlier wave-three emulator observation showed both existing Traces and the privacy control at epoch zero; it was not rerun in this backend-only wave. Run `pnpm state` for current status.

## Next work after certification and protocol design

[Coordination #29](https://github.com/KnowScroll/knowscroll/issues/29) records the clear-history wave; [#21](https://github.com/KnowScroll/knowscroll/issues/21) and [#13](https://github.com/KnowScroll/knowscroll/issues/13) retain earlier delivery evidence. Parent epics remain open. ADR-0010 defines implemented bootstrap clear and separates future pause, semantic reset, account deletion, backup retention and typed semantic proposal read sets.

Wave-four [coordination #37](https://github.com/KnowScroll/knowscroll/issues/37) records completed provider certification. [#42](https://github.com/KnowScroll/knowscroll/issues/42) accepts the production reasoning admission and unknown-outcome protocol under #7. Next: [#44 storage/privacy](https://github.com/KnowScroll/knowscroll/issues/44), then [#45 atomic admission/reconciliation](https://github.com/KnowScroll/knowscroll/issues/45) and [#46 J004 fault proof](https://github.com/KnowScroll/knowscroll/issues/46), following the [implementation plan](operations/reasoning-implementation-plan.md). These are planned work, not active provider jobs. Keep #2 public identity/recovery and #4 full privacy lifecycle explicit; clear history does not complete either. The semantic, recommendation and cosmic/social target remains unchanged.

## Component lanes

| Lane | Start | Ownership |
|---|---|---|
| Mobile | [#3](https://github.com/KnowScroll/knowscroll/issues/3) | apps/mobile; renderer/navigation contracts coordinated first |
| Core | [#4](https://github.com/KnowScroll/knowscroll/issues/4), then #5/#6 | events, privacy lifecycle, full Composer and semantic substrate |
| Reasoning | [#7](https://github.com/KnowScroll/knowscroll/issues/7) | worker runtime; certification and protocol complete; SQL runtime next |
| Coordinator | [#2](https://github.com/KnowScroll/knowscroll/issues/2), [#12](https://github.com/KnowScroll/knowscroll/issues/12) | identity boundary, shared contracts, integration and journey evidence |

The owner reports a token plan of 300 million tokens per five hours. ADR-0011 verifies the subscription route and enforces a much smaller cap plus a quota preflight before every certification request. Three live calls ran in wave four; post-run quota was 99% interval / 95% weekly. This is a dated shared-plan observation, not a current balance or cash-spend authorization. Cutroom needs a reachable configured host and file-import transport. No provider key is needed for the sourced-Scroll journey. Do not paste credentials into issues or commits.

Prepared checkout paths, branch names, ports and databases: [parallel worktrees](operations/worktrees.md).

## Operational limitation

Private-repository branch protection is unavailable on the current GitHub plan (HTTP403). CI and PR workflow are configured; required checks/reviews are not server-enforced. The repository remains private.
