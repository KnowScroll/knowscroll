# Scenes (#238)

Deterministic persisted appearance for already established Geography. This prerequisite owns
backend projection and readonly own-scope manifest/chunk ports. It installs no renderer,
HTTP controller, model call, historical bootstrap, placeholder world, formation rule or paid
permission. Authored CI inputs do not prove actual formation, dev rendering or device performance.
U05 durable shown/skipped acknowledgement remains a separate future contract; origin transition
IDs identify provenance and never claim that an object was shown.

## Transaction and composition

Geography's required `GeographyApplied` binding enqueues one IDs/stamps-only `scenes.project`
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

`canonical-lattice.v1` selects only explicit canonical catalogue IDs: Earth system/star and
Seasons use `terraced.v1`, Tides uses `archipelago.v1`, Greenhouse uses `ridged.v1`; canonical
regions inherit the admitted parent family. This is a cosmetic convention, not scientific or
personal classification. Unknown IDs and unrepresentable/ambiguous labels fail closed rather
than truncating labels or guessing from text, evidence, activity or a hash. Aliases stay in
Geography; each Scene target remains its own object ID, with no redirect/merge inference.

An adapter creates a private random 256-bit world seed once. Versioned policy + seed + opaque
object ID derive the persistent 32-hex object seed. Family, generator, palette/material,
atmosphere/detail, anchor, slot and chunk identity persist. A 32×32 lattice (300-unit spacing,
coordinates ±4650, four kind layers) provides 1024 finite slots for at most1000 objects. New
objects choose the closest free slot to their parent, with a deterministic seed tie-break and
topological kind/ID allocation order. Existing slots never move. Sibling arrivals, label/activity
updates, restarts and full/low/reduced-motion capabilities never reroll existing appearance.

The immutable state policy identity is stored explicitly as `canonical-lattice.v1`.
Objects append to stable per-system buckets of100. Route-to-chunk membership is also persisted
through arrivals and withdrawals; sorting a newly arrived route never rebalances older routes.
Separate per-system route buckets contain
at most100 current routes; withdrawal removes a route from a later snapshot, retaining objects.
The whole hierarchy and route endpoints are checked before publication, including cross-chunk
parents/endpoints. Canonical parsers enforce depth/node/UTF-8/escape budgets, at most100 objects
and100 routes/chunk,128 chunks/manifest and262144 bytes/document. Geography global limits remain
1000 objects and1000 relations; overflow atomically refuses publication without a partial map.
Only changed payload chunks create immutable versions. New manifests may retain older unchanged
chunk references with their original input stamps, as the shared wire explicitly permits.

## Four personal stores and reads

| Store | Purpose and access |
|---|---|
| scenes.state | Current epoch pointer, pinned policy, private world seed, route allocation and latest failure stamp; one locked scope |
| scenes.objects | Stable descriptor, system/chunk membership and finite slot; caller/epoch/object lookup |
| scenes.chunks | Immutable chunk versions; exact caller/epoch/chunk/revision lookup |
| scenes.manifests | Immutable whole-manifest versions; caller/epoch/scene revision |

Migration0027 is additive; all26 prior SQL blobs remain unchanged. No seed, personal row or job
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

Scenes erases before Geography. All four tables across every epoch/version, seeds and every
Scene pg-boss state/dead letter are removed using the existing registry/job eraser. No separate
cache exists. Root/epoch/owner fencing prevents late jobs from resurrecting reset/erased state.
Queue policy:180s expiry, three10s backoff retries, local concurrency1,7d queued/2d settled
retention plus the declared dead letter. No independent business role/attempt ledger is needed
for this bounded CPU projection.

Automated suites run only in GitHub Actions. Pure authored fixtures exercise deterministic
allocation/families,1000-object bounds, hierarchy, parser caps and stability; PostgreSQL fixtures
exercise input minimization/root semantics, atomicity/replay, actual pending work, strict refs,
immutable versions, erasure and late/suspended authority. Source/fixture acceptance leaves
actual dev projection, renderer/navigation, U05 acknowledgement and populated-device performance
unverified. Existing nonempty worlds require a separately authorized bounded maintenance enqueue;
reads and migrations never bootstrap them.
