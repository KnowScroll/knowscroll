# @knowscroll/worker

Background worker: a Nest application context with no network listener. pg-boss claims jobs for
the queues in the explicit consumer registry (`src/jobs.ts`); nothing is discovered by
decorators. HTTP guards never run here, so every consumer's use case rechecks authority itself.

| File | Role |
|---|---|
| `src/main.ts` | Validate config → database → Nest context → pg-boss (`consumer` role) → register consumers; on SIGTERM drain (bounded) → close context → close pool, exit 0 |
| `src/worker.module.ts` | Composition root |
| `src/jobs.ts` | Explicit consumer registry |

Variables: `docs/v2/engineering/runtime-configuration.md`.
