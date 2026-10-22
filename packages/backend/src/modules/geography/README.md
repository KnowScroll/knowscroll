# Geography / Cartographer (#237)

Backend meaning only: established systems, organising stars, coherent subtopic planets, specific
facet regions, routes, retained aliases and immutable public deltas. Scene descriptors, generators,
layouts, map navigation, visitor sharing, UI and HTTP routes are separate work. The authored
U01–U08 designs are examples; none is seeded into this module. #237 remains open until actual
reading forms an actual planet on dev with an inspectable authority chain.

## Authority and experimental policy

`geography-passive.v1` is an explicit initial experiment: a system and organising star need two
DISTINCT qualified explanation units under one admitted broad parent; a planet needs three units
and two genuinely covered canonical facets of the SAME admitted subtopic. Regions require their
own specific facet support and a formed planet. The current catalogue's Earth parent and its
Seasons/Tides/Greenhouse subtopics supply meaning, not personal evidence. Three unrelated topics
cannot form one planet; multiple witnesses/facets/variants of one unit do not add conceptual units.
No Like, quiz, return, inventory tag, generation, other person, provisional tail, raw reference
count or legacy global coveredFacets field supplies formation authority.

PC's `ReadCoverageInputs` discovers <=100 indexed candidate topic/facet/unit keys and current PC
revision, with deterministic deduplication and an overflow sentinel. Candidate keys prove nothing.
Preparation and application EACH call `ReadTrustedCoverage` under their own current personal root.
Apply keeps that same scope, current Evidence rechecks and sorted Content SHARE locks through
commit, and compares the full current authority digest to the frozen one. Map correction/retraction
or Content withdrawal rejects a stale proposal even without a new observation or PC revision.
Unavailable, overflow, unsupported truth or stale authority fail closed. `not_asserted` completeness
stays explicit: positive supported units/facets are lower bounds; no complete negative history is
claimed. Content's semantic approval list remains EMPTY; no live mapping or fixture approval is added.

The factual-only initial applier checks ACTUAL current certificate fields: observed availability,
`mapping.framing === factual`, exact catalogue/version/meaning, canonical unit and matching factual
framing digest. A hash alone is never interpreted as factual. The present Content certificate policy
supports static factual Scroll leaves only. New hypothetical operations explicitly refuse; existing
hypothetical identity is preserved on reads and cannot alias into factual meaning. Real hypothetical
formation needs a future trusted certificate policy, not a relabelled factual hash.

## Proposals and atomic application

The role proposes backend-local `cartographer-proposal.v1` operations, <=32 /60KiB. Code owns
candidate semantic identities, UUIDs, admitted parents and neutral allowed labels. The proposal can
only copy these, cite exact current positive support refs and use the eight typed operations:
create_system, establish_star, form_planet, add_region, connect_route, revise_label, set_activity,
withdraw_relation. It cannot submit a JSON patch, merge, split or alias creation. Those need a typed
public delta extension before any incremental alias update; stored aliases are validated reads only.

The pure validator simulates the ENTIRE ordered proposal before writes. It checks canonical
membership, distinct support, parent/truth/hierarchy, identity uniqueness and duplicate effects.
Routes connect two formed subtopic planets of one system with positive support at both ends.
An explicit organisation-correction withdrawal retains the relation ID/endpoints/origin and needs
current positive support at both endpoints; missing history or inactivity is never its authority.
Label updates preserve ID/concept/parent/origin and copy a neutral admitted label, not a mastery or
belief claim. Initial active/quiet policy ages the latest positively verified support at30days;
this is a coarse lower-bound activity estimate, not a complete absence claim. Quiet never removes,
merges, shrinks or re-identifies an established place. Source correction fences new growth; this
wire has no object-deletion operation and existing structure remains retained meaning/history.

Application rechecks current owner account status, universe/epoch, desired/PC/geography revisions,
current trusted evidence/content and the full proposal, then writes all object/relation effects,
immutable delta/transition receipt, updated component stamps, personal revision and required
`geography.publish-delta` pg-boss work in ONE transaction. Failure rolls all effects and harness
closure back; the same stable run/kept answer can recover without another paid invocation.
The transition ID and all candidate UUID slots are frozen once. Identical committed replay returns
the original delta; another proposal under that transition conflicts. Database guards reject delta
updates and changes to object/relation identity, parent, concept, origin or truth. Full erasure may
remove these personal records. Label/activity updates never manufacture a second formation.

`revision` advances each geography commit. `structureRevision` is the latest commit that changed
anything except activity; `activityRevision` is the latest activity-changing commit. These stamps
are distinct from PC revision, personal catch-up watermark and any future scene revision.

## Coalescing, role and spending

Composition fans the existing Evidence/PC material callback to Planner and Geography in the SAME
source transaction, preserving both required jobs and rollback. Unchanged Evidence/PC replay emits
no new callback. One desired/material revision and active business ID coalesce ordinary changes.
`RequestCartography` is a backend-only idempotent explicit request/same-ID resume, never a read side
effect. Busy/unknown/blocked work stays at the same active ID. Only explicit resume releases blocked
or expired prepared claims; conclusively stale work gets one successor if a newer desired revision
exists. A1150s claim token and claim-fenced delayed pg-boss wake recover crashed handlers without
abandoning ledger identity. Unknown outcomes never blindly resend, even after explicit resume or
new observations. The shared harness retains caps, quota, repair boundary and failure brakes.

Worker feature flag `KS_CARTOGRAPHER_ENABLED` accepts0/1 and defaults0. Economic permission is a
SEPARATE typed `permitted(scope)` callback, default false in normal composition. Neither credentials,
the feature flag, source merge nor deployment grants spending. A true flag without a permit closes
the delivery as blocked/budget_unavailable BEFORE reservation/call; disabled work records disabled.
No Cartographer/Planner/Supply grant or #232 allowance is created/consumed/transferred/reset.
A future separately reviewed bounded operator can inject its permit through `cartographerWorkerProviders`
without changing the engine. This module introduces no economic ledger or operator bypass.

The role is `geography.cartographer` / `cartographer1`, max8192 output tokens, one primary and at
most one separately admitted repair. Prepared model data is <=64 items /32768 chars each /180KiB
escaped framing; the stored frozen context is <=500KiB. It contains only own current geography,
canonical candidate meanings/labels and minimized positive support refs/units/facets, with
not_asserted completeness. Full private certificate proof stays in the erasable frozen row and is
NOT passed as model context. Context JSON is canonicalized across JSONB replay. Provider calls occur
only through the worker harness BETWEEN short transactions, never in HTTP/DB transactions.
Owning account status is checked before/after authority waits through Identity's scoped port;
universe/epoch fencing remains with withPersonalScope. Session/device sign-out does not impersonate
an account actor or erase an already accepted business request.

## Public reads and durable hints

`ReadOwnGeography` and `ReadOwnDeltas` implement the merged #293 declarations, without adding routes.
Reads are readonly and never enqueue or invoke a model. Scope/epoch/current owner status is checked.
An empty selection means no established places in that selection, not no reading or meaning.
Loading/lagging require a real queued/prepared business run; blocked work never invents progress.
Selection membership, hierarchy, relation endpoints, alias cycles/truth separation and stable UUID
order are validated. Cursors must bind current universe, epoch, exact geography revision, selection
and an existing selected last object; an expired/mixed cursor refuses as snapshot_expired.
Pages allow<=100 objects and ALL relevant<=100 routes/aliases (including cross-page endpoints).
Relationship overflow returns limit, never truncated completeness. A whole view has an explicit
1000-object/1000-relation backend limit. Contiguous catch-up returns<=10 deltas, preserved transition
IDs and exact component bases; gaps/future cursors require a fresh snapshot.

`publish-delta` is a required IDs-only delivery of a hint for ALREADY committed geography, with an
idempotent published-revision checkpoint. It emits only the existing disposable scope notice.
It is not a scene manifest, cross-person fanout, second outbox or claim that rendering completed.
Durable delta reads recover missed notices. Scene projection remains separate.

## Stores, queues, erasure and evidence

| Store (`0025`) | Query / bound / retained purpose |
|---|---|
| geography.state | One caller/epoch row: independent component revisions, desired/material revision, active run and hint checkpoint |
| geography.runs | Stable business/claim ID; <=512KiB frozen private context and <=64KiB validated proposal/decision/attempt ref, retained audit |
| geography.objects | Stable semantic key + UUID page indexes, bounded private semantic payload + positive support refs, retained structure |
| geography.relations | Stable route/alias identity and endpoints, retained withdrawn rows; no alias creation capability |
| geography.deltas | Immutable caller/epoch/revision and unique transition, public effects + private input hash/run/policy receipt; <=128KiB |

Lock order: personal root → owned Geography/PC/Evidence rows → sorted Content asset/head SHARE
locks → own harness closure/effects; never another person's root. No shared root acquires a personal
root. Full erasure deletes deltas/relations/objects/state/runs across ALL epochs and both queues'
queued/active/settled/dead-letter payloads; shared reasoning erasure handles protected requests and
personal attempt links. All24 earlier SQL files remain immutable. Migration0025 is additive.

`geography.cartograph`:1200s expiry, three30s backoff retries, local concurrency1,7d queued/2d settled
retention plus declared dead letter. `geography.publish-delta`:180s expiry, three10s backoff retries,
local concurrency1, same retention. Payloads contain version/scope/epoch/run-or-transition IDs only.
pg-boss is the only work outbox; claims and deltas are domain records, not another transport queue.

Automated suites run ONLY in Actions. Pure/property cases and actual PostgreSQL fixtures prove
coherent thresholds, canonical-unit deduplication, observed ALL-OF coverage, atomic rollback/replay,
source-withdrawal fences, late reset/unknown/account suspension, paging/catch-up, quiet persistence
and erasure. Sources/maps/model proposals are clearly authored CI fixtures; none is runtime evidence.
Local build/lint/type/schema generation are static checks only. Remaining acceptance: approved real
semantic maps, explicitly granted role execution, actual reading→planet on dev, shared route/HTTP/UI
consumer, scene projection/rendering, own map navigation and separately authorised sharing/visits.

## Scene projection boundary (#238)

`ReadGeographySceneInput` accepts an existing `PersonalScopeTx`, rechecks owner authority,
validates the whole bounded retained hierarchy and returns canonical meaning IDs, public
objects/routes/aliases and the **current personal root** watermark in that transaction.
It omits private supports, evidence, role context and scores. Scene code uses this port only.
Actual new application invokes required `GeographyApplied` after effects/state/root/delta and
publication enqueue, in the same transaction. Hook failure rolls everything back; transition
replay returns before it. API/worker supply an enqueue-only Scene binding with no projector
or Geography read dependency. No historical bootstrap or read-triggered Scene job is added.

### Region navigation authority (U04)

`READ_OWN_REGION_CONSTRAINT` reads the current live personal root, then exactly the requested indexed Region, its Planet and System. It verifies the displayed object/geography revisions, factual canonical catalogue lineage and stable semantic identities. Aliases, hypothetical branches, malformed snapshots and stale/foreign IDs never redirect to another Region. This read writes no cartography work, formation, activity or root revision. A formation snapshot remains a historical fact; an expired role claim is never authority for navigation.

### U05 creation delivery boundary (#363)

The actual applier passes only newly committed creation operations (system/star/planet/region)
with the immutable delta time and component stamps to `GeographyApplied` in the same transaction.
Scenes owns delivery/claim/expiry, not formation decisions. Label/activity/route-only transitions
supply no creation candidate. The strict original projection job picks its existing fields and
never receives this extra fact body. Migration0038's deferred consistency guard fails an older
creation writer atomically if it omits the required Scenes fact; exact-schema coordinated
activation is required, with no rolling downgrade or historical bootstrap. Existing qualified
coverage, deterministic validation, root/epoch/account fences and default-disabled paid role
permissions are unchanged. No authored fixture is a real formation or semantic approval.

## Original-generation personal role prerequisite (#381)

New desired sources and run birth origins retain the actual accepted account, generation and
command/material source. Necessary request receipts preserve the original optional field; an
omitted old request can collect only at actual initial1/on. Off/stale/missing-after-toggle requests
create a fixed refusal receipt without retaining a future intent. Same-generation queued work may
coalesce before context freeze; a resumed current generation never retags an old run/context.

Run headers and minimal accounting headers are separate from private context. Preparation uses
root → actual Identity own-account UPDATE/fresh authority → original-generation capability before
context capture. The actual `CHECK_GEOGRAPHY_RECORDING_RUN` owner checks exact root/account/run,
active prepared unexpired claim and both hashes before reading the context body. It recomputes
canonical full frozen context and exact `{bundleRef,items}` model-context hashes. The shared
Reasoning token is reused; no dummy Planner/Geography counterpart or optional proof exists.

Each ordinary v2 delivery owns a fresh UUID stored on that exact run. Only the matching wake
consumes it. Delayed recovery names the exact current claim, and every new claim atomically stores
and enqueues its own recovery. Early matching delayed delivery throws the fixed bounded-retry
error without clearing markers; old deliveries cannot steal later wakes. Queue names/policies
stay unchanged, schemas remain objects for erasure inventory, and no pg-boss history scan remains.

Private proposed output/apply enters only `RecordingReasoningHarness.withPersonalApply`; there
is no outer/nested root or second own-account UPDATE. Current composite PC witnesses, full source
facts and pure geometry validation precede ledger closure while the owner header is still prepared;
closure and all semantic Geography/delta/root/required Scene effects share that same transaction.
Scene hooks require the genuine original-generation capability. Already committed hierarchy,
delta hints, Scene projections and U05 delivery remain display catch-up while paused and do not
create new meaning or formation. Reads do not wake work or label revoked old work as loading.

Revoked work uses only the actual Reasoning accounting callback, whose own-account gate precedes
minimal owner-header access. Unknown/unproved liability remains blocked at its original business
identity. Conclusive or verified parent absence proves at most zero retained attempts, never zero
historical cost. Only exact revoked metadata may retire; a successor additionally needs an
independently accepted currently eligible desired source. Toggle/read/resume alone is no source.

This remains source-only and default-disabled. Positive actual Evidence/PC/Role/Clear fixture
composition, all current source/PR Actions, API/worker/client activation and finite legacy
certification remain separate. Old fixture assertions are retained; missing owner composition
must be reported rather than replaced with successful empty effects or fake certificates.

A fresh current-generation desired source may enqueue one explicit header-only `v:2,kind:retire` wake for a revoked active run. The payload retains that run's original nullable generation and its exact normal-wake UUID; no body, claim, or model work occurs. The actual Reasoning accounting facade acquires the own-account UPDATE before the minimal header callback. Unresolved/unproved accounting consumes only that delivered UUID by SQL comparison, leaves the business run/claims/ledger intact, and schedules no retry; a later explicit fresh producer can request another check. Conclusive or proved zero-retained disposition may retire exact revoked metadata, then separately fence retained desired provenance before creating a successor. Zero retained is not zero historical cost.

Normal and retirement marker UUIDs are the actual required pg-boss job IDs. A fresh current desired producer or explicit current-business resume can perform one `(name,id)` primary-key probe, selecting only queue state and a SQL-closed exact-payload comparison boolean. Created/retry/active, mismatched, and unsupported rows block replacement. Exact missing or completed/cancelled/failed rows permit SQL-CAS replacement only with no live Role claim; old late deliveries cannot consume the new UUID. No queue-history scan, automatic drain, background resend, new business identity, or accounting-limit reset is involved. Delayed claim recovery remains separately bound to its exact claim ID. Hosted fixtures remain unexecuted source until Actions.

The exact-PK probe has one bounded compatibility exception: a genuine actual initial1/on capability and an all-NULL legacy origin/hash header may match an ordinary literal1 payload issued by explicit initial1 resume. The probe does not adopt/stamp the old header or its private context; claim/adoption and the Reasoning ledger remain separately gated. A toggle revokes this exception. Retirement always retains NULL original generation for such a row; present NULL/partial Reasoning proof remains unavailable rather than being adopted. Partial stored origin or claim pairs refuse.

Necessary cleanup recognizes an exact delivered ordinary literal1 UUID on an all-seven-fields-NULL legacy header after a toggle without adopting its birth. The minimal accounting callback reads only the stored pending UUID and a boolean NULL-shape proof in addition to ID/status/account/generation; it binds original NULL to the actual current-own snapshot. A stale UUID gets no alias exception. The same literal1 match can identify a terminal/missing old marker for retirement-mode metadata replacement; live rows stay busy. Present NULL ledger proof stays unproved, and zero retained remains distinct from historical cost.


Retirement delivery ownership is strict even when accounting is conclusive or proves an absent
retained parent. A delivered normal/retirement UUID must equal the currently stored normal UUID.
Delayed or in-flight cleanup must retain the exact current claim ID and claim-wake ID, with no
competing normal marker. Stale A cannot retire C, clear pending B or create a successor; old v1
ordinary deliveries cannot consume any v2 marker. The minimal accounting header includes only
ID/status/account/generation, pending/claim IDs, claim expiry and the all-seven-fields-NULL boolean.
Retirement producers never read context or hash bytes. Exact queue JSON comparison remains in SQL.
Fresh same-generation desired sources may recover terminal/missing normal wakes only on queued or
prepared runs with no live claim (paired expired claims release atomically); unknown/blocked outcomes still require explicit current-business resume.

An actual `provider_unavailable` refusal occurs before Reasoning admission. Its metadata-only
finalizer uses actual accounting's sole own-account fence and zero-retained proof, current original
generation, current active prepared run and exact unexpired captured claim. It releases only that
claim to blocked/provider_unavailable, without semantic apply, close, successor, credit, revision or
new job. Present/unproved accounting refuses this cleanup; unknown liability is never inferred absent.
