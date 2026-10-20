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

The composition root binds `PRODUCTION_REASONING_HARNESS` and `WITH_PRODUCTION_SCOPE` separately
from the personal harness. Nonpersonal Scroll supply requires explicit worker configuration and
the database root enabled/generation gate; both default disabled. Shared sweep/purge/operator
maintenance still records and resolves production liabilities while production is disabled.

The content production operator is `node dist/operator.js content produce-scroll --topic
seasons|tides|greenhouse [--dry-run] [--resume]`. It refuses worlds outside dev/stage/ci/local,
prints a four-request maximum, uses the explicit nonpersonal harness grant, and emits bounded
IDs/outcome codes and reported usage only. `--resume` reuses frozen stages and attempt IDs;
unknown attempts never resend. No production job or source text is placed on the HTTP path.
