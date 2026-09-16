# Project state

Updated: 2026-09-16 (Asia/Kolkata). **Reliability, session/epoch and clear-history waves verified; next milestone: Owner Alpha.** This file describes durable status; it does not guarantee a process is running now. Run `pnpm state` for a timestamped observation.

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

## What is not built

The complete Composer, semantic bridge/hypothesis layer, meaningful world evolution, generated Reels, MiniMax adapter, long-horizon runtime, Cutroom adapter, rooms, social Blend, offline sync and production identity. They remain explicit target scope in [architecture/target](architecture/target/README.md) and issues #2–#12. Provider ports are declarations; they are not live integrations.

## Current decisions

Native Android, TS API/worker, PostgreSQL, one product monorepo, external Cutroom. [ADRs](decisions/README.md) own these choices. [Product definition](product/definition.md) owns product laws. [Design direction](product/design-direction.md) resolves the two prototypes. [Component map](architecture/component-map.json) owns responsibility boundaries.

## Evidence and limits

See [J001](journeys/J001.md). Backend implementation and HTTP journey passed. Three real Android instrumentation checks passed: sourced Scroll keep/return with Activity recreation; unavailable API; compact-screen recovery. Screenshots and source hashes are in the linked evidence. [GitHub CI](https://github.com/KnowScroll/knowscroll/actions/runs/35007382446) passed backend and Android checks for `b95b2de`. No user usefulness, load capacity, production deployment or model compatibility claim follows from those checks.

Wave-one review and combined runtime proof: [J001 evidence](journeys/evidence/wave1-integration/README.md). Twelve backend tests and two verifier rejection tests passed; all five Android instrumentation phases passed, including force-stop/cold relaunch with the same reading position and retry identities. These checks do not prove a lost response after admission, physical-device eviction timing, frame performance or user usefulness.

Wave-two review and runtime proof: [session integration evidence](journeys/evidence/wave2-integration/README.md). Thirty backend tests, two verifier rejection tests, J001, J002 and all five Android phases passed. Interrupted J002 left no new databases or API/worker processes. Migration preserved hashes and counts for every original domain table; existing history was not reset.

Wave-three review and runtime proof: [clear-history evidence](journeys/evidence/wave3-integration/README.md). Thirty-eight backend tests, two verifier rejection cases, isolated J001/J002/J003 and six Android privacy phases passed. Exact retries survive a dropped committed response and process death; foreign local universe bindings cannot dispatch a clear. Existing reading/keep/restore regression results and dated development observations are recorded alongside those receipts.

Last development observation: `2026-09-16T05:01:20.753Z`. API healthy, worker heartbeat fresh, all three migration checksums present; the updated regular emulator app shows both existing Traces and the privacy control at epoch zero. Run `pnpm state` for current status.

## Next work after wave three

[Coordination #29](https://github.com/KnowScroll/knowscroll/issues/29) records the clear-history wave; [#21](https://github.com/KnowScroll/knowscroll/issues/21) and [#13](https://github.com/KnowScroll/knowscroll/issues/13) retain earlier delivery evidence. Parent epics remain open. ADR-0010 defines implemented bootstrap clear and separates future pause, semantic reset, account deletion, backup retention and typed semantic proposal read sets.

Next: #7 provider certification preparation. Verify the configured MiniMax endpoint and token-plan coverage, define a bounded token experiment and response/timeout/cancellation evidence before live calls. Keep #2 public identity/recovery and #4 full privacy lifecycle explicit; clear history does not complete either. The semantic, recommendation and cosmic/social target remains unchanged.

## Component lanes

| Lane | Start | Ownership |
|---|---|---|
| Mobile | [#3](https://github.com/KnowScroll/knowscroll/issues/3) | apps/mobile; renderer/navigation contracts coordinated first |
| Core | [#4](https://github.com/KnowScroll/knowscroll/issues/4), then #5/#6 | events, privacy lifecycle, full Composer and semantic substrate |
| Reasoning | [#7](https://github.com/KnowScroll/knowscroll/issues/7) | worker runtime; certification before paid product calls |
| Coordinator | [#2](https://github.com/KnowScroll/knowscroll/issues/2), [#12](https://github.com/KnowScroll/knowscroll/issues/12) | identity boundary, shared contracts, integration and journey evidence |

The owner reports a token plan of 300 million tokens per five hours for future certification. Before #7 live calls, verify the configured provider endpoint/plan and encode a bounded run cap; a token allowance does not establish arbitrary cash spending permission. No paid provider call ran in wave two. Cutroom needs a reachable configured host and file-import transport. No provider key is needed for the sourced-Scroll journey. Do not paste credentials into issues or commits.

Prepared checkout paths, branch names, ports and databases: [parallel worktrees](operations/worktrees.md).

## Operational limitation

Private-repository branch protection is unavailable on the current GitHub plan (HTTP403). CI and PR workflow are configured; required checks/reviews are not server-enforced. The repository remains private.
