# @knowscroll/migrations

Reviewed raw-SQL migrations and their static registry (blueprint §5).

- One file per migration: `NNNN_purpose.sql` in this folder.
- `src/registry.ts` lists every file once, in apply order, with the SHA-256 of its reviewed text.
  `src/registry.test.ts` fails when the folder and registry disagree or a reviewed file changed.
- Applied by `node dist/migrate.js` in the API release tree (`@knowscroll/backend`'s
  `migrateToLatest`), forward-only, inside Kysely's migration lock. Never edit or delete a migration
  that reached a shared database; write a new one.
- `pnpm --filter @knowscroll/migrations lint:sql` runs squawk (PostgreSQL 16 rules) in CI.

Each migration's header comment states: owner module, authoritative/derived role, main query
shapes, indexes/constraints, expected growth, retention, correction/erasure, and rollout
behaviour for older processes (blueprint §23 pattern 5).

0040 adds Social's account-lifetime current public roster index/heads and latest hash-only invite.
It backfills only existing explicit public sides and binds projection updates to the same pair transaction.
All earlier SQL remains immutable; schema40 requires compatible writers and no backward activation.

0041 is the Identity recording prerequisite: monotone on/generation fields on the existing root,
SQL transition guards and immutable exact-body account-lifetime recording_commands receipts.
Selective Clear preserves them. This schema does not activate Pause; every contribution owner
must carry and fence original generations before exposing a controller/control. All previous40
SQL files remain immutable. No new root, queue, provider/financial change or deletion executor.

0042 is the recording pipeline schema prerequisite. Eleven initially empty tables hold Experience
command/offer provenance and generation segments, Evidence recorder sessions/source heads/effective
credit, and PC source heads/effective structural and coverage contributions. Nine action-state
columns track independently eligible Save/Like decisions; three Evidence audit columns retain
literal generation 1 for historical rows. All new checks and foreign keys on existing tables are
`NOT VALID`; this migration does not scan or certify historical contributions.

Exact root, epoch, exposure, generation, action and activation bindings supplement the genuine
runtime recording transaction capability. Current-generation writes cannot alter sealed heads;
effective credit carries its previous committed value into an immutable generation baseline.
Activation time is a nullable, set-once pair so a correction-only segment creates no activation
fact. Eligible negative actions can correct earlier effective Save/Like credit through exact
original lineage. A NULL channel state remains uncertified: no legacy initialization, replay
backfill, event-cap reset or positive-growth certification is installed here.

Clear/full erasure must delete PC coverage references, effective contributions and segment heads
before Evidence heads/credit/sessions/audits, then Experience inputs/segments/origins before their
referenced offers, actions, exposures and receipts. Account-lifetime Identity recording policy and
receipts retain their existing lifecycle. Compatible owner adapters and deletion ordering must land
before rollout; stop unfenced older writers before election. This source prerequisite activates no
API, UI, worker role or provider operation. All previous 41 SQL files remain immutable.

0043 is the personal-role provenance prerequisite: 30 additive columns on existing Planner,
Geography and personal Reasoning rows, with no new table, index, outbox or data backfill.
Twelve old-table checks/foreign keys stay NOT VALID. Origins retain the accepted account,
original generation and command/material source; queued coalescing cannot rewrite birth identity.
Recorded non-NULL context requires both complete-context and exact model-item hashes in the same
write; that pair, context JSON and Planner context version are set once. Unmarked legacy context
remains unknown. Existing exact run keys bind ordinary wake UUIDs and delayed claim UUIDs instead
of scanning pg-boss history. Only an exact matching delivery consumes its own wake marker; an old
retry cannot consume a newer wake.

Runtime genuine root/account/epoch/recording capabilities and actual owner-purpose checks remain
mandatory before any private context, protected request, kept answer or personal growth. NULL
is unknown legacy; old prepared work is never stamped with a resumed current generation.
The four Reasoning proof columns redact only with its irreversible privacy marker; minimal
usage, unknown settlement and financial identity remain independently accountable while paused.
Role rows retain their existing all-epoch erasure. No controller, UI, role flag, model call,
paid allowance or deployment is activated. Compatible whole consumers and current-candidate
Actions must precede election; all previous42SQL stay byte exact. Source schema application to
an empty own SSD database/codegen is separate from behavioral CI and runtime acceptance.

## Fresh lifecycle protocol (0044, source prerequisite)

Adds two empty eight-column stores and one nullable root mode (17 columns), with no historical
initialization or existing table index. The canonical literal `fresh-recording-lifecycle.v1`
registry/writer protocol hashes to
`ebbec3bda043ab47c5566ebb29e80322e841f4dc15ef7940fc2ee4c053176dc1`; its immutable literal
lives in `packages/backend/src/erasure-registry.ts`. It contains no circular code/SQL hashes.
Birth is the actual mode1 root INSERT in createAccount. Existing NULL roots can elect mode1 only
at verified current selective-Clear core completion, before releasing the barrier. Financial
completion is independent. Mode1/owner and witnesses are immutable; full erasure removes the
witness without restoring authority. Certificates distinguish empty from real false and require
actual eligible actions and completed receipts. Deferred checks inspect final exact rows.

All prior43 SQL stays byte-exact. The rollout must stop/replace incompatible processes and compose
all real writers before making new roots reachable. These narrow guards do not sandbox an old
binary issuing arbitrary aggregate SQL. Source/codegen and hosted fixtures are separate evidence;
this migration does not activate Pause or certify retained legacy channels.

The two `prefer-bigint-over-smallint` exceptions in0044 cover only literal CHECK=1 format tags,
not counters. No capacity or growing sequence relies on smallint.

Pending0044 correction after hosted d5 failures: the fixed manifest includes the actual Planner and Geography runs.recording_account_id links, both erased with their owning run rows. The old c21 digest and failed source remain retained; no OLD/NEW compatibility or Conversations extension is installed. The exact0042 audit-identity function is replaced here using positional arguments solely to remove runtime PL/pgSQL name collisions; signatures, types and equality guards remain unchanged. All0001–0043 remain byte-exact.


Pending routing correction before0042 has reached a shared database: exactly three additive
recent/unit/facet query indexes read retained actual eligible activations across generations.
They do not initialise historical channels or alter any other0042 statement. Its reviewed registry
checksum is now3b85edec0d4c135b72637ba52527002f57b8a6d4ac23ce4df05af8251fad50cb;
0001–0041 and0043/0044 remain byte-exact. Earlier source/failure and disabled operator pins remain
historical and must be rebound after exact full44 candidate acceptance. No schema deployment follows
from this source correction.

0047 adds `composer.buffers`: one worker-prepared next-move buffer per person and mode, pointing at an
ordinary Composer decision, with optional stored Jev assessments. The new personal store and the job
payload store `pgboss/composer.prepare-buffer` change the fresh-recording registry, so its digest becomes
`d7942e43bb8211f37dfd08b4dfb6ac2e1b2543229a257f9c5ba850df135a1d10`. The same migration moves the places
that repeat the digest (the witness table's CHECK and the birth trigger) to the new value and re-stamps
every existing witness. Schema 44 is live on dev, and the application reads a witness with any other
digest as an unavailable lifecycle, so without the re-stamp every existing account would fail its next
recording-aware command until it ran Clear. Re-stamping is truthful: the new stores are empty for every
existing universe. The witness guard trigger refuses all updates, so it is disabled for that one statement.
Deploy the new binary with the migration: a process still holding the old digest sees the lifecycle as
unavailable. Any later personal store repeats this step until the registry manifest is simplified.
