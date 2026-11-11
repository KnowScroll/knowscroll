# Scenes

Scenes gives established Geography a stable appearance. When Geography commits a change it
records formation delivery facts and queues scene projection in the same transaction. The worker
projects the latest Geography under the person's current scope; the API serves the sky, per-system
manifests, chunks and formation claims to the client. The renderer belongs to the app and
`scene-core`. A map is read as its **sky** (every system, one compact entry each) and then one system
at a time, so a person with thousands of formed places loads only what they look at (D-417, [A map
at scale](#a-map-at-scale-d-417)).

Start with [public.ts](public.ts), [the projector](application/project.ts) and
[formation delivery](application/formation-presentation.ts). A repeated projection with matching
Geography stamps changes nothing. A shown/skipped acknowledgement records what the client reports;
it never creates evidence or decides that a planet should form.

Run `pnpm --filter @knowscroll/backend exec vitest run src/modules/scenes` from the root.
The [integration suite](../../../../../tests/integration/README.md) covers persistence, formation
claims and recovery. Fixture inputs do not prove live formation or device rendering performance.

## Transaction and composition

Geography's required `GeographyApplied` binding records actual U05 creation delivery facts and enqueues one IDs/stamps-only `scenes.project`
job inside the actual apply transaction. Replay returns before the hook; enqueue failure rolls
back Geography, delta, root and both required jobs. `sceneAppliedProviders` depends only on
EnqueueJob. `sceneProviders` depends on Geography's public `ReadGeographySceneInput`, Identity
and its own adapters. This split keeps API/worker wiring acyclic. pg-boss is the only outbox.

The worker enters one current personal-root transaction, rechecks the owning account and reads
Geography's head (the revisions and the root watermark) through its public port. It projects
latest input regardless of delivery order, and only what changed: Geography names the systems that hold
a place or route stamped after the last projection, and each is read and written alone. Duplicate/older
deliveries are inert once those Geography component stamps are represented. The stored scene
`personalRevision` is that input root watermark, before the projection's own root advancement; it is never
PC or Scene revision. Unrelated root changes do not reproject or imply pending work. Object, chunk and
sky writes, the state's projected stamps, root advancement and disposable notification commit together.
A refused step rolls back to a savepoint, so a refusal keeps only a failure stamp. Exceptions retry
atomically. No network/provider work runs in the transaction.

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

Object and route IDs are Geography's and are opaque here: a new place's ID is derived from the universe's place secret and its
semantic key and a new route's from the sorted pair of its planets' keys (Geography README, D-416), and a stored place keeps the ID it
has, so projection never depends on how an ID was made. Only the stable ID and the places Geography reads for it matter here; an
incremental Cartographer run changes nothing about what Scenes reads or draws, and the 1000-object and 1000-relation bound stays
until the map reads by chunk (a later slice).

An adapter creates a private random 256-bit world seed once. Versioned policy + seed + opaque
object ID derive the persistent 32-hex object seed. Family, generator, palette/material,
atmosphere/detail, anchor, layout, slot and chunk identity persist. Existing objects never move, whatever
arrives, and label/activity updates, restarts and full/low/reduced-motion capabilities never reroll existing
appearance. The identity derivations (an object's seed, a chunk's id) hash under the name
`canonical-lattice.v1` for ever, so a world's chunks and seeds keep their identity when its layout changes.

**Layout** is per object (`scenes.objects.layout`). Every object that existed before D-417 is
`canonical-lattice.v1`: one of 1024 slots of a 32x32 lattice (300-unit spacing, coordinates +-4650, four
kind layers), each unique among v1 objects. Every new object is `canonical-lattice.v2`
(`domain/layout.ts`, pure), whatever the world began on:

| Object | Where it goes | Stored |
| ------ | ------------- | ------ |
| System | The next free cell of a coarse grid (900 anchor units, three fine cells, so a system's orbits fit), on a square spiral from the origin; layer 0. Cells inside the square the v1 objects occupy are skipped | cell in `scenes.systems.cell`, `slot` null |
| Star | The system's anchor; layer 1 (a v1 system keeps its v1 star) | `slot` null |
| Planet | Around its star: the smallest system-local ordinal that no planet of the system has and whose lattice point no older planet already holds, as an offset of the k-th nearest lattice point; layer 2 | ordinal in `slot` |
| Region | Its planet's anchor; layer 3 (a region's site is its look, which depends on its facet only) | `slot` null |

The client reads orbit band and start angle from a planet's anchor as it always did, so the first four
planets of a system sit on the innermost orbit, the next four on the second, and so on outward. Anchors
may reach `SCENE_LIMITS.anchor` (100,000 per axis); a client that predates the sky parses 10,000 and is
not served a map past it (below). The state keeps `layout.legacyReach` (the widest anchor of the world's v1
objects, 0 for a world with none) and `layout.nextCell`.

New worlds are pinned to policy `canonical-lattice.v2`; a world that began on v1 keeps its pinned
`canonical-lattice.v1` (the state guard refuses a change) and its new objects are v2 all the same.
Objects append to stable per-system buckets of 100 (`objects:N`), and routes to per-system route buckets of
at most 100 (`routes:N`): a route keeps the chunk it arrived in, a withdrawn route leaves it (an emptied route
chunk becomes an empty version that no manifest names), and a new route takes the first route bucket with
room, so an older route never moves chunk. Hierarchy, route endpoints and kinds are checked per system before
publication. Canonical parsers enforce depth/node/UTF-8/escape budgets, at most 100 objects and 100
routes/chunk, 128 chunks per system and 262144 bytes/document. A system is the unit of
publication: only a chunk whose content changed gets a new immutable version, and a refused system leaves
nothing.

## Projection stores and reads

| Store | Purpose and access |
| ----- | ------------------ |
| scenes.state | Pinned policy, private world seed, last projected stamps (`projected`), the layout counters and the latest failure stamp; one locked scope. No manifest, no route list |
| scenes.systems | The sky: one row per system with its coarse cell, planet and object counts and the scene revision at which anything of it last changed; paged by system id |
| scenes.objects | Stable descriptor, system/chunk membership, layout and slot; caller/epoch/object lookup, and by system |
| scenes.chunks | Immutable chunk versions; a system's current manifest is the newest version of each of its chunk ids |
| scenes.manifests | Whole-manifest versions an older projector wrote; no longer written, still erased |
| scenes.looks | The look of each system, planet and region, assigned once; caller/epoch, never updated (U-1, below) |

Migration 0122 is additive for the rows that exist (a v1 object is unchanged) and adopts every world that
exists (`scenes.adopt_legacy_layout`, below). No seed, personal row or job is inserted by migration.
Versions retain history until personal erasure; schema growth is bounded per system, with retained
versions growing with actual Geography effects.

Reads validate strict capabilities and current selection without enqueueing. Empty Geography
returns a computed zero-revision empty manifest with no persistent state. Nonempty Geography
without a projection is loading only while a real current-scope required job is created/retry/active.
A valid earlier projection plus an actual newer current job is lagging. Missing/failed/dead-letter
work is unavailable; a terminal projection limit is unavailable/limit. Unrelated root activity is
never pending. Unsupported capabilities return the canonical unsupported_version fallback.
Current ready/empty data must match Geography; stale projections are never relabelled current.
Every read asks Geography only for its head, never for a place.

- **The sky** (`ReadOwnSceneSky`, `POST /v1/universe/scenes/sky/read`, `scene-sky-read.v1`) is the first read
  of a client that declared `scene-sky.v1` and the looks it carries. It lists systems only, 200 a page in id
  order: the system's descriptor (anchor, seed, label, activity), its haze, its planet count and its scene
  revision. `sinceSceneRevision` makes it a refresh that lists only the systems changed after a revision the
  client holds. A cursor binds the scene revision of its first page; a map that moved between pages answers
  `snapshot_expired` and is read again from the start.
- **One system** is the existing manifest and chunk reads with `selection: system`. The manifest names the
  newest chunk versions of that system in one query and loads no chunk; it carries the system's looks to a client
  that declared them. A system that is not on the map is `selection_not_found`.
- **Chunk reads** require the current scene revision (`stale_manifest` otherwise) and load and check only the
  one exact chunk they name, which must be the newest version of its chunk id and belong to the selected
  system (`unknown_chunk` otherwise), so reading a system chunk by chunk costs one row each (#674, D-409).
  An honestly lagging projection may serve its exact older chunks.
- **The whole map** (`selection: universe`) is composed from every system's current chunks, for a client
  that predates the sky, and only while it fits what that client can hold: at most 1000 objects, 128 chunks,
  anchors within 10,000 and look variants within 1000. A map past that is `unavailable` with `limit` for
  every client, the sky included; it is read as the sky and one system at a time.

Reads expose neither world seeds nor private Geography context. The API scene controllers perform
account/session/HTTP admission; these backend ports still require current own personal authority.

## A map at scale (D-417)

Status: implemented and CI-tested against real PostgreSQL (migration 0122); not yet used on dev.
Related: #674 slice 4.3.

**Compatibility.** A client declares `sky: ['scene-sky.v1']` (with looks) to be served the sky. One that does
not keeps the protocol it had: the whole manifest, every chunk by reference, and the whole-map Geography read,
for as long as the map fits it (the bounds above), and a clean `unavailable`/`limit` after that. Wire shapes
of the manifest and chunk reads did not change.

**Adoption.** `scenes.adopt_legacy_layout(universe, epoch)` gives a world an older projector left its
`scenes.systems` rows and the new state shape (`projected` from the old manifest's revisions, `layout.legacyReach`
the widest anchor of its v1 objects, `layout.nextCell` past the highest cell any system holds, no manifest, no route
list). It moves no slot, anchor, seed, family, chunk or chunk reference. A second call on a world already in the new
shape does nothing. Run again on an old-shape state, it refreshes the planet and object counts of the sky rows that
exist (their cell and scene revision stay) and adds the missing rows. The migration runs it for every world that
exists. The projector and the look backfill run it first when they find an old-shape state, which is a world an old
projector created after the migration. A read never writes: an old-shape state it meets is `unavailable` until then.

**Old workers.** An old projector is not adopted again. Against a world that was already adopted it writes the
whole-map state with a scene revision that has gone back, `scenes.guard_state` refuses the write, and its job
dead-letters. Stop the old `scenes.project` consumers before migrating, and deploy the new worker with the
migration.

**Projection.** `scenes.project` reads the head, asks Geography for the systems changed since the last projected
revision (fifty at a time), and for each step reads those systems with the routes between their planets, lays
out their new objects, chunks them, gives the looks that are missing and writes. The look rule counts the
universe's planet types from one aggregate query (kept across the steps of a run), not from every look. One
scene revision is taken per projection; only a system that changed takes it as its own revision. A delta that
touches one system therefore writes that system's chunks and sky row and nothing else.

**Measured** (`tests/integration/modules/scenes-scale.test.ts`, one laptop, disposable PostgreSQL 15, authored
synthetic places; CI fixtures, not dev; two runs, the range is the load of the machine): a first projection of
5520 places in 501 systems took 5.6 to 11.1 s (1 to 2 ms a place, 50 systems a step); `scenes.state` held 176
bytes; the sky read in three pages of 200, 200 and 101 systems took 0.1 to 0.4 s a page; one system (Geography
read, manifest, chunk) took 12 to 33 ms and read 1 chunk head, 1 chunk and 10 looks; the universe Geography read
paged 5520 places in 56 pages in 1.7 to 2.3 s; a delta that relabelled one place re-projected in 8 to 11 ms, and
one that added a planet and a region in 12 ms, each writing one chunk version and moving one system's revision.

**Known limits.** Formation still refuses to grow a universe past 1000 places (Geography `structure_limit`, slice
4.1); nothing in Scenes depends on that ceiling. A first projection of a very large world is one transaction of
about 2 ms a place against a 180 s job expiry. The sky is 200 systems a page, about 0.5 KB each. A client
that predates the sky cannot hold a map past 1000 objects and is told so.

## The look of each place (U-1)

Status: implemented and CI-tested against real PostgreSQL (migration 0070); not yet used on dev.
Related: #465, D-077, D-078, D-102, D-103.

The New Universe draws a planet in one of six painted types with optional rings and a moon, wraps
each system in a haze family, and lays a planet's regions on fixed sites. That data is the **look**.
It lives in `scenes.looks`, a sibling of `scenes.objects` (which `scenes.guard_object` freezes), so
descriptors, chunks and manifests stay `scene-descriptor.v1`, `scene-chunk.v1` and
`scene-manifest.v1`. Stars have no look.

| Object | Look (`scene-look.v1`, generator `worldmap.v1`)             | From                                                                                          |
| ------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| System | `haze`                                                      | the library plan (`LibrarySystem.haze`)                                                       |
| Planet | `type`, `rings`, `moon`, `hueShift`, `variant`, `siteCount` | the rule in `application/assign-looks.ts` (D-103), the planet's seed and its catalogue facets |
| Region | `site`                                                      | the ordinal of its facet in its planet's catalogue entry                                      |

- **Assigned once.** The projector gives a look to every system, planet and region that has none, in
  the transaction that stores the object. `assignLooks` is pure and reads only the stored looks and
  the objects' seeds and catalogue meanings, never activity, evidence or what is in use now. The
  database refuses an update, a look that names another object and a look for no object.
- **Six planets, six types.** Least-used first, then a type the system does not hold, then the
  planet's seeded order. A repeat records `variant` and turns its hue. Region sites do not depend on
  which other regions have formed.
- **Served on the manifest read.** A client that declares `looks: ['scene-look.v1']` and the
  `worldmap.v1` generator gets `looks` for the objects in the manifest it reads. Every other client
  gets the read it always got. Chunk reads are unchanged.
- **Backfill.** `node dist/operator.js scenes backfill-looks [--dry-run] [--limit n]` sends a
  `scenes.backfill-looks` job for each universe with a projected place that has no look. The job
  (`application/backfill-looks.ts`) rechecks the owner under the personal root lock and inserts the
  missing rows only: no slot, seed, family, anchor or chunk changes. It walks the systems fifty at a time;
  a system that was given a look has changed for a client holding the sky (its haze), so it takes a new
  scene revision, and the projected revision moves with it. It advances the root and sends the disposable
  notice once, and only when it assigned something. Idempotent. Queue policy as the projection's: 120s expiry,
  three 10s backoff retries, concurrency 1, dead letter.
- **Growth.** A planet is drawn with its facets plus 4 spare sites, so a facet the plan appends
  later takes the next site and moves nothing. Facets are append-only (a pinned table in
  `assign-looks.test.ts`). A region past even the spare sites is left without a look, the scene
  stays current, and `scenes.look_refused` is logged; only a structural disagreement between the
  plan and the stored objects makes the scene unavailable. A visitor's device
  derives its own look from public ids (D-047) and may repeat a type.
- **Not built here.** The world generator that lays out continents and regions from a planet's seed
  (`worldmap.v1`), and every screen that draws a look (U-2 to U-4).

## Erasure and verification

Scenes erases before Geography. All projection tables across every epoch/version, seeds and every
Scene pg-boss state/dead letter (projection, formation expiry and look backfill) are removed using the existing registry/job eraser; `scenes.looks` and `scenes.systems` go first because they reference the objects. No separate
cache exists. Root/epoch/owner fencing prevents late jobs from resurrecting reset/erased state.
Queue policy:180s expiry, three 10s backoff retries, local concurrency 1,7d queued/2d settled
retention plus the declared dead letter. No independent business role/attempt ledger is needed
for this bounded CPU projection.

Automated suites run only in GitHub Actions. Pure authored fixtures exercise deterministic
allocation/families, the v2 layout (spiral, ordinals, legacy reach), per-system hierarchy, parser caps and
stability, the sky and system read shaping and the look rule from an aggregate; PostgreSQL fixtures
exercise input minimization/root semantics, atomicity/replay, actual pending work, strict refs,
immutable versions, erasure, late/suspended authority, a map of thousands of places (sky, one system,
single-system deltas, a refused step rolled back) and the adoption of an older world. Source/fixture
acceptance leaves actual dev projection, renderer/navigation, actual U05 presentation and
populated-device performance unverified. Worlds that exist are adopted by migration 0122; reads never
bootstrap anything.

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
the newest chunks of their systems (the targets' stored objects name them), with exact canonical identity, origin, truth,
label and object revision. Missing/stale/currently unprojected targets return unavailable; an
ancestor, alias or earlier projection cannot supply readiness. Unrelated root changes do not
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
