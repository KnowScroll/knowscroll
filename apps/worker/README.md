# @knowscroll/worker

## Startup and schedules

The worker starts pg-boss as a `consumer`, builds the Nest context and registers every consumer of
its explicit registry (`src/jobs.ts`). It creates and removes no schedule. Recurring schedules belong
to `dist/migrate.js` (`applyQueueDeclarations`), which registers each declared queue's schedule and
deletes the schedule of any queue that is no longer declared (logged as `jobs.schedule_removed`),
once per deploy while the old release is quiesced. A transient database error therefore fails the
migrate, which the deploy reports before the new release starts, and never a running worker.
Status: implemented and covered by `tests/integration/infrastructure/jobs.test.ts` against real
PostgreSQL.

## Clear exploration maintenance

Related: #345.

The explicit consumer registry includes `identity.clear-exploration`. Its IDs-only payload
locates an existing account-lifetime operation; durable core_done determines whether the
worker may obtain core-removal authority or only exact-set accounting authority. Selective
removal uses the complete verified owner registry and preserves every Saved/place/Social
row. Accounting retries cannot run a broad eraser or dispatch paid work. On a final handler
failure the consumer tries to record a coarse completion_unverified failure. The separate
`identity.recover-clear-operations` scheduled consumer reconciles durable due operations if that
write also fails, or if a final delivery expires or is lost before the handler can run its catch.
Identity bounds each recovery wave, rechecks exact operation authority and live delivery state,
and commits the recovery marker with its fixed-queue wake. Completed operations can recover
only their due exact-set accounting cleanup; they never reacquire core-removal authority.

The Clear core callback is the closed `eraseCurrentExploration` runner from the actual backend
erasure root. It runs the schema inventory, runs the real registry's owner removals and marks that
exact Clear transaction only after every owner reports `completed`. The worker accepts no
caller-provided registry or lookalike callback as lifecycle proof. Exact-set accounting and
recovery retain their separate existing authority; they cannot reacquire core removal.

This composition requires the durable core from PR #348 and the reviewed current lifecycle/schema
prerequisites; older installed schemas or an incomplete lifecycle cannot be certified by wiring.
Actions installed-release fixtures exercise the normal API and worker with disposable data
and no provider. Actual dev/stage privacy journeys require separate deployment evidence.

## Account deletion and export (D-043)

Related: #246.

The registry also holds `identity.delete-account` (erases one accepted account deletion in one transaction
through `eraseCurrentAccount`), `identity.recover-account-deletions` (every five minutes: hands pending, due
deletions back to the queue) and `identity.build-export` (builds one export file through
`exportCurrentPerson`). On a final failed delivery the consumer marks the receipt `needs_retry` (deletion) or
the export `failed`, best effort: the recovery cron and a retry are the other ways out. Their payloads are IDs
only (the operation or export id, never a person), and the logged outcomes carry no account, universe or
receipt id. The sweep `identity.sweep-sign-in-records` also retires exports.

## Visit list refresh (#241, D-047)

The `scenes.project` consumer calls Social's `REFRESH_VISIT_PUBLICATION` after it has projected a universe, so
planets formed after a person chose their systems reach the friends who may visit. It runs as a system actor
in its own transaction (`social.refresh-visit`), rechecks the universe and epoch itself, does nothing for a
universe that shares nothing, and writes nothing when the list is unchanged. A failure retries the job; the
projection that already committed is not repeated. No queue of its own, no model call and no network wait.

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
artifact access group. This importer sends nothing to Cutroom. `--fixture` additionally requires ci/local and
a disposable `ks_it_*`/`knowscroll_fixture_*` DB, and marks content visibly. Operator output is one
sanitised result line; external errors never log URLs/paths/response text. Failed copy/probe/admission
can leave an unreferenced object; never delete referenced bytes during rollback.

`node dist/operator.js journey <id>` and `journey --account <accountId>` (`src/journey-operator.ts`, #248) print one
record's timeline across modules, read from the `ops` views: IDs, states, codes and times only. `--json` prints one
JSON line. Exit 0 found, 2 not found or bad usage, 1 failure. Read-only; it needs only `KS_WORLD` and `DATABASE_URL`.
Runbook: `docs/v2/operations/looking-at-the-system.md`.

`node dist/operator.js reel <check|order|follow|receive|status|write-off|settle> …` orders Reels from
Cutroom and brings them in (`src/reel-operator.ts`; the use cases and the guarantees are in
`packages/backend/src/modules/content/README.md`, "Reels from Cutroom"; the runbook is
`docs/v2/operations/cutroom-and-spend.md`). Settings: the import settings above plus the shared pool,
which is `KS_POOL_DATABASE_URL` or, by default, the world's own `DATABASE_URL` pointed at
`knowscroll_pool`. Only `reel order --until video` can spend, only through a claim in the pool, and
only up to the ceiling, which must be Cutroom's own 75 cents. The worker service registers no Reel job:
every step is an operator command. Output is one JSON line per result; exit 0 done or under way, 2
refused or not ready yet, 1 failure.

The composition root binds `PRODUCTION_REASONING_HARNESS` and `WITH_PRODUCTION_SCOPE` separately
from the personal harness. Nonpersonal Scroll supply requires explicit worker configuration and
the database root enabled/generation gate; both default disabled. Shared sweep/purge/operator
maintenance still records and resolves production liabilities while production is disabled.

The `content.produce-scroll` consumer (`src/production-jobs.ts`, #239) runs the production use case for
one recipe and take per delivery, with resume, so a redelivery continues the same business run. It is
registered only when `KS_REASONING_PRODUCTION_ENABLED=1`; otherwise jobs wait in the queue. The
`supply.resolve-request` consumer advances a person's request (a free-text match, the wait for
production, binding) with the personal reasoning harness. `KS_SUPPLY_CREATE_DAILY_CAP` caps the
productions Create may start per UTC day for people's asks (default 20 in `local`, 0 elsewhere);
`KS_SUPPLY_PLANNER_CREATE_DAILY_CAP` (default 5) caps the Planner's demand apart from it.

`node dist/operator.js supply recover-open-demand [--dry-run]` (`src/supply-operator.ts`) sends one
resolver job for every ask that is still open from before Create existed and prints the counts. It is
idempotent and calls no provider.

`node dist/operator.js content produce-library [--only <keys>] [--interactive-first] [--dry-run]` sends
the production jobs of recipes that need one (a rejected recipe gets its next take, at most three) and
`content production-status [--only <keys>]` lists every recipe's standing. Both touch only the shared
database and pg-boss; no provider is called.

The content production operator is `node dist/operator.js content produce-scroll --topic <recipe>
[--take <1-3>] [--dry-run] [--resume]`, a debugging tool over the same use case. It refuses worlds outside dev/stage/ci/local, defaults to
`MiniMax-M3.1-Flash`, prints a two-request maximum (one writer call and at most one repair), uses the
explicit nonpersonal harness grant, and emits bounded IDs, outcome codes and reported usage only.
`--resume` reuses the frozen job and attempt IDs; unknown attempts never resend. When a Scroll is
refused, `node dist/operator.js reasoning rejected [--attempt <uuid>]` shows the kept, redacted answer
and the validator's findings. No production job or source text is placed on the HTTP path.

The explicit `planner.run` consumer (#236) calls the personal Planner with the delivery abort
signal. `KS_PLANNER_ENABLED` defaults to 1 in world `local` and 0 elsewhere (dev sets 1); with 0,
deliveries persist `blocked_disabled` with no reservation. The role spends the shared MiniMax plan
within the harness caps. Backend
`RequestPlanner(authority,{commandId,resumeRunId})` requeues the same blocked business ID after
review; unknown attempts remain ledger-bound and never resend. There is no direct paid Planner
operator command or consumer UI in this slice. Protected `planner.*` rows expose revisions/status
for operator inspection; ordinary logs contain no Planner context or proposal text.

The `composer.prepare-buffer` consumer (#234) prepares the next vertical Explore move for an offer the
person just activated and stores it for the next navigation (`modules/composer/README.md`). It reads the
session, candidates and Hide in one short transaction, may ask Jev (`KS_JEV_ENABLED=1`) outside any
transaction, then persists the ranking and replaces the person's buffer in a second one. A job for a
superseded intent, an unactivated offer or an old epoch is skipped. A redelivery does nothing. It logs
`composer.buffer_prepared` with the outcome code and counts only.

U05 (#363) normally registers the fixed `scenes.expire-formation` consumer and five-minute UTC
`scenes.recover-formation` scheduled consumer. They finalize only the exact current due claim as
skipped, never create formation, grant animation, consume content or invoke a model/provider.
Expiry has 120s/three 10s-backoff retries; recovery 180s/three 15s-backoff retries; both concurrency 1,
7d queued/2d settled plus declared dead letters. Recovery re-enters owner/epoch/root/Clear fences
with 250ms locks/2s statements and at most 30s between-op work per delivery. Generated bigint ordinal
pages read 101/process 100 against a captured ceiling; one required fixed advancing child commits
before any owner root acquisition. Live duplicate child cursors dedupe, final pages do not wake
again, and overlapping scheduled passes may revisit due rows. Exhausted final delivery/root lock
or crash leaves durable due state for the next finite pass. The ordinal-only global cursor has
no personal UUID or per-account effect authority; full/Clear erases the personal row and all exact
private expiry job states. Old late work cannot restore removed IDs or touch fresh-epoch data.

## Personal recording composition

Related: #381.

The worker binds Identity's actual own-account adapter and `FENCE_PERSONAL_RECORDING`. The
own-account adapter supplies the branded current lifecycle reader through the same actual gate;
root-only or pair-only authority cannot stand in for it. Each personal recording use case owns
its existing fresh root → one account UPDATE → original-generation protocol. The composition root neither acquires
a second gate nor creates a recording capability.

Planner and Geography inject the required `RECORDING_REASONING_HARNESS` built by
`personalRecordingReasoningProviders`, with BOTH actual module-owned run checkers. Its role
header/purpose/account/original-generation/claim/full-context/model-context proof is required
before private execution and apply. The generic compatibility harness and nonpersonal production
harness remain separate; neither substitutes for a missing recording-role owner. Missing tokens
or required owner effects fail construction rather than return a successful empty result.

Evidence receives the actual Experience lineage/channel readers, lifecycle reader and PC's
four-method activity effect. The required material callback passes the SAME genuine original-
generation capability and source revision to actual Planner and Geography in the caller's
transaction. Source intake, qualification and derived work retain their own finite bounds and
original delivery identities. The explicit consumer registry, same-business attempt ledger,
strict normal/retirement UUIDs and claim-fenced recovery remain owning; no additional queue,
provider allowance, poller or automatic paid retry is introduced.

These bindings preserve all feature/provider/production flags and paid permits, including their
default-disabled behavior. The existing installed release boot fixture constructs the real Nest
worker registry and checks start plus bounded SIGTERM drain; it is meaningful DI/process evidence
only when run by hosted Actions on the final composed candidate. Full positive recording,
paused/stale/cross-generation, retained-accounting and populated Clear behavior still require the
actual complete API/client/worker graph and separate hosted/real-service acceptance. Local
static checks and source review alone establish neither activation nor deployment.
