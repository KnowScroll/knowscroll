# ADR-0045 — Idea Rooms v1: a carried question becomes a room, and its inhabitants hold sourced positions

Date: 2026-09-24. Status: accepted by the coordinator for [#163](https://github.com/KnowScroll/knowscroll/issues/163)
(parent #134, component epic #10). Builds on ADR-0016/0017 (Ask facts), ADR-0031 (substrate, claims and
their support), ADR-0036/0037 (the reader's places, deltas and their causes), ADR-0039 (the return) and
ADR-0040 (correction refresh). Target design: `docs/architecture/target/11-IDEA-ROOMS.md`, at bench values.

## Context

The target Idea Room is one open question anchored to a place, with a charter, a ladder, three to five
residents who differ in *evidence access*, and night episodes funded by the reader's attention. Every
resident step there is a model call. Nothing of it exists: a reader's questions (Asks) are recorded,
and may be answered one at a time (ADR-0033), but a question the reader keeps coming back to leaves no
trace in their universe.

The owner's rules for this slice: a room and its inhabitants are formed and changed only with a typed
cause and evidence, never by a timed counter or a visual rearrangement; social rooms stay in #137.

## Decision

1. **A room opens from a carried question** (the target's first path, §2). The Keeper (deterministic,
   `packages/core/src/rooms/keeper.ts`) opens a room on a live planet or region of the reader when the
   reader has recorded **at least two Asks on at least two different days** from Scrolls whose primary
   concept is the place's anchor or inside its subtree, and no live room of that place already holds
   them. The room's question is the reader's own words: the text of the latest of those Asks (private,
   like every Ask). Its evidence is the Ask ids, their days and the Scrolls. Caps: at most 3 live rooms
   per place and 12 per universe; beyond a cap, a newly carried question joins the place's most recent
   room as another Ask (`question_joined`), it never opens another. Nothing opens while paused.
2. **Inhabitants are seats of evidence access, not voices** (target §5, "evidence families, not
   voices"). A room seats at most three, each only when its evidence exists; each holds a *position*:
   up to four currently supported claims of the room's substrate neighbourhood, chosen deterministically.
   - **The reader of record** holds claims that `support` the anchor concept (subject or mechanism role).
   - **The doubter** holds claims about the anchor with a `qualifies` or `contradicts` support, or claims
     recorded as counterevidence to the anchor's relations. Seated only if such a claim exists.
   - **The connector** holds the claims (or admitted bridges' cited claims) that tie the anchor to
     another of the reader's live places. Seated only if such a connection exists.
   Inhabitants speak only through the claims they hold: their words are the substrate's claim
   statements. **No model is called in v1**; a resident's model step is a later slice with its own
   budget and ADR.
3. **The ladder is evidence, not time.** v1 states: `opened` (seated, no disagreement), `arguing` (the
   doubter is seated: two positions on the same anchor disagree), `set_aside` (the reader said no),
   `retired` (its basis went away: every Ask it was carried by was erased, or its place is no longer
   live). No state is reached by elapsed time; `quiet`/`dormant` and night episodes are later slices.
4. **Deltas are the only way a room changes** (ADR-0036 §2 pattern). `room` and `room_inhabitant` rows
   change only together with an immutable `room_delta` in the same transaction (deferred constraint
   trigger): `room_opened` and `question_joined` (`personal_exploration`, evidence: Ask ids and days),
   `inhabitant_seated` / `position_changed` (`substrate_neighbourhood`, evidence: the claims), 
   `inhabitant_unseated` and `position_changed` after a claim lost its support (`source_correction`),
   `room_set_aside` (`reader_correction`), `room_retired` (`reader_correction` when the reader's Clear,
   place rejection or Ask erasure removed its basis; `source_correction` when the place retired after a
   correction). The chronicle lines are the Keeper's own deterministic words (ADR-0036 chronicle).
5. **When the Keeper runs.** Wherever the Cartographer runs (the personal-model refresh after an Ask,
   exposure, keep, branch, feedback or correction, and the ADR-0040 catch-up pass), in the same
   transaction, after places: so a correction that takes a claim's support away changes the positions
   while the reader is away, and `source_correction` room deltas appear in "While you were away"
   (ADR-0039 §1 lists `source_correction` atlas-style deltas; room deltas join that list).
6. **The reader corrects.** `POST /v1/rooms/:roomId/set-aside` (client request id, expected epoch):
   `room_set_aside`; its inhabitants are unseated with it; the carried Asks never reopen a room for that
   place until Clear/Reset. Refused while paused. Rejecting the room's place (ADR-0036 §4) retires its
   rooms in the same transaction.
7. **Read.** `GET /v1/atlas` carries, per live place, its live rooms `{roomId, question, state,
   inhabitants: [{role, claims:[{key, statement, truthState, supportKind}]}], openedAt}`; `GET
   /v1/rooms/:roomId` adds the room's chronicle with evidence; `GET /v1/rooms/deltas/:deltaId` returns one
   delta's evidence. **No source is ever returned** (owner decision, 2026-09-24): claims carry their
   statements and truth state only.
8. **Privacy.** Rooms, inhabitants and deltas are private history: Clear and Reset erase them, export
   carries them, account deletion removes them. The question text never leaves the reader's universe.
9. **Android.** The place sheet lists its rooms under the reader's question; a room opens a sheet with
   the question, its state in words ("Two readings disagree"), each inhabitant as a role with the
   sentences it holds, the room's chronicle (each line opens its evidence) and "Set this room aside"
   (not while paused). The Atlas marks a place that holds a room (PR130's visual direction: a small
   lit door on the place, no new object on the map). Web parity is #171.

## Amendment (implementation), 2026-09-25

Built as decided, with these adaptations to what the code holds. The question is not copied: the
room names the Ask whose words it uses (`question_ask_id`), and the text is read from that Ask's
ledger payload (`question`, migration 0009). An Ask counts at the nearest live planet or region on
its Scroll's primary-concept chain (the atlas's own rule for where a Scroll belongs), so one question
never opens a room on both a planet and its region. No room can outlive its Asks: they are erased
only by Clear, Reset and deletion, which erase rooms first (and the room references its question's
Ask), so a room retires only when its place stops being a live planet or region; the Cartographer retires
only sightings, so that happens only when the reader rejects the place (`reader_correction`). A room
holds its Asks wherever it is, set aside and retired included, so a question never opens a second room
when a nearer region forms or a rejected region hands its Asks back to its parent (review, same day). A claim is held by
one seat only (doubter, then connector, then the reader of record, who holds the anchor's other
supported claims), so no sentence appears twice. A position change or an unseating is
`source_correction` when a claim it held left the substrate (lost its support, its qualification or
its tie), `reader_correction` when the connector's other place was set aside, and
`substrate_neighbourhood` otherwise. Setting aside and retirement unseat everyone under the room's
own delta. The Keeper is its own step (`runKeeper`), run by the refresh right after the Cartographer
and by a rejection; room changes reach "While you were away" as `room_changed`; the set-aside answers
with the atlas, as a place's rejection does; `GET /v1/rooms/:roomId` carries each line's evidence
inline. Backdating a day-old Ask in a disposable database (tests, the device seed) lifts migration
0009's Ask immutability trigger for that one update only.

## Not in this version

Model-backed resident steps (reflex, background, night), credits and attention funding, visitors, the
verifier, tests and artifacts (`both_sides_scroll`, `finding`, `settled_answer`, …), spin-offs,
black-hole rooms, `quiet`/`dormant` by time, room dependencies and shared rooms (#137). Each is a later
slice with its own version; thresholds here are bench values carried by `keeper-v1`.

## Consequences

Migration `0038_idea_rooms.sql` (`room`, `room_inhabitant`, `room_delta`, guards: immutable deltas, a
room or inhabitant changes only with a delta, caps, epoch match, no change while paused);
`packages/core/src/rooms/keeper.ts` (pure: carried questions, seats, positions, ladder, deltas);
`packages/db/src/rooms.ts` (apply, read, set aside, erase, export) called from the personal-model
refresh; contract `packages/contracts/src/rooms.ts`; routes; the away list; Android data and UI; an
emulator journey that carries a question over two days (the first seeded through the real API and
backdated, as in `seed-day-old-history.ts`), opens the room, reads its positions, sees a source
correction change a position while away, and sets the room aside.
