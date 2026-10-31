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
All earlier SQL remains immutable; schema 40 requires compatible writers and no backward activation.

0041 is the Identity recording prerequisite: monotone on/generation fields on the existing root,
SQL transition guards and immutable exact-body account-lifetime recording_commands receipts.
Selective Clear preserves them. This schema does not activate Pause; every contribution owner
must carry and fence original generations before exposing a controller/control. All previous 40
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
Actions must precede election; all previous 42 SQL stay byte exact. Source schema application to
an empty own SSD database/codegen is separate from behavioral CI and runtime acceptance.

## Fresh lifecycle protocol (0044, source prerequisite)

Adds two empty eight-column stores and one nullable root mode (17 columns), with no historical
initialization or existing table index. Each witness was stamped with the digest of a registry
manifest; 0051 removes that digest. Birth is the actual mode 1 root INSERT in createAccount.
Existing NULL roots can elect mode 1 only at verified current selective-Clear core completion, before releasing the barrier. Financial
completion is independent. Mode 1/owner and witnesses are immutable; full erasure removes the
witness without restoring authority. Certificates distinguish empty from real false and require
actual eligible actions and completed receipts. Deferred checks inspect final exact rows.

All prior 43 SQL stays byte-exact. The rollout must stop/replace incompatible processes and compose
all real writers before making new roots reachable. These narrow guards do not sandbox an old
binary issuing arbitrary aggregate SQL. Source/codegen and hosted fixtures are separate evidence;
this migration does not activate Pause or certify retained legacy channels.

The two `prefer-bigint-over-smallint` exceptions in 0044 cover only literal CHECK=1 format tags,
not counters. No capacity or growing sequence relies on smallint.

Correction made before 0044 was merged: the Planner and Geography `runs.recording_account_id`
links are declared as account columns and erased with their owning run rows. The exact 0042 audit-identity
function is replaced here using positional arguments only to remove runtime PL/pgSQL name collisions;
signatures, types and equality guards are unchanged. All 0001-0043 remain byte-exact.


Pending routing correction before 0042 has reached a shared database: exactly three additive
recent/unit/facet query indexes read retained actual eligible activations across generations.
They do not initialise historical channels or alter any other 0042 statement. Its reviewed registry
checksum is now 3b85edec0d4c135b72637ba52527002f57b8a6d4ac23ce4df05af8251fad50cb;
0001–0041 and 0043/0044 remain byte-exact. Earlier source/failure and disabled operator pins remain
historical and must be rebound after exact full 44 candidate acceptance. No schema deployment follows
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

0057 creates the `ops` views (#248, D-044): allowlisted columns over the owners' tables, `ops.safe_code`, and the journey
view. Views only; no data. The views over pg-boss and the read-only role's grants are not here: `migrate.js` builds them
after pg-boss has installed its schema (`infrastructure/postgres/ops-job-views.ts`).

0058 adds content threads (#243, D-046). It is additive: older processes keep working.

- `social.conversations.kind` (`direct` or `thread`, default `direct`); a thread has no friendship (`pair_id` is null).
- `social.conversation_members` gains `pending`, `invited_by_account_id` and `invited_lineage`. An invited member keeps
  access while that lineage equals the friendship's accepted lineage; both columns are null when the inviter has gone.
- `social.content_threads`: one row per thread with the exact root revision, an optional name and the starter (nulled when
  the starter's account is deleted).
- `social.message_snippets`: one row per snippet message. A check admits only the three shapes (Reel range, Scroll passage,
  Scroll block) and bounds the stored quote (600 characters) and settings (1 KiB).
- `experience.exposures_activated_assets_idx` serves the episode markers (a person's activated exposures by asset).
- Erasure: both new tables are in the Social inventory (`adapters/erasure.ts`). Deleting an account removes the person's
  membership, tombstones their messages and deletes those messages' snippet rows. Clear keeps threads and snippets.
- Apply with the new binary. 0057 runs first; 0058 needs 0056 and 0011.

0060 adds one nullable column, `next_run_not_before`, to `geography.state` and `planner.state` (#231, D-052): the
earliest time that person's next Cartographer or Planner run may start. A settled run sets it, and the next run's wake
waits for it. Nothing is backfilled or constrained, so an older process leaves it null (no wait). Apply with the new
binary; the generated database types change by the same two lines.

0065 adds `background` to `reasoning.usage_receipts` (#231, D-058): whether the role that made the attempt is a
background role (Jev, Cartographer, Planner). Admission sums background receipts apart, so those roles stop at their
share of the global and the personal daily caps. Additive with a default of false: an older writer leaves receipts
counted as asked-for, which is the old behaviour. The three roles' receipts written so far are marked in the same
migration. Apply with the new binary; the generated database types change by the same line.

0066 adds `composer.jev_assessments` (#231, D-058): one row per person with their recent Jev assessments (at most 60,
each used for 30 minutes), so a candidate judged lately is not sent to the model again. A disposable cache, never
evidence. Erased with the person's other Composer stores. Nothing is backfilled; no earlier writer exists.

0068 is Feedback (D-055): `experience.not_interested` (a short-lived routing constraint, universe-keyed; it keeps the mark it
replaced so Undo of a second tap restores it), `feedback.reports` (account-keyed reports to the safety team; a report about
a deleted account loses its pointer to the person and carries `retain_until`, 90 days after the deletion, for the
`feedback.purge-reports` job) and the `ops.feedback_reports` view.
Additive; no earlier writer. The queue `feedback.purge-reports` is registered by the migrate command with the others.

0069 is the room as a place (v3 R-1, #487, D-062, D-069, D-160, D-161): `rooms.discussions.kind` (`general`, `topic`, `today`; one `general`
per room by a partial unique index; every existing room gets an empty General, every existing discussion is a `topic`),
`rooms.members.ai_level` / `keep_out` / `notice_seen_at` (existing members get Lively in an open room and Quieter in any other, nothing
kept out, the AI notice unread) and `rooms.room_presence` (one lease row per member who has the room open, account-keyed, read
only while under a minute old). Additive with defaults; an older writer leaves `kind` as `topic` and the settings at their defaults.
Apply with the new binary; the generated database types change by the same columns and table.

0071 is residents who speak on their own (v3 R-2, #488, D-162 to D-165): a second nonpersonal reasoning root (`rooms`, enabled by the
migration; the worker's environment switch is the gate), `reasoning.usage_receipts.ambient`, `rooms.room_cast` (every room gets the
residents its old `inhabitants` array named, as Nova and Halley), `rooms.ai_requests` renamed `rooms.ai_turns` with `request_id`
renamed `turn_id` and new columns (`trigger`, `cause_message_id`, `decided_by`, `caps`) and checks that keep a refusal quiet and an
unprompted turn unique per message and trigger, `rooms.messages.trigger`, the unlogged `rooms.typing_holds` (a discussion and a
time, no account) and the `ops.room_turns` view. The rename means a process from before this migration cannot ask or answer until it
restarts; every other change is additive. `rooms.rooms.inhabitants` is no longer read and is dropped by a later migration. Apply with
the new binary; the generated database types change by the same tables, columns and view.

0072 is the review gate for library v2 Scrolls (v3 S-1e, #472, D-138): `content.assets.status` may also be `held` (an asset whose first
revision waits for an operator; every existing read already treats it as not admitted) and `content.revision_reviews` records, for each
held v2 library revision, its state (`held`, `released`, `rejected`), who decided and when, and why a rejection. Additive: old writers never
store a held revision. Apply with the new binary; the generated database types change by the table and nothing else.

0073 is the quiet sweep (v3 U-3, #467, D-104): `geography.state.next_quiet_at` (when the sweep next needs to look at a universe; a
partial index serves the sweep's query), `geography.deltas.run_id` becomes nullable (a settle that only changes activity has no
Cartographer run), and every state that has places is set due once so the first passes store each world's true time. Additive;
an older writer never touches the column. Apply with the new binary; the generated database types change by the same column.

0075 is replies and reactions in Talk (v3 T-B, #482, D-146 to D-148): `social.messages.reply_to_sequence` (the earlier message of the same conversation a
message answers; a composite foreign key keeps it inside the conversation, and a check keeps it before the message and off a tombstone) and
`social.message_reactions` (one row per person, kind and message; five kinds). Additive: the column is nullable, so older writers keep working.
Apply with the new binary; the generated database types change by the same table and column.

0076 is asks, topics and "while you were away" (v3 R-3, #489, D-167 to D-169): `rooms.ai_turns.ask_kind` and a replaced decision check (every
asked turn has a kind, and a pointed ask or a mention names its message), the one-turn-per-message index narrowed to unprompted turns and a
new one that lets a message that names a resident ask once; `rooms.discussions.tag` and `title_derived` (a topic's title is the first words of the message it began from); `rooms.messages.topic_discussion_id` and a replaced
shape check (a person's card for a topic they started); `rooms.message_useful` (one mark per member per message); two small partial indexes on `rooms.messages` (removed messages and topic cards, so a reply count is not a count over a whole discussion); `rooms.read_positions`
(where a member left off, private); `rooms.summaries` (one row per room and 12-hour window, the unique key being the one-call cap, with
the provenance columns of a model call); and the `ops.room_turns` view gains `ask_kind`. The new check requires `ask_kind` on every asked
turn, so a process from before this migration cannot ask until it restarts, as at 0071; every other change is additive. Apply with the new
binary; the generated database types change by the same columns and tables, and the worker registers the `rooms.summarise` queue.

0079 is every room's face and painted backdrops within $1 (v3 R-4, #490, D-166, D-170, D-171): `rooms.room_identity` (a kit a model proposed for a room, as closed-vocabulary JSON with its version, and the operator's decision; one proposal waits and one kit is approved at a time), `rooms.backdrop_attempts` (the ledger of every paid image attempt, in millionths of a dollar, with the charge each counts against the $1 cap), `rooms.room_backdrops` (the painted images those attempts made, each reviewed before it is served) and the `ops.room_faces` view (counts and the spent total only). No table names an account, so the erasure registry has nothing to declare. Additive: an older process neither reads nor writes the tables, and every room keeps its default face. Apply with the new binary; the generated database types change by the same tables and view. Numbered 0079 on the branch (0077 and 0078 are merged); the coordinator renumbers at merge if another migration lands first.

0080 is party places (v3 T-D, #484, D-065, D-152): `social.thread_places` (one row per member and thread: a part from 1 to 99, `on` or
`finished`, and a `date`, so nothing finer than a day can be stored; the row follows the member's membership row through a composite
foreign key) and `social.conversation_members.place_hidden` (the member's own "hide where I am" for that thread, false by default).
Additive: older writers never touch the table and the column defaults. Apply with the new binary; the generated database types change by
the same table and column. Clear deletes the places and keeps the switch; deleting the account deletes the places before the membership
rows.

0083 is Call it together (v3 T-E, #485, D-155 to D-157): `social.thread_calls` (one row per member, thread and call: the option locked and a `date`, so nothing finer than a day can be stored; the row follows the member's membership row through a composite foreign key, and the call is an exact Scroll revision and stop). `social.thread_call_reveals` (one row per thread and call that has revealed, so a reveal stays revealed for a reader no block touches; the row's existence is all it holds: no day, no person, no pick; it has a foreign key to the thread and is declared in the erasure registry as kept with the thread). Additive: older writers never touch the table. Apply with the new binary; the generated database types change by the same table. Leaving, an ended friendship, Clear and deleting the account delete the picks. Numbered 0083 on the branch; the coordinator renumbers at merge if another migration lands first.

0084 is Today and the sky (v3 R-5, #491, D-174 to D-176): a Today discussion for every room (kind `today`, one per room by a partial unique index), `rooms.rituals` (a day's question or Spot the flaw for a room, as `ritual.v1` JSON, with who made it and the operator's decision), `rooms.ritual_solves` (a person's one tap on a Spot the flaw), `rooms.stars` (the room's stars: act, source, UTC day and constellation, unique per room, act and source, with no account), `rooms.constellations` and `rooms.constellation_votes` (a finished constellation, its three candidate names and the vote that names it), and `rooms.debates` and `rooms.debate_votes` (a topic tagged `debate`: two sides, a close time, the result and the votes). Additive: an older process neither reads nor writes the tables and would list Today among a room's discussions until it restarts. Apply with the new binary; the generated database types change by the same tables. Numbered 0084 on the branch (0083 is taken); the coordinator renumbers at merge if another migration lands first.
