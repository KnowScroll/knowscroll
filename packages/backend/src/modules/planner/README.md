# modules/planner

## Follow a plan

Qualified evidence or an explicit request queues work for one person's Planner. The worker
freezes a bounded context under the current recording authority, releases the transaction for
the model call, then rechecks the run and applies only opportunities code accepts.

Start at [public.ts](public.ts), [request.ts](application/request.ts) and [run.ts](application/run.ts).
One business run can have several queue deliveries; its paid attempts keep their ledger identity.
An `unknown` attempt is not resent. A later successor run does not settle that old liability.
Composer can rank with the accepted plan; Supply can commission its missing content. Neither
turns a suggestion into evidence or a formed place.

From the repository root, run
`pnpm --filter @knowscroll/backend exec vitest run src/modules/planner`
for local rules and fixtures. Real-database and installed-process checks use the
[integration suite](../../../../../tests/integration/README.md). Runtime notes below describe
their recorded checks; see [Status](../../../../../docs/STATUS.md) for deployment evidence.

The Personal Planner proposes a few useful next directions for one person (blueprint §10). It reads
the person's qualified evidence and the admitted inventory, asks a model for up to six candidate
opportunities, keeps at most three that code accepts, and stores them as a plan revision.

A plan is a set of suggestions. It is never evidence, never completes anything, never forms a
planet and never adds content. Composer may use it to rank content it already admits. Supply may
receive demand for content that does not exist yet.

| Capability | State |
|---|---|
| Material evidence change queues one run per person, paced five minutes apart | implemented, CI-verified |
| A valid plan is accepted although more evidence arrived; budget ends a run and closes its ledger run | implemented, CI-verified (D-052) |
| Model role `personal-planner.v0` proposes, code validates and stores | implemented, CI-verified with an authored fixture model, run against the real model locally |
| Composer reads the current plan | implemented, CI-verified |
| Missing-supply opportunities become deferred supply demand, carrying the model's move, unit and brief on the person's own demand row | implemented, CI-verified |
| Every missing-supply opportunity ends as one counted outcome (reused, already recorded, commissioned, joined, not commissioned or unsupported, each with its reason), in the plan's own transaction | implemented, CI-verified |
| Supply commissions new content from a Planner opportunity | not built: the chooser skips v2 recipes (D-138), so nearly every opportunity ends `not_commissioned` (`no_recipe_left`) until a later slice of #674 |
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

Runs are paced (D-052). A settled run sets `planner.state.next_run_not_before` five minutes ahead
(`domain/pacing.ts`), and the wake of the next run waits for it. Evidence that arrives meanwhile joins
that pending run, which freezes its context when it starts. The first run after a quiet period starts at
once. A request (`REQUEST_PLANNER`) is not paced: it starts a run at once when none is pending and otherwise joins the pending one. It is a latent operator path: nothing in the product calls it yet. A plain request accepted while a run works does not void that run's plan (only a new intent does); it gets a paced successor.

A run that stopped does not end the person's Planner. New evidence puts a `blocked` run (disabled, no
provider, quota, a refusal: nothing was sent) back in the queue by the same transition as an
explicit resume, so a paid answer already kept in the ledger is reused, never paid for twice. An
`unknown` run (a request may have been sent) is woken instead. The worker then retires it, and a
successor with a new business run takes over, once the Reasoning ledger says its attempt is settled
or the run is two hours old. The attempt is never resent; it stays in the ledger as a liability.

The Planner is a background role (D-058): besides the person's whole day it stops at its share of the global
and the person's budgets (`KS_REASONING_BACKGROUND_SHARE_PERCENT`, default 50),
so a person who only reads keeps the rest of their allowance for what they ask for.

Budget does not block a run. When the person's day of tokens, their background share or the failure brake refuses the call,
the run ends `insufficient` (`budget_exhausted` or `failure_brake`), its ledger run is closed
`cancelled` so nothing is left admitted, and the next evidence starts a new run (paced), which asks
again. The same happens when the ledger run behind a run is found closed or spent (`run_closed`,
`run_mismatch`, `attempts_exhausted`), for example after the idle sweep closed it: the run ends and a
new business run takes over. A run that holds an `unknown` attempt never ends this way.

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

Inventory is read by topic, and Content refuses a read over `DISCOVERY_MAX_TOPICS` topics. The
Planner therefore filters inventory by the first `DISCOVERY_MAX_TOPICS` of intent, then current-plan, then recent topics,
so a reader with a long history still gets a run; the context's own topic list keeps its wider bound.

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
  topics and format, is not hidden, and is an explanation the person has not met yet;
- a `missing_supply` target names a unit and topics that evidence or inventory already supports;
- expiry is after evaluation and at most seven days later;
- no duplicate IDs, formats or eligibility values inside one opportunity.

One repair attempt is allowed, with fixed hints. After the answer arrives code rechecks the same
facts against the current database inside the accepting transaction. Accepted opportunities are
diversified: one per explanation unit, at most two per move and at most two per topic, capped at
three. A valid plan is accepted although more evidence arrived while the model worked: every
opportunity is checked against today's evidence and inventory, and the evidence behind the plan is
recorded as the context it was made from. The later evidence gets its own paced run. The plan is stored
as `stale` only when the person asked for something else meanwhile (a new intent) or an opportunity no
longer holds.

## Where the output goes

| Consumer | How | Entry point |
|---|---|---|
| Composer | The latest accepted revision's unexpired opportunities ride in Composer's prepared context. A match lifts Intent (vertical moves) or Continuity (horizontal moves) by a bounded amount among candidates the intent does not separate, and the decision record names the opportunity. | `READ_CURRENT_PLAN`, read by Personal Context |
| Supply | Each accepted `missing_supply` opportunity is recorded as private demand in the same transaction as the plan, unless the person already has open planned demand for the same brief. Supply reuses admitted content the person has not met, otherwise the demand is `deferred` on a shared matching group. Supply may join or start production within its separate cap. The demand row keeps the opportunity's move, explanation unit and brief (`planned_intent`, the person's own row only); Supply still chooses by code. Where nothing starts, the outcome says why. Afterwards the Planner counts every outcome of the plan once. | `RecordPlannedDemand`, `CountPlannedDemand` |
| Cartographer, scenes, evidence | Nothing. A plan creates no evidence and no geography. | none |

`READ_CURRENT_PLAN` is a stored read of at most three small rows and is safe on the navigation
path. It returns a plan until every opportunity has expired, even while a newer run is waiting,
because Composer only reorders candidates it has already admitted. `READ_PLANNER_OPPORTUNITIES` is
the stricter read: it rechecks every reference against current inventory and evidence and reports
`stale` instead. Nothing on the navigation path uses it.

## Dry run (#674, D-411)

`planner dry-run --universe <uuid>` (worker operator command, `application/dry-run.ts`) says what a Planner run would do for one
universe now, without doing it. It enters the personal scope the way a read does (the root lock), in a READ ONLY transaction
that always rolls back, freezes the context the run freezes (`prepareContext`) and checks it packages for a model. No model is
called, no job is sent and no row changes. The output is counts and codes only (`domain/dry-run.ts`): `calls_model`,
`insufficient_evidence` (no qualified evidence: the run settles `insufficient/insufficient_evidence` with no call),
`proof_unavailable`, `context_bounds`, `disabled`, `recording_paused` or `not_runnable`; the topics in the frozen context, the
topic bound the inventory read is given (`DISCOVERY_MAX_TOPICS`), the inventory items and evidence references, and the context's
bytes. Never a topic, title, summary or unit. Status: **implemented**; covered by `application/dry-run.test.ts` and the "dry run"
cases of `tests/integration/modules/planner.test.ts`, which check that the counts equal the context the run then freezes.

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
| `planner.state` | desired and accepted revision, active run, intent, `next_run_not_before` (the pacing time) | one row per person and epoch |
| `planner.runs` | one row per run: status, claim, wake IDs, recording origin, frozen context and its two hashes | the origin and context are written once |
| `planner.revisions` | accepted opportunities per revision, with the attempt that produced them | only the latest three are read |
| `pgboss/planner.run` | IDs-only jobs | the only work outbox |

Supply keeps the demand rows (`supply.requests`, origin `planner`, state `deferred`) and the counters of what became of
each opportunity (`supply.planned_demand_outcomes`, codes and counts only). The Planner stores neither. See
`modules/supply/README.md` ("What became of the Planner's demand").

**Lock order.** Personal root, then the person's own account fence, then the run and state rows, then
the Reasoning ledger. Accepting a plan then calls Supply, which takes Content asset SHARE locks and
the shared matching group row, and last the outcome counter rows, sorted so that two accepting transactions never wait on
each other's counters in opposite orders. No lock on another person is ever held.

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
takes 15 to 225 seconds, so the worker needs `KS_MINIMAX_REQUEST_TIMEOUT_MS=300000`. A call that spends the whole ceiling on thinking returns no text and the single repair usually recovers it.

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
`planner.test.ts` also covers the churn rules: a plan accepted while more evidence arrived and one paced
successor, a plan staled by a new intent, a budget-refused run ended with its ledger run closed, and a run
whose ledger run was closed starting over with a new one, and a plain request accepted mid-flight getting a paced
successor.
`tests/integration/modules/planner-loop.test.ts` covers the connected loop: a qualified encounter
queues the run in the same transaction, the worker accepts a plan, Composer ranks with it and Supply
holds the deferred demand with the model's intent and one counted outcome, and a Clear removes it all and fences a stale delivery. Fixture replies are
CI data, never provider evidence. `application/demand.test.ts` covers what is handed to Supply (the intent of each
missing-supply opportunity, its slot) and that every outcome is counted once per plan. Real-model behaviour has been run locally only; see PR #236 for the
runs and #222 for dev acceptance.
