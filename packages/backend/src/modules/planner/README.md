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


A fresh non-resume command or material trigger may find a revoked active head whose ordinary wake
was already consumed while disabled or blocked. It records the independent current-generation desired
source and atomically queues one `v:2,kind:'retire'` delivery on the same queue, with the old exact
nullable original generation and a fresh UUID in `normal_wake_id`. This is a metadata-only accounting
wake. It cannot collect, read frozen intent/context, claim, propose or apply the old business. A current-
generation explicit resume of an OLD run ID still refuses `run_not_resumable`; it cannot create a new
desired source or adopt that run. Toggle alone creates no source or job.

The retirement consumer enters only the accounting facade's current root/own gate and exact minimal
owner callback. Unknown, unresolved or unproved accounting keeps the old business active and consumes
only the exactly delivered ordinary/retirement UUID by SQL CAS. Stale A cannot clear pending B; there
is no automatic poll/retry-created wake. Conclusive or distinctly proved zero-RETAINED-attempt absence
may retire the exact old head, then independently fence the retained fresh desired generation to create
one new business/ordinary UUID. Receipt/history/caps remain unchanged. Legacy NULL cleanup uses only the actual current own snapshot supplied by the Reasoning facade
AFTER its own gate, to prove present-row ownership on a distinctly absent ledger. It keeps original
generation NULL; a present NULL/partial ledger remains unavailable. No historical account/generation
is inferred from that snapshot, and Planner copies no Identity SQL.


Every newly written ordinary/retirement `normal_wake_id` is the actual pg-boss job UUID: enqueue
supplies `jobId:wakeId`. Under an independently eligible fresh source or same-business explicit
resume, `prepareNormalWake` checks only the exact `(name='planner.run',id=marker)` primary key.
It returns state plus exact JSONB equality to a closed IDs-only expected ordinary/retirement payload;
no raw job payload or unguarded numeric/UUID cast is selected. Created/retry/active is busy. Only
completed/cancelled/failed or exact absence permits CAS clearing that old marker, with no live Role
claim. Unknown state, mismatched payload, stale UUID or foreign account refuses. Replacement keeps
the same business/original generation/ledger; it cannot bypass unknown or reopen a terminal business.
Blocked/unknown still requires an explicit same-generation resume; queued/prepared without a claim
may recover a lost normal delivery from a fresh source. Expired claims retain their separate exact
claim-recovery/release protocol. No scan, background poll, paid retry or old non-ID-marker adoption
is installed. Schema43 and this complete source preview remain unreleased prerequisites.


The sole legacy queue alias is an ALL-NULL seven-field origin/hash header and an exact matching
stored normal UUID. An actual initial1/on explicit resume emits ordinary v2 literal generation1
with that actual job ID, preserving the NULL header until first real claim; the probe adopts nothing.
After a toggle, that same literal1 delivery may enter necessary accounting cleanup with expected
ORIGINAL NULL and the actual current-own snapshot. A terminal/missing probe can replace the old
metadata with an explicit NULL-generation retirement wake; a live old delivery stays busy. Present
NULL/partial ledger proof remains unavailable; distinct absence proves zero RETAINED attempts only.
Only a separately retained fresh source can authorize a successor. Stale UUIDs, partial headers,
ordinary post-toggle collection or generation1 stamping remain refused.


Necessary pre-admission completion is separate from semantic apply. For available-but-empty
context, or the real engine's `provider_unavailable` refusal before admission, a fresh root enters
the accounting port's actual own-account gate once. Its fixed callback fences original generation
before reading only the exact prepared owner header, active ID, unexpired current claim/recovery
marker and frozen hash identity. Only the accounting port's actual absent-parent result permits
terminal metadata: empty becomes insufficient and clears that exact active ID; provider unavailable
becomes blocked on the same business. It creates no successor, semantic effect, ledger row, attempt,
close or monetary-zero receipt. Present, partial or unresolved ledger proof cannot use this path.
Actual admitted quota/unknown decisions still require the genuine semantic apply facade.

Retirement delivery ownership is strict even for conclusive accounting. Old v1 refuses every stored
normal UUID. Ordinary/retirement delivery must own its exact current UUID; a delayed delivery must
match BOTH current claim ID and recovery marker with no competing normal marker. Stale A cannot
retire, clear or create a successor for B/C. Minimal accounting headers carry these IDs only;
private context and hash bytes are not added to revoked cleanup. The hosted regressions preserve
zero-retained absence separately from historical cost and preserve every unknown-liability fence.


### Header-only persistence and hosted hash-shape diagnosis

Existing run writes first update the exact `(universe_id, privacy_epoch, id)` row under the
already-held personal root. Omitted context/version and paired hashes preserve their frozen SQL
values without loading private bodies into metadata-only paths. Only actual absence proceeds to
a fresh queued origin-only insert; an absent metadata header refuses with a fixed error and a
cross-epoch PK conflict refuses rather than updating another epoch. A supplied changed
origin/body/hash still reaches the existing immutable trigger and complete row CHECKs.

The first full recording hosted Actions exposed a production persistence defect: a header-only
claim-recovery write supplied retained hashes but no body to `INSERT ... ON CONFLICT`. PostgreSQL
checks that proposed insert before conflict resolution, so it rejected null context with nonnull
hashes before the intended update could preserve the frozen body. The same adapter served terminal
metadata and resume. Direct existing-row update fixes that ordering; the schema/hash guards, original
claim/wake protocol, admission/financial caps and all crash/rollback assertions remain unchanged.
New hosted fixture source retains the genuine crash point, checks body/hash preservation for a real
frozen header and necessary empty/provider-unavailable completion, and verifies changed frozen
body/hash and hashes-without-context still refuse atomically. No local behavioral execution or
hosted-green/runtime acceptance is inferred from static checks.
