# modules/planner

Personal Planner source for #236 (blueprint §§10,15,19). It proposes future exploration; it writes
no Evidence, qualification, interest, geography, completion, production admission or content.
Schema acceptance and authored CI fixtures do not establish that suggestions are useful. This
slice has no deployed/real-provider acceptance until separately recorded by the coordinator.

## Public capabilities and execution gate

`PlannerMaterialChange(scope,{sourceRevision})` is an Evidence-owned callback supplied by composition.
After an actual Evidence activity or PC correction/catchup changes, Evidence advances the personal
scope revision and invokes it once inside the **same** transaction. Unchanged replay invokes nothing.
Both shipped API and worker install this request-only facility. API composition has no Planner
harness/provider. Failure rolls source projection, PC, revision and the required job back together.

`RequestPlanner(authority,{commandId,intent?})` is a backend-only deliberate request, with optional
`{language,topicIds}` bounded explicit intent. It locks/rechecks authority before receipt lookup;
receipt, desired revision, state, active business run and pg-boss send commit together. Identical
replays return the original accepted revision/run ID; another payload under the same command ID
refuses. Its receipt stays accepted; evolving run status is stored separately. No HTTP/client
contract is introduced. Automatic contexts say `intent.availability: unavailable` and use the
explicit English inventory-selection policy; they never infer intent by scanning other sessions.

`KS_PLANNER_ENABLED=0` is the worker default. A delivery records `blocked_disabled` without any
model reservation or invocation. Enabling it is a deployment/configuration action, **not paid
allowance**. D-024's #232 Scroll grant does not authorise this role. The coordinator must obtain a
concrete role grant before enabling paid Planner execution; existing harness caps, quota checks,
unknown accounting and failure brake still apply. No live request was made by implementing this
source. The role is `planner.personal-planner`, version `planner1`, policy `personal-planner.v0`;
4096 output tokens, one primary + at most one separately admitted repair (maximum2 requests/run).

After reviewing configuration/allowance, resume the **same** blocked business ID through the typed
request facility:

```ts
await requestPlanner(authority, { commandId: newCommandId, resumeRunId: blockedRunId });
```

Resume preserves frozen intent/context and existing attempt identity; an unknown attempt remains
unknown and never resends. A disabled run that never prepared context freezes the latest desired
revision on its first enabled delivery. There is no automatic timer/requeue that evades a disabled,
budget, quota or failure-brake refusal, and no direct paid operator bypass in this slice. Operator
inspection uses the protected `planner.state`, `planner.runs` and `planner.revisions` rows; no private
context or model output is emitted to ordinary logs. Existing reasoning operator capabilities own
attempt reconciliation/write-off; a write-off is not remote completion or retry permission.

`ReadPlannerOpportunities(scope,{evaluatedAt,limit:1..3})` is a typed backend-only future Composer
port. It uses the caller's current live personal transaction, reports absent/stale/available with
plan/PC revisions, filters expiry and rechecks current evidence/asset authority and Hide. It does
not open content. Navigation must still enforce its own capability/access/revision/intent checks.
No Composer scoring or UI consumer is invented here. `RunPlanner(payload,signal)` is worker-only.

## Coalescing and transaction boundaries

A caller/epoch has one desired revision, one active business ID and at most one pending pg-boss
wake-up per run. Material source revisions deduplicate. Requests while queued coalesce; preparation
captures the latest desired revision. Changes during execution update desired state without opening
another role run. A conclusive stale result is refused, closes its harness run and atomically creates
one successor for the latest revision. Unknown outcomes retain the active run and prevent successors
until the same ledger work is conclusively resolved. Terminal failures do not silently start a new
run for the same desired revision.

The `planner.run` queue contains only version/universe/epoch/run IDs. It uses local concurrency1,
1000s expiry, three retries with30s exponential backoff, seven-day queued retention, two-day result
retention and the common14-day dead-letter retention. A950s claim token fences concurrent deliveries;
a live claim returns `already_running`. A crashed delivery resumes its frozen business run after
claim expiry. The expiry exceeds two attempts at maximum300s transport +10s quota + two maximum60s
scope locks per attempt plus margin. Claim tokens cannot override the harness's external-attempt
ledger. A duplicate unknown delivery never sends/repairs another attempt.

Lock order is personal root → Planner state/run/domain rows → harness admission/attempt bookkeeping
as defined by the shared engine. Preparation and apply are short distinct `withPersonalScope`
transactions. The harness runs **between** them, never inside a transaction or HTTP navigation.
Application rechecks active run/claim, epoch, desired revision, PC revision, exact current catalog
watermarks, qualified supporting source hashes, eligibility/Hide and expiry before applying.
Accepted revision and harness closure commit together; rollback leaves the kept answer available
for the same run without another invocation. No second transport outbox exists.

## Prepared context, authority and memory

Context policy `plan_inventory_recent_union.v0` unions explicit intent, actual current plan,
actual admitted inventory and recency-selected projected topic seeds under100 topics total. It
prepares at most100 inventory assets/units, exact unit support probes, recent routing at most20,
and at most20 qualified supporting source references. Recent discovery reports `hasMore`; topic
truncation is explicit. These are bounded lanes, never global highest activity or lifetime scans.
The full PC snapshot retains `completeness: not_asserted`, `coverageAvailability: unavailable` and
actual statistics availability. PC/Evidence own all arithmetic and distinct qualified-unit counts.
No provisional tail is sent to the model; it cannot contribute arithmetic, structural support or
formation. Asset facet tags do not become covered facets.

The frozen bundle stores the exact PC source vector and SHA-derived evidence refs, current eligible
inventory references with bounded titles/summaries, current plan and at most the last three accepted
revision sets as fallible memory. Corrected, expired or unsupported memory is omitted from model
input. The harness receives small prepared JSON items (≤64 items, ≤32768 chars each), frames all
text as untrusted data, and stores protected request bytes under its existing expiry/erasure policy.
Unaccepted answers never become memory; hidden chain-of-thought is neither requested nor stored.
Aggregate prepared context also has explicit UTF-8 limits:500000 bytes frozen and180000 bytes
of escaped model-item data with framing margin. An oversized bundle finishes as insufficient
`context_bounds` without reservation; it is never truncated into asserted completeness. No raw
observations, personal message bodies or another person's data are prepared.

Output proposes up to six priority candidates: example/mechanism/limitation/consequence/perspective/
connection, exact topic/unit/evidence refs, vertical/related eligibility, format preferences, expiry
within seven days, and either an exact eligible asset revision/watermark or missing-supply brief.
Every proposed topic needs a qualified nonincidental supporting source. Missing-supply unit refs
must already occur in prepared evidence/inventory; new canonical identities are not model-created.
Semantic authority issues use a fixed safe repair-hint catalogue. Code retains at most three, with
distinct explanation identities and at most two of a move or topic. Missing supply stays an
**unadmitted unresolved opportunity**; #239 Quartermaster must add its own admission capability.
No Cutroom or Scroll commissioning occurs, and suggestions never generate consumption evidence.

## Storage and erasure (`0021`)

| Table | Role and bounds | Lifecycle |
|---|---|---|
| `planner.state` | One caller/epoch desired/material/accepted revision + active ID; explicit intent≤4KiB | Root lock; epoch scoped; all epochs erased |
| `planner.runs` | Stable business identity, status/claim, versioned frozen prepared JSON≤512KiB | Idempotent deliveries; accepted/rejected/stale/insufficient audit; all contexts erased |
| `planner.revisions` | Accepted revision/context/run/attempt refs, ≤3 opportunities and≤32KiB | Revision audit retained until personal erasure; memory reads latest3 only |

Bounded memory is the latest-three projection over accepted audit rows, not another transcript or
unbounded prompt history. Frozen source context and accepted audit remain personal and erasable.
`plannerErasure` removes revisions → state → runs across **all epochs**, plus queued/active/retained/
dead-letter Planner payloads. Shared reasoning erasure removes protected requests and personal
attempt/run data while retaining minimal unlinked accounting per its own rules. Registry/queue
inventory covers all declared stores. No separate files, caches, embeddings or external memory exist.
Migrations0001–0020 remain immutable;0021 is additive and older workers ignore the Planner tables.

Verification is GitHub Actions only: pure validator/diversity fixtures; real-PostgreSQL receipt,
coalescing, source/apply rollback, concurrent claim/stale successor, unknown no-resend, correction,
bounds, memory, expiry, privacy/erasure fixtures; separate role-evaluation cases for malicious context,
insufficient/corrected support and one safe repair. All model replies are explicitly authored CI
fixtures. Local schema generation/typecheck/lint/build are source checks, not test/runtime evidence.
