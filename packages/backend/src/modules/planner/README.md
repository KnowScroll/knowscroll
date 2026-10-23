# modules/planner

The Personal Planner proposes a few useful next directions for one person (blueprint §10). It reads
the person's qualified evidence and the admitted inventory, asks a model for up to six candidate
opportunities, keeps at most three that code accepts, and stores them as a plan revision.

A plan is a set of suggestions. It is never evidence, never completes anything, never forms a
planet and never adds content. Composer may use it to rank content it already admits. Supply may
receive demand for content that does not exist yet.

| Capability | State |
|---|---|
| Material evidence change queues one run per person | implemented, CI-verified |
| Model role `personal-planner.v0` proposes, code validates and stores | implemented, CI-verified with an authored fixture model, run against the real model locally |
| Composer reads the current plan | implemented, CI-verified |
| Missing-supply opportunities become deferred supply demand | implemented, CI-verified |
| Planner and Cartographer respond independently | implemented (separate queues and roles) |
| Consumer UI for the plan | not planned: the plan has no screen of its own |
| Running on dev with real people | planned (see #222) |

## What starts a run

1. **Evidence changed.** The Evidence activity projection calls `PlannerMaterialChange` inside the
   transaction that records the change: a qualified encounter, a deliberate continuation or a Save.
   If queueing fails, the evidence change rolls back with it.
2. **A person asks.** `RequestPlanner` accepts an optional intent (language and topics) or resumes a
   blocked run. It checks the personal root and the recording gate, and keeps a command receipt.

Both paths do the same thing: raise `planner.state.desired_revision` and make sure exactly one
active run and one `planner.run` job exist for the person. Many changes while a run is active
become one newer desired revision, not many jobs.

`KS_PLANNER_ENABLED` is a switch on the worker. It defaults to `1` in the `local` world and to `0`
elsewhere; the dev world sets it to `1` in its environment file. When it is `0`, a delivery stores
`blocked_disabled` and reserves nothing. An explicit resume continues the same run.

## What the model sees

The worker freezes a bounded context once per run (`prepareContext`): the person's intent if any,
topics from recent evidence, the current plan and up to three older revisions, up to 100 admitted
inventory items, and up to 20 qualified evidence references. Titles and summaries are untrusted
data. The context never holds raw observations, provisional encounters, other people's data or
playback positions. The same frozen bytes are used on every redelivery and are hashed twice (module
body and model items) so a change is detected, not replayed.

Each inventory item is marked `encountered` when the person has already met its explanation. If the
person has no qualified evidence the run ends as `insufficient` and no model call is made.

## What code checks

The instructions (`INSTRUCTIONS` in `application/role.ts`) list every key and rule below, because a
rejected answer is a paid call that counts toward the role's daily failure brake. The model answers
`{"version":"planner-proposal.v0","opportunities":[...]}`. Code, not the model, decides what is
accepted (`opportunityIssue`, `diversify`):

- every topic is in the frozen context and every proposed topic has qualified evidence behind it;
- every evidence reference exists;
- an `existing` target is an exact admitted asset revision with its catalogue watermark, unit,
  topics and format, and is not hidden;
- a `missing_supply` target names a unit and topics that evidence or inventory already supports;
- expiry is after evaluation and at most seven days later;
- no duplicate IDs, formats or eligibility values inside one opportunity.

One repair attempt is allowed, with fixed hints. After the answer arrives code rechecks the same
facts against the current database inside the accepting transaction. Accepted opportunities are
diversified: one per explanation unit, at most two per move and at most two per topic, capped at
three. A run that finishes after newer evidence arrived is stored as `stale` and a successor runs.

## Where the output goes

| Consumer | How | Entry point |
|---|---|---|
| Composer | The latest accepted revision's unexpired opportunities ride in Composer's prepared context. A match raises Intent (vertical moves) or Continuity (horizontal moves) by a bounded share, and the decision record names the opportunity. | `READ_CURRENT_PLAN`, read by Personal Context |
| Supply | Each accepted `missing_supply` opportunity is recorded as private demand in the same transaction as the plan. Supply reuses admitted content the person has not met, otherwise the demand is `deferred` on a shared matching group. Nothing is produced. | `RecordPlannedDemand` |
| Cartographer, scenes, evidence | Nothing. A plan creates no evidence and no geography. | none |

`READ_CURRENT_PLAN` is a stored read of at most three small rows and is safe on the navigation
path. It returns a plan until every opportunity has expired, even while a newer run is waiting,
because Composer only reorders candidates it has already admitted. `READ_PLANNER_OPPORTUNITIES` is
the stricter read: it rechecks every reference against current inventory and evidence and reports
`stale` instead. Nothing on the navigation path uses it.

## Jobs, claims and recovery

`planner.run` carries IDs only (universe, epoch, run, original recording generation and a wake or
claim ID). It runs with concurrency 1, a 1200 s expiry and three retries with exponential delay.

- **Wake.** Each queued run owns one ordinary wake ID that equals the pg-boss job ID. A delivery
  whose wake does not match the run is obsolete and does nothing.
- **Claim.** The worker claims a prepared run for 1150 s and queues one delayed recovery wake for
  that claim. A crash is recovered by that wake, never by scanning.
- **Generation.** A run is born under one recording generation. If recording is paused and resumed,
  the old run is retired by a metadata-only wake and a fresh run is created for new evidence.
- **Unknown outcomes.** If a model request may have been sent, the run is `unknown`. It is never
  resent. Only an explicit `RequestPlanner` resume with the same run ID continues it, and the
  Reasoning ledger decides what is safe.
- **No model call inside a database transaction.** Preparation, the model call and the accepting
  transaction are three separate steps.

The full engine rules (attempt ledger, reservation, repair, quota, failure brake) belong to
`reasoning/README.md`.

## Storage

| Table | Holds | Notes |
|---|---|---|
| `planner.state` | desired and accepted revision, active run, intent | one row per person and epoch |
| `planner.runs` | one row per run: status, claim, wake IDs, recording origin, frozen context and its two hashes | the origin and context are written once |
| `planner.revisions` | accepted opportunities per revision, with the attempt that produced them | only the latest three are read |
| `pgboss/planner.run` | IDs-only jobs | the only work outbox |

Supply keeps the demand rows (`supply.requests`, origin `planner`, state `deferred`). See
`modules/supply/README.md`.

**Lock order.** Personal root, then the person's own account fence, then the run and state rows, then
the Reasoning ledger. Accepting a plan then calls Supply, which takes Content asset SHARE locks and
the shared matching group row. No lock on another person is ever held.

**Erasure.** A privacy Clear or full erasure removes revisions, then state, then runs, across every
epoch, and deletes queued, retained and dead-letter `planner.run` payloads. It also removes the
person's planned demand in `supply.requests`. A delivery for an earlier epoch is refused.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `KS_PLANNER_ENABLED` | `1` in world `local`, otherwise `0` | worker runs the role; the model still needs `KS_REASONING_PROVIDER=minimax` and a key |
| `KS_REASONING_*`, `MINIMAX_API_KEY` | see `reasoning/README.md` | provider, daily caps, failure brake |

The role uses policy `personal-planner.v0`, role version `planner2`, 12,288 output tokens (thinking
counts against them), one primary request and at most one repair. With `MiniMax-M3.1-Flash` a run
takes 20 to 110 seconds, so the worker needs `KS_MINIMAX_REQUEST_TIMEOUT_MS` of at least 180000.

## Entry points

`public.ts` exports the types, the queue and these tokens: `REQUEST_PLANNER`,
`PLANNER_MATERIAL_CHANGE`, `READ_CURRENT_PLAN`, `READ_PLANNER_OPPORTUNITIES`, `RUN_PLANNER`.
`adapters/nest-providers.ts` builds them: `plannerRequestProviders` (API and worker),
`plannerReadProviders` (API and worker) and `plannerWorkerProviders` (worker only).

Layout: `domain/proposal.ts` (schemas, `opportunityIssue`, `diversify`), `application/context.ts`
(frozen context), `application/role.ts` (instructions and output schema), `application/run.ts`
(the worker), `application/request.ts` (requests and material changes), `application/demand.ts`
(missing supply to Supply), `application/read-plan.ts` (the plan Composer reads).

## Verification

`tests/integration/modules/planner.test.ts` and `recording-planner.test.ts` cover receipts, wakes,
claims, recovery, generations, privacy and erasure with an authored fixture model.
`tests/integration/modules/planner-loop.test.ts` covers the connected loop: a qualified encounter
queues the run in the same transaction, the worker accepts a plan, Composer ranks with it and Supply
holds the deferred demand, and a Clear removes it all and fences a stale delivery. Fixture replies are
CI data, never provider evidence. Real-model behaviour has been run locally only; see PR #236 for the
runs and #222 for dev acceptance.
