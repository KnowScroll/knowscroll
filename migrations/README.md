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
initialization or existing table index. Each witness was stamped with the digest of a registry
manifest; 0051 removes that digest. Birth is the actual mode1 root INSERT in createAccount.
Existing NULL roots can elect mode1 only at verified current selective-Clear core completion, before releasing the barrier. Financial
completion is independent. Mode1/owner and witnesses are immutable; full erasure removes the
witness without restoring authority. Certificates distinguish empty from real false and require
actual eligible actions and completed receipts. Deferred checks inspect final exact rows.

All prior43 SQL stays byte-exact. The rollout must stop/replace incompatible processes and compose
all real writers before making new roots reachable. These narrow guards do not sandbox an old
binary issuing arbitrary aggregate SQL. Source/codegen and hosted fixtures are separate evidence;
this migration does not activate Pause or certify retained legacy channels.

The two `prefer-bigint-over-smallint` exceptions in0044 cover only literal CHECK=1 format tags,
not counters. No capacity or growing sequence relies on smallint.

Correction made before 0044 was merged: the Planner and Geography `runs.recording_account_id`
links are declared as account columns and erased with their owning run rows. The exact 0042 audit-identity
function is replaced here using positional arguments only to remove runtime PL/pgSQL name collisions;
signatures, types and equality guards are unchanged. All 0001-0043 remain byte-exact.


Pending routing correction before0042 has reached a shared database: exactly three additive
recent/unit/facet query indexes read retained actual eligible activations across generations.
They do not initialise historical channels or alter any other0042 statement. Its reviewed registry
checksum is now3b85edec0d4c135b72637ba52527002f57b8a6d4ac23ce4df05af8251fad50cb;
0001–0041 and0043/0044 remain byte-exact. Earlier source/failure and disabled operator pins remain
historical and must be rebound after exact full44 candidate acceptance. No schema deployment follows
from this source correction.

0047 adds `composer.buffers`: one worker-prepared next-move buffer per person and mode, pointing at an
ordinary Composer decision, with optional stored Jev assessments. At that time every new personal store
changed the registry digest pinned in the witness CHECK and the birth trigger, so 0047 swapped both and
re-stamped every existing witness (the guard trigger, which refuses all updates, was disabled for that one
statement). 0051 removes the digest, so no later store repeats this step.

0048 adds Planner-originated demand to Supply: `origin`, `planner_run_id` and `planner_slot` on
`supply.requests`, the `deferred` state, and two unique indexes: one plan opportunity is one demand, and
a person has at most one open planned waiter per shared matching group.
The checks are `NOT VALID`; older writers default to `origin='person'` and never write `deferred`.
No new table, so the erasure inventory is unchanged and Clear removes planned demand with the rest
of the person's requests.

0050 adds `reasoning.production_rejected_answers` and ends the separate claims stage of Scroll production.
The table keeps a refused model answer of a nonpersonal production attempt, redacted and cut at 64 KiB,
with the validator's findings, for 30 days; `answer_kind` says whether the text is the model's answer or
the raw body of an unreadable reply (only an answer is ever fed back to a repair). Personal roles never
write to it, so the erasure inventory is unchanged. On `content.scroll_production_runs` it drops
`claims_run_id`, closes any job still parked in the retired `claims` state as rejected, and replaces the
state check without `claims` (`NOT VALID`, like the other vocabulary changes). Apply it together with the
workers of recipe `scroll-production.v14`; no process of the previous recipe may run a job afterwards.

0051 removes `registry_sha256` from `identity.recording_lifecycle_witnesses` and rewrites the birth trigger
to insert without it. Dropping the column drops its CHECK. Every existing witness keeps its epoch, account,
origin and clear operation, so accounts stamped by 0044 or 0047 stay `fresh`; the readers now look only for
the row. The guard trigger is untouched and witnesses stay immutable. Apply with the new binary: a process
of the previous recipe still selects the dropped column and fails with a database error (closed, never an
unverified lifecycle) until it is replaced. Erasure completeness no longer depends on the witness: the
schema inventory test and the inventory check inside every Clear prove it (D-050).

0055 is the account privacy slice (#246, D-043). `identity.accounts` and `identity.universes` accept the
status `deleting` (their checks are replaced `NOT VALID`); every existing check tests `status = 'active'`, so
a deleting account is fenced everywhere without further changes. `identity.account_deletions` holds one
operation per deletion: its id is chosen by the client and doubles as the receipt a signed-out device can
still read, and when the work completes the row drops its account and universe links and stays as an audit row
(id, two timestamps, a state) with no personal data. `identity.data_exports` holds one export file per row
(at most five per account, a file removed at first download, expiry or account deletion; a download link is the
SHA-256 of a one-time token). `identity.sessions` gains `device_label` and `last_used_at`. All new objects are
additive, so an older process neither writes `deleting` nor reads the new columns. Apply with the new binary:
a deployment without the worker's `identity.delete-account` consumer would leave deletions pending.

0056 adds conversations and share links to the `social` schema (#242, D-042). It creates `conversations`,
`conversation_members`, `messages`, `inbox_heads` and `content_shares`; nothing existing is altered, so an
older process simply never touches them.

- `conversations`: one open conversation per friendship lineage (`pair_id`, `lineage`); `pair_id` is nullable
  with `on delete set null`, so a deleted friend leaves the conversation readable and closed (D-043).
  `last_sequence` and `last_change_sequence` are counters that only grow.
- `messages`: primary key `(conversation_id, sequence)`. A check allows exactly three shapes: text, a card for an
  exact `(asset_id, asset_revision)` in `content.asset_revisions`, or a tombstone with no author. A partial
  unique index on `(conversation_id, author_account_id, command_id)` makes a send idempotent.
- `inbox_heads`: one revision per member, bumped inside the friendship lock for the Talk hint.
- `content_shares`: only `token_hash` is stored (unique); `expires_at` and `revoked_at` decide availability.
- Erasure: every table is in the Social inventory (`adapters/erasure.ts`): account deletion deletes links,
  tombstones messages and closes conversations; exploration Clear keeps them all.

Apply with the new binary. 0055 (#246) runs first; 0056 only needs the earlier Social tables (0028, 0040).
