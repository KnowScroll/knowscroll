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

`node dist/operator.js content import-cutroom-reel --run <approved uuid> --script <greenhouse|seasons-v5|tides-v4>`
imports approved existing output at no spend. Required worker-only settings: `KS_WORLD`, `DATABASE_URL`,
`KS_MEDIA_ROOT`, `KS_CUTROOM_ORIGIN` (HTTP loopback only), `KS_CUTROOM_ARTIFACT_ROOT`; optional
`KS_FFPROBE_PATH` defaults `/usr/bin/ffprobe`. Only dev/stage/ci/local operator worlds are accepted.
The worker unit alone receives `SupplementaryGroups=ks-pool`; the API receives no Cutroom origin or
artifact access group. No Cutroom/provider POST exists. `--fixture` additionally requires ci/local and
a disposable `ks_it_*`/`knowscroll_fixture_*` DB, and marks content visibly. Operator output is one
sanitised result line; external errors never log URLs/paths/response text. Failed copy/probe/admission
can leave an unreferenced object; never delete referenced bytes during rollback.

The composition root binds `PRODUCTION_REASONING_HARNESS` and `WITH_PRODUCTION_SCOPE` separately
from the personal harness. Nonpersonal Scroll supply requires explicit worker configuration and
the database root enabled/generation gate; both default disabled. Shared sweep/purge/operator
maintenance still records and resolves production liabilities while production is disabled.
