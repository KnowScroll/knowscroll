# Scenes

Related: #238.

Deterministic persisted appearance for already established Geography. This prerequisite owns
backend projection, own-scope manifest/chunk reads and U05 durable delivery/claim ports. It installs no renderer,
HTTP controller, model call, historical bootstrap, placeholder world, formation rule or paid
permission. Authored CI inputs do not prove actual formation, dev rendering or device performance.
U05 shown/skipped acknowledgement records the actual client statement through the closed contract;
origin transition IDs identify provenance and never claim that an object was shown.

## Transaction and composition

Geography's required `GeographyApplied` binding records actual U05 creation delivery facts and enqueues one IDs/stamps-only `scenes.project`
job inside the actual apply transaction. Replay returns before the hook; enqueue failure rolls
back Geography, delta, root and both required jobs. `sceneAppliedProviders` depends only on
EnqueueJob. `sceneProviders` depends on Geography's public `ReadGeographySceneInput`, Identity
and its own adapters. This split keeps API/worker wiring acyclic. pg-boss is the only outbox.

The worker enters one current personal-root transaction, rechecks the owning account, reads
Geography through its public port and samples the current root watermark there. It projects
latest input regardless of delivery order. Duplicate/older deliveries are inert once those
Geography component stamps are represented. The stored scene `personalRevision` is that input
root watermark, before the projection's own root advancement; it is never PC or Scene revision.
Unrelated root changes do not reproject or imply pending work. Version writes/current pointer,
root advancement and disposable notification commit together. Exceptions retry atomically.
No network/provider work runs in the transaction.

## Stored appearance and finite policy

`canonical-lattice.v1` selects only explicit canonical catalogue IDs, and reads the family from the
content library plan (`content/domain/library/`, exposed as `sceneFamilyOf`): a system and its star
take the system's `sceneFamily`, a planet takes its own or its system's, and a region inherits its
planet's. Earth keeps what it always had: system, star and Seasons `terraced.v1`, Tides
`archipelago.v1`, Greenhouse `ridged.v1`. The three families are the ones `scene-core` draws
(`terraced.v1`, `ridged.v1`, `archipelago.v1`). This is a cosmetic convention, not scientific or
personal classification. A system or star must be a catalogue system, a planet must be a planet
of its parent system, and a region must be a facet of its parent planet. Unknown IDs and
unrepresentable/ambiguous labels fail closed rather than truncating labels or guessing from
text, evidence, activity or a hash. A stored object's family never changes (a different family for
an existing object refuses), so a plan edit sets families for new systems and planets only. Aliases stay in
Geography; each Scene target remains its own object ID, with no redirect/merge inference.

An adapter creates a private random 256-bit world seed once. Versioned policy + seed + opaque
object ID derive the persistent 32-hex object seed. Family, generator, palette/material,
atmosphere/detail, anchor, slot and chunk identity persist. A 32×32 lattice (300-unit spacing,
coordinates ±4650, four kind layers) provides 1024 finite slots for at most 1000 objects. New
objects choose the closest free slot to their parent, with a deterministic seed tie-break and
topological kind/ID allocation order. Existing slots never move. Sibling arrivals, label/activity
updates, restarts and full/low/reduced-motion capabilities never reroll existing appearance.

The immutable state policy identity is stored explicitly as `canonical-lattice.v1`.
Objects append to stable per-system buckets of 100. Route-to-chunk membership is also persisted
through arrivals and withdrawals; sorting a newly arrived route never rebalances older routes.
Separate per-system route buckets contain
at most 100 current routes; withdrawal removes a route from a later snapshot, retaining objects.
The whole hierarchy and route endpoints are checked before publication, including cross-chunk
parents/endpoints. Canonical parsers enforce depth/node/UTF-8/escape budgets, at most 100 objects
and 100 routes/chunk, 128 chunks/manifest and 262144 bytes/document. Geography global limits remain
1000 objects and 1000 relations; overflow atomically refuses publication without a partial map.
Only changed payload chunks create immutable versions. New manifests may retain older unchanged
chunk references with their original input stamps, as the shared wire explicitly permits.

## Projection stores and reads

| Store            | Purpose and access                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| scenes.state     | Current epoch pointer, pinned policy, private world seed, route allocation and latest failure stamp; one locked scope |
| scenes.objects   | Stable descriptor, system/chunk membership and finite slot; caller/epoch/object lookup                                |
| scenes.chunks    | Immutable chunk versions; exact caller/epoch/chunk/revision lookup                                                    |
| scenes.manifests | Immutable whole-manifest versions; caller/epoch/scene revision                                                        |

Migration 0027 is additive; all 26 prior SQL blobs remain unchanged. No seed, personal row or job
is inserted by migration. Versions retain history until personal erasure; schema growth is
bounded per snapshot, with retained versions growing with actual Geography effects.

Reads validate strict capabilities and current selection without enqueueing. Empty Geography
returns a computed zero-revision empty manifest with no persistent state. Nonempty Geography
without a snapshot is loading only while a real current-scope required job is created/retry/active.
A valid earlier snapshot plus an actual newer current job is lagging. Missing/failed/dead-letter
work is unavailable; a terminal projection limit is unavailable/limit. Unrelated root activity is
never pending. Unsupported capabilities return the canonical unsupported_version fallback.
Current ready/empty data must match Geography; stale snapshots are never relabelled current.

Chunk reads require the exact selected current manifest and immutable reference. Old manifest
references return stale_manifest, own unknown/nonselected chunks return unknown_chunk, and
mixed universe/epoch references refuse without echoing or rewriting them. An honestly lagging
current manifest may serve its exact older chunks. Reads expose neither world seeds nor private
Geography context. Account/session/HTTP admission belongs to a future adapter; these ports still
require current own personal authority.

## Erasure and verification

Scenes erases before Geography. All projection tables across every epoch/version, seeds and every
Scene pg-boss state/dead letter are removed using the existing registry/job eraser. No separate
cache exists. Root/epoch/owner fencing prevents late jobs from resurrecting reset/erased state.
Queue policy:180s expiry, three 10s backoff retries, local concurrency 1,7d queued/2d settled
retention plus the declared dead letter. No independent business role/attempt ledger is needed
for this bounded CPU projection.

Automated suites run only in GitHub Actions. Pure authored fixtures exercise deterministic
allocation/families, 1000-object bounds, hierarchy, parser caps and stability; PostgreSQL fixtures
exercise input minimization/root semantics, atomicity/replay, actual pending work, strict refs,
immutable versions, erasure and late/suspended authority. Source/fixture acceptance leaves
actual dev projection, renderer/navigation, actual U05 presentation and populated-device performance
unverified. Existing nonempty worlds require a separately authorized bounded maintenance enqueue;
reads and migrations never bootstrap them.

## Delivering a formation once (U05)

Status: implemented, CI-tested against real PostgreSQL. Related: #363.

`GeographyApplied` now records a minimized delivery fact from the actual new delta's creation
operations, then enqueues the original strict three-field projection identity, in that SAME root
transaction. It never spreads the creation facts into `ProjectSceneJobSchema`. The callback does
not infer formation from a label, activity, route, model proposal or historical world. A planet
sequence requires an actual `form_planet`; its new-system beats additionally require the matching
system AND star created in that same commit. More than eight targets retains an honest `limit`
marker instead of truncating or inventing a smaller story. No migration bootstraps old worlds.

The fifth personal store, `scenes.formation_presentations`, holds one immutable fact/limit marker
per actual creation transition. Its universe/epoch/delta foreign keys restrict deletion; Scenes
must erase it before Geography. The record contains no private supports, model context, seeds or
geometry. It grows with actual creation-bearing commits and retains immutable provenance until
full erasure or selective Clear. Both erasers remove every epoch and all exact expiry job states,
including dead letters. Saved entries/places, Social and public Content remain with their owners.

Migration 0038 also installs a deferred creation-delta/fact consistency guard: an older writer
which inserts a creation-bearing delta without the required delivery record fails its WHOLE
transaction at commit. Claim identity and terminal disposition become immutable once set. The
protocol requires a coordinated exact-schema release; rolling back to a writer without this
callback is unsupported and must stop incompatible processes before activation. All 0001–0037
SQL/registry entries remain immutable. Schema-only codegen is not deployed-schema acceptance.

The mounted read is pure: at most one exact/latest candidate, closed capabilities and current
root/account/epoch/Clear checks, no receipt, expiry cleanup or job. All fact targets must be in
actual chunks referenced by the current manifest, with exact canonical identity, origin, truth,
label and object revision. Missing/stale/currently unprojected targets return unavailable; an
ancestor, alias or previous manifest cannot supply readiness. Unrelated root changes do not
change Geography stamps. Freshness is the original commit plus 300 seconds, never the read time.

A deliberate claim serializes under the personal root across devices. Claim, immutable command
receipt, root advancement and REQUIRED pg-boss expiry delivery commit together; send failure
rolls all back. The original request body is the only retry after unknown acknowledgement.
Historical receipt replay is separate from current eligibility: it cannot renew the 30-second
claim, reissue an expired claim or start another local attempt. Ownership/epoch/Clear is checked
BEFORE receipt lookup. The disposable transactional root hint can arrive BEFORE the HTTP claim
response. Clients must validate exact current targets before starting, tolerate an own-hint
refresh retaining an already admitted snapshot, and still stop on actual changed readiness,
authority loss, expiry or background. A hint never grants animation authority.

Only a client reporting actual completed full 2400ms sequence or mounted reduced-motion final
still/caption may acknowledge `shown`; interruption uses `skipped`. The server cannot prove the
client rendered it. An expired claim terminalizes as skipped; a delayed shown never overwrites
that actual terminal disposition. ACK retries retain the original terminal receipt. Neither ACK
is consumption, learning, evidence qualification or Geography formation authority.

Normal worker consumers mount `scenes.expire-formation` and `scenes.recover-formation`. Expiry
is 120s/three 10s-backoff retries; recovery is 180s/three 15s-backoff retries, both local concurrency 1
and 7d queued/2d settled retention plus declared dead letters. The normal five-minute UTC recovery
schedule selects due nonterminal claims, so exhausted delivery, process crash and root-lock failure
remain recoverable. No HTTP read-triggered repair, second outbox or volatile timer is involved.

Recovery uses a generated immutable bigint ordinal. A scheduled `{v:1}` captures a finite ceiling;
strict internal `{v:1,afterKey,throughKey}` reads 101/processes 100 and commits at most ONE advancing
fixed-queue continuation BEFORE any personal root work. Identical live child cursors dedupe under
a bounded advisory lock using pg-boss's real expiry/heartbeat semantics. Last pages create no
child; overlapping cron passes may revisit a row and do not guarantee one unique global pass.
Each delivery has 250ms root locks, 2s statements and a 30s per-operation-work budget. Busy or
unprocessed rows remain due for the next cron; durable children prevent 100 busy heads from
starving an unrelated tail. Every effect re-enters the exact current owner/epoch/root and claim.

The recovery queue is explicitly inventoried as global maintenance metadata: only bounded decimal
ordinal watermarks and version, no universe/transition/claim UUID, label, nonce or fact. It is
preserved by selective Clear. Erasing the personal row removes every link from its ordinal to
personal IDs; a retained cursor can neither recreate it nor erase fresh post-Clear data. The exact
private expiry queue is erased. Full erasure likewise leaves only non-identifying global cursors.

Actions-only authored fixtures cover actual transaction rollback/strict projection payload,
old-writer commit refusal, all-target readiness, concurrent devices, unknown retries, late ACK,
real final pg-boss failure/dead letter/root lock, restart, 100 blocked heads and durable child
rollback/dedupe/ceiling/final-page bounds, full/Clear inventories and normal installed API/worker
journey with private canaries. These are source/CI fixtures; actual deployed schema 38, formation,
client/native presentation and operational readiness require independent acceptance.

### Recording origin at a new Geography application

Status: implemented in source and CI; not exercised on a running system. Related: #381.

The actual new Geography→Scenes hook requires a genuine live `RecordingScopeTx` and an exact
matching original generation. It records only the just-applied committed creations and enqueues
the existing minimized projection job in that same transaction. The original-generation field is
not spread into the projection/display protocol. Already committed projection, publication,
U05 claim/ACK/expiry and recovery keep their existing current-owner/epoch display semantics while
recording is paused; none can mint new Geography meaning, activity or formation. New stale/off
role output cannot reach this growth hook. Source-only; no runtime or complete Pause acceptance.
