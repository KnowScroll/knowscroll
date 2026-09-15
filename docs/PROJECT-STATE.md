# Project state

Updated: 2026-09-16 (Asia/Kolkata). **First reliability wave verified; next milestone: Owner Alpha.** This file describes durable status; it does not guarantee a process is running now. Run `pnpm state` for a timestamped observation.

## What exists

- Private monorepo: [KnowScroll/knowscroll](https://github.com/KnowScroll/knowscroll).
- Private [Project](https://github.com/orgs/KnowScroll/projects/1), 12 initial issues and four delivery milestones.
- Kotlin/Compose Android skeleton; build, lint, real emulator keep/return and Activity recreation verified.
- Real Fastify API, PostgreSQL Ledger, SQL jobs and separate deterministic worker.
- Three sourced editorial Scrolls. Exposure and idempotent keep admission; Accounts/Trace projection; next feed excludes kept assets.
- First migration: `0001_bootstrap.sql`; checksummed execution, pinned legacy adoption and ordered-migration drift rejection. No additional domain migration in wave one.
- Android restores the current Scroll, reading position and retry identities after process death; returning to Universe starts a fresh transient browsing history.
- J001 checks persisted decision/exposure/event/job/Accounts/Trace/source lineage. A repeatable isolated runner launches API and worker separately and rejects a deliberately mismatched verifier database.

## What is not built

The complete Composer, semantic bridge/hypothesis layer, meaningful world evolution, generated Reels, MiniMax adapter, long-horizon runtime, Cutroom adapter, rooms, social Blend, offline sync and production identity. They remain explicit target scope in [architecture/target](architecture/target/README.md) and issues #2–#12. Provider ports are declarations; they are not live integrations.

## Current decisions

Native Android, TS API/worker, PostgreSQL, one product monorepo, external Cutroom. [ADRs](decisions/README.md) own these choices. [Product definition](product/definition.md) owns product laws. [Design direction](product/design-direction.md) resolves the two prototypes. [Component map](architecture/component-map.json) owns responsibility boundaries.

## Evidence and limits

See [J001](journeys/J001.md). Backend implementation and HTTP journey passed. Three real Android instrumentation checks passed: sourced Scroll keep/return with Activity recreation; unavailable API; compact-screen recovery. Screenshots and source hashes are in the linked evidence. [GitHub CI](https://github.com/KnowScroll/knowscroll/actions/runs/35007382446) passed backend and Android checks for `b95b2de`. No user usefulness, load capacity, production deployment or model compatibility claim follows from those checks.

Wave-one review and combined runtime proof: [J001 evidence](journeys/evidence/wave1-integration/README.md). Twelve backend tests and two verifier rejection tests passed; all five Android instrumentation phases passed, including force-stop/cold relaunch with the same reading position and retry identities. These checks do not prove a lost response after admission, physical-device eviction timing, frame performance or user usefulness.

Last development observation: 2026-09-15 18:52 UTC (00:22 India, September 16). API healthy, worker heartbeat fresh, pinned bootstrap checksum adopted and the same two projection jobs completed. Use `pnpm state` to refresh; this is a timestamped observation, not a promise that these processes remain running.

## Next work after wave one

[Coordination #13](https://github.com/KnowScroll/knowscroll/issues/13) records ownership, review, merged slices and resume steps. Parents #3, #4 and #12 remain open. Settle #2 identity ownership and #4 privacy-epoch/read-set contracts before releasing dependent reasoning or offline-admission implementation. The full semantic, recommendation and cosmic/social target remains unchanged.

## Component lanes

| Lane | Start | Ownership |
|---|---|---|
| Mobile | [#3](https://github.com/KnowScroll/knowscroll/issues/3) | apps/mobile; renderer/navigation contracts coordinated first |
| Core | [#4](https://github.com/KnowScroll/knowscroll/issues/4), then #5/#6 | events, privacy lifecycle, full Composer and semantic substrate |
| Reasoning | [#7](https://github.com/KnowScroll/knowscroll/issues/7) | worker runtime; certification before paid product calls |
| Coordinator | [#2](https://github.com/KnowScroll/knowscroll/issues/2), [#12](https://github.com/KnowScroll/knowscroll/issues/12) | identity boundary, shared contracts, integration and journey evidence |

MINIMAX_API_KEY is needed for the future live certification task, together with an explicit experiment budget. Cutroom needs a reachable configured host and file-import transport. No key is needed for the current sourced-Scroll journey. Do not paste credentials into issues or commits.

Prepared checkout paths, branch names, ports and databases: [parallel worktrees](operations/worktrees.md).

## Operational limitation

Private-repository branch protection is unavailable on the current GitHub plan (HTTP403). CI and PR workflow are configured; required checks/reviews are not server-enforced. The repository remains private.
