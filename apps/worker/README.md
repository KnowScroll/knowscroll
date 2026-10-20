# @knowscroll/worker

Background worker: a Nest application context with no network listener. pg-boss claims jobs for
the queues in the explicit consumer registry (`src/jobs.ts`); nothing is discovered by
decorators. HTTP guards never run here, so every consumer's use case rechecks authority itself
under `withPersonalScope`.

| File | Role |
|---|---|
| `src/main.ts` | Validate config → database → Nest context → pg-boss (`consumer` role) → register consumers; on SIGTERM drain (bounded) → close context → close pool, exit 0 |
| `src/worker.module.ts` | Composition root: database, `withPersonalScope`, consumer wiring |
| `src/jobs.ts` | Explicit consumer registry: `evidence.apply-action` → `applyActionEvidence`; `evidence.project-scroll-reading` → `projectScrollReading` (qualifies a reading, commits an evidence revision, hints the account); `identity.sweep-sign-in-records` |

Variables: `docs/v2/engineering/runtime-configuration.md`.
