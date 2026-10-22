# @knowscroll/worker

## Clear exploration maintenance (#345)

The explicit consumer registry includes `identity.clear-exploration`. Its IDs-only payload
locates an existing account-lifetime operation; durable core_done determines whether the
worker may obtain core-removal authority or only exact-set accounting authority. Selective
removal uses the complete verified owner registry and preserves every Saved/place/Social
row. Accounting retries cannot run a broad eraser or dispatch paid work. After the queue's
finite retry policy is exhausted, the consumer records a coarse completion_unverified failure.

This composition requires the durable core from PR348 and its installed schema/queue policy.
Actions installed-release fixtures exercise the normal API and worker with disposable data
and no provider. Actual dev/stage privacy journeys require separate deployment evidence.

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

The content production operator is `node dist/operator.js content produce-scroll --topic
seasons|tides|greenhouse [--dry-run] [--resume]`. It refuses worlds outside dev/stage/ci/local,
prints a four-request maximum, uses the explicit nonpersonal harness grant, and emits bounded
IDs/outcome codes and reported usage only. `--resume` reuses frozen stages and attempt IDs;
unknown attempts never resend. No production job or source text is placed on the HTTP path.

The explicit `planner.run` consumer (#236) calls the personal Planner with the delivery abort
signal. `KS_PLANNER_ENABLED=0` is the default; deliveries persist `blocked_disabled` with no
reservation. The role needs a separately approved paid allowance before enablement. Backend
`RequestPlanner(authority,{commandId,resumeRunId})` requeues the same blocked business ID after
review; unknown attempts remain ledger-bound and never resend. There is no direct paid Planner
operator command or consumer UI in this slice. Protected `planner.*` rows expose revisions/status
for operator inspection; ordinary logs contain no Planner context or proposal text.
