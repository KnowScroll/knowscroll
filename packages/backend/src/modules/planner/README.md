# modules/planner

Personal Planner source for #236/#381 (blueprint §§10,15,19). It proposes bounded future
opportunities. Suggestions never create Evidence, qualification, personal geography, completion,
production admission or content. The recording changes are source prerequisites: schema43,
Reasoning, real owner composition and hosted behavior checks must be accepted together. No paid
role grant, API/client privacy control, worker election or deployment follows from this source.
`KS_PLANNER_ENABLED=0` remains the worker default; enabling it never grants paid allowance.

## Accepted source and immutable business identity

`RequestPlanner(authority,{commandId,intent?,resumeRunId?,recordingGeneration?})` checks the
personal root and actual own-account UPDATE fence before receipt replay. An exact receipt can
acknowledge its original result while paused; it creates no new effects. A fresh accepted command
must pass its original generation. Supplied undefined is rejected and omission preserves the old
request hash. Omission is literal initial1 only, never server-current after a toggle. Refused fresh
commands retain only their fixed receipt, with no intent, desired source, context or job.

`PlannerMaterialChange(RecordingScopeTx,{sourceRevision,recordingGeneration})` requires a genuine
live capability, exact original generation, and actual root revision equal to both sourceRevision
and scope entry revision+1. The producer invokes this once inside its actual derived transaction.
Failure rolls source effects, state and the required pg-boss job back together. Descriptor or
activation alone is not a material source. API/worker composition must supply this real callback;
an empty successful adapter is not a replacement.

Desired state records its accepted generation and command/source revision. A run records its birth
account, generation and source exactly once. Queued preparation may coalesce a newer desired
revision only within that same generation. Resume never replaces the birth identity or frozen
context. Unknown accounting remains the same business ID and blocks a successor until its actual
payload-free financial disposition is conclusive. Toggling alone creates no desired source or job.
NULL old provenance is unknown. Literal1 adoption requires actual initial1/on authority and exact
owned rows; it never upgrades an old run after off/on.

## Queue, claims and necessary accounting

The existing `planner.run` queue/policy is unchanged: concurrency1,1200s expiry, three retries with
30s exponential delay, seven-day queued retention, two-day result retention and common dead-letter
retention. New v2 jobs bind original generation plus either exact ordinary wakeId or delayed
expectedClaimId. v1 is a literal1 compatibility path and cannot consume a newer v2 wake marker.
No context, hashes, text or provider output is present in jobs.

Ordinary wake metadata is an exact UUID on the run PK. Enqueue and marker change share one
transaction; there is no pg-boss JSON/history scan. Only the matching wake may capture a claim.
Every new1150s claim consumes its ordinary/previous delayed marker and atomically queues one
recovery wake for the NEW claim at expiry+1s. A delayed handler that crashes after renewing a claim
already has the new recovery job. An obsolete wake changes no current claim, marker or context.
An early matching delayed delivery raises a fixed retryable failure under the existing bounded
queue policy; it neither steals the live claim nor creates another wake. Explicit resume refuses
live claims/pending ordinary work and gives an eligible released run a fresh ordinary UUID.

Accounting reads run separately under a fresh root and the Reasoning owner's actual own-account
fence. They expose bounded exact disposition only, never output, issues, requests or private context.
Reserved/dispatched/unknown/unproved/overflow accounting stays blocked and is never resent or
reset. Necessary retirement of a revoked conclusively accounted old run may clear only that exact
active ID and its own scheduling metadata. Only an independently retained fresh current-generation
source can then create a successor. Financial settlement/late usage/write-off remains independent
of collection policy. No recording gate rewrites those outcomes or permits another paid attempt.

## Prepare, private replay and apply

Preparation orders root → actual own-account fence → original generation → exact run header/account/
active ID/wake/claim checks before any frozen body, intent, PC, catalogue or memory capture. The
header excludes frozen context. Full context and exact `{bundleRef,items}` receive separate
canonical SHA256s in the same write that first freezes context. Owner account/source and both
hashes remain immutable. JSONB key order cannot change model item bytes.

`CHECK_PLANNER_RECORDING_RUN` accepts only a genuine RecordingScopeTx and the strict Reasoning
personal purpose. It checks actual prepared status, active run, current unexpired claim, account,
universe/epoch/generation and both header hashes before loading the bounded body. It recomputes
both hashes from that body and the real deterministic item builder. Caller strings or copied,
expired capabilities cannot substitute for the owning adapter.

The required `RecordingReasoningHarness.proposePersonal` fences reservation, protected replay,
request reads and dispatch through the closed Planner/Geography owner dispatcher. No generic
personal harness fallback is used by the recording worker. Network I/O stays outside transactions.
The purpose binds owner/purpose, account/universe/epoch, business ID, original generation, claim and
both hashes. Claim is delivery ownership; accounting/business identity remains stable.

Apply enters only through `withPersonalApply`, which owns the sole root/account UPDATE/originalg
and actual owner/ledger proof transaction. The role does not nest another root or acquire the same
Identity account gate twice. It rechecks semantic authority and current PC/catalogue under that
capability, then calls `closePersonalRun` with the SAME facade-issued capability while its owner
header is still prepared/active/claimed. Accepted domain revision and owner status/active changes
follow in the same transaction. Any failure rolls ledger close and all domain effects back.
A paused/stale answer can be accounted but cannot become accepted memory or invoke material growth.

## Bounded prepared context and proof availability

The existing selection unions explicit intent, current plan, admitted inventory and recent topic
seeds under100 topics/assets/units; recency is not global top activity. Memory is at most three
accepted revisions, never a transcript. Up to20 qualified exact supporting contribution hashes
identify factual support. Plans, inventory tags, provisional observations and previous suggestions
never manufacture qualification or facet coverage. Source generations and exact audit identities
remain in the PC contribution hash; inherited committed PC support is distinct from pending raw
observations.

PC `proofAvailability` must be explicitly available at preparation and current semantic recheck.
Missing/unavailable/overflow proof blocks without reservation or accepted support; it is not zero
support. An unavailable prepared read cannot be repaired by treating empty arrays as complete.
Current Content authority and exact PC identities are rechecked before apply; root ownership keeps
personal evidence stable through Content waits. `completeness: not_asserted` remains explicit.

Prepared data retains the existing500000-byte frozen and180000-byte escaped item bounds,
64 items/32768 characters each. Oversize ends as insufficient without reservation. Role policy
`personal-planner.v0`/`planner1` keeps4096 output tokens, one primary and at most one separately
admitted repair. Deterministic authority/diversity/expiry checks retain at most three opportunities.
Missing supply remains an unadmitted proposal; no commissioning, provider output, usefulness or
learning claim is made. No provisional tail or raw private messages enter the model context.

`ReadPlannerOpportunities` can display already committed plans under current personal/Content
read authority, filtering expiry/Hide/stale facts. It does not wake a role or authorize content
opening. Stale or unavailable proof produces no currently supported opportunities.

## Storage, erasure and verification

Existing `planner.state`, `planner.runs` and `planner.revisions` remain the only stores. Schema43
adds provenance, paired immutable context hashes and exact wake metadata without historical
backfill, tables or indexes. All prior42 SQL bytes remain immutable. Erasure still removes
revisions → state → runs across every epoch and queued/retained/dead-letter IDs-only payloads.
Reasoning retains honest minimal accounting under its existing independent privacy erasure rules.
No file cache, embedding, alternate outbox or historical certification is added.

All automated suites run in hosted Actions. Authored fixture model replies are CI data, never
provider evidence. Local type/lint/format/build checks establish source consistency only. Full
positive recording Evidence→PC→Planner/Geography composition, populated Clear, finite legacy
certification, role grants and real journeys remain separate acceptance gates.
