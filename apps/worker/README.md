# @knowscroll/worker

Background worker: a Nest application context with no network listener. pg-boss claims jobs for
the queues in the explicit consumer registry (`src/jobs.ts`); nothing is discovered by
decorators. HTTP guards never run here, so every consumer's use case rechecks authority itself
under `withPersonalScope`.

| File | Role |
|---|---|
| `src/main.ts` | Validate config → database → Nest context → pg-boss (`consumer` role) → register consumers; on SIGTERM drain (bounded) → close context → close pool, exit 0 |
| `src/worker.module.ts` | Composition root: database, `withPersonalScope`, consumer wiring |
| `src/jobs.ts` | Explicit consumer registry: `evidence.apply-action` → `applyActionEvidence` |

Variables: `docs/v2/engineering/runtime-configuration.md`.

The composition root binds `PRODUCTION_REASONING_HARNESS` and `WITH_PRODUCTION_SCOPE` separately
from the personal harness. Nonpersonal Scroll supply requires explicit worker configuration and
the database root enabled/generation gate; both default disabled. Shared sweep/purge/operator
maintenance still records and resolves production liabilities while production is disabled.
