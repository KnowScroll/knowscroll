# Social: friends, conversations, threads and share links

People find each other by handle, become friends, send each other a Reel or Scroll and talk about it.
Several friends can explore one Reel or Scroll together in a content thread, and point each other at an exact moment, passage or block.
A link to a Reel or Scroll can also be shared outside the app. A person can let friends visit their universe
and see whether they are around. Nothing here is consumption evidence: sending, receiving or opening a shared
card, visiting a universe and being shown as online never create an exposure, an observation or a Keep.

Status marks: **implemented** means merged with tests against real PostgreSQL. **Runtime-verified**
means used on a running dev system. Nothing in this module is runtime-verified yet.

## What the module owns

| Area                                             | Tables (schema `social`)                                                                                                                                               | Use cases (`public.ts`)                                                                                                                              | Status                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Profiles and friendship                          | `profiles`, `pairs`, `pair_sides`, `requests`, `command_bindings`                                                                                                      | `SOCIAL_USE_CASES`: profile, lookup, pair read, request, accept, decline, cancel, remove, block, unblock                                             | Implemented                              |
| Rosters and invitations                          | `roster_entries`, `roster_heads`, `invites`                                                                                                                            | `SOCIAL_USE_CASES`: friend and request pages, invite create, revoke, status, resolve                                                                 | Implemented                              |
| Conversations                                    | `conversations`, `conversation_members`, `messages`, `inbox_heads`                                                                                                     | `CONVERSATION_USE_CASES.conversations`: start, inbox, read, history, changes, send, read of a send, mark read, mute, leave                           | Implemented                              |
| Share links                                      | `content_shares`                                                                                                                                                       | `CONVERSATION_USE_CASES.shares`: create, revoke, read own, list own, resolve, public preview                                                         | Implemented                              |
| Content threads                                  | `content_threads`, `message_snippets` (and `conversations`, `conversation_members`, `messages`, `inbox_heads` with `kind = 'thread'`)                                  | `THREAD_USE_CASES`: create, read, history, changes, send, react, respond, mark read, leave, inbox, open snippet                                      | Implemented; not runtime-verified on dev |
| Replies and reactions (T-B, D-146, D-147)        | `messages.reply_to_sequence`, `message_reactions` (one row per person, kind and message)                                                                               | `conversations.send` and `threads.send` with `replyTo`; `conversations.react` and `threads.react`                                                    | Implemented; not runtime-verified on dev |
| SEEN in direct conversations (T-C, D-066, D-150) | `visibility_settings.share_read_state` and `read_state_revision`, and `conversation_members.shared_read_through_sequence` (migration 0078; the member's own read position `read_through_sequence` is unchanged) | `VISIBILITY_USE_CASES`: read and set the SEEN switch; `conversations.read` and `conversations.changes` carry `peerRead`                              | Implemented; not runtime-verified on dev |
| Party places in threads (T-D, D-065, D-152) | `thread_places`, and `conversation_members.place_hidden` (migration 0080) | `THREAD_USE_CASES`: `places` (read), `setPlace`, `setPlaceHidden` | Implemented; not runtime-verified |
| Call it together in threads (T-E, D-155 to D-157) | `thread_calls` (migration 0083) | `THREAD_USE_CASES`: `calls` (read), `lockCall` | Implemented; not runtime-verified |
| Challenge a friend in a direct conversation (S-9, D-245) | `messages.challenge_stop` (migration 0090); each person's pick is a `thread_calls` row keyed by the direct conversation | `CONVERSATION_USE_CASES`: `conversations.send` (a content card with `challenge: { stopId }`), `conversations.lockChallenge`; the card comes back on the messages of `read`, `history` and `changes` | Implemented; not runtime-verified |
| Visibility, availability and visits              | `visibility_settings`, `visibility_audience`, `presence`, `visit_publications`, `visit_systems`, `visit_planets`                                                       | `VISIBILITY_USE_CASES`: read and set visibility, read and set the availability choice, read a visit; `RECORD_HEARTBEAT`; `REFRESH_VISIT_PUBLICATION` | Implemented                              |

Idea rooms (`modules/rooms`) read people and friends through two public ports here, `READ_PUBLIC_PEOPLE` (claimed
profiles of active accounts, by account or public person ID) and `READ_FRIEND_ACCOUNTS` (the caller's current friends), `READ_BLOCKED_AMONG` (which of some accounts the caller has blocked, never who blocked the caller),
and `READ_REPORTABLE_MESSAGE` (a conversation or thread message the caller still takes part in, with its author's account, for a report: D-055),
and reuse `snippetCard`, the rule that turns a stored snippet anchor into a card. They never read conversations or
threads, and friend threads never reach a room (D-051).

Dependency direction: `domain/` (pure rules and cursors) <- `application/` (use cases over ports) <-
`adapters/` (PostgreSQL, Nest providers, erasure). Other modules and the API import only `public.ts`.
Content metadata for cards comes from the Content module's `READ_SHAREABLE_CONTENT` and
`READ_PUBLIC_CONTENT` (never its tables), and the systems and planets a person can share from Geography's
`READ_GEOGRAPHY_SCENE_INPUT`. Threads also use Content's `READ_CONTENT_SEQUENCE`, `VALIDATE_SNIPPET_ANCHOR` and
`RESOLVE_SNIPPET_ANCHOR`, Content's `READ_SCROLL_PLAY_FACTS` (a call's words and answer), Identity's `FENCE_PERSONAL_RECORDING` and Experience's `READ_VISITED_ASSETS`. The module has no queue of its own: the worker calls
`REFRESH_VISIT_PUBLICATION` after each scene projection (see "Visibility, availability and the friend visit").

## Friends

A person claims a handle (3 to 24 lowercase ASCII characters, with single inner dots or underscores) and a
display name. Revision 0 of a profile means unclaimed. Anyone can look up an exact handle. Lookup, request
and pair reads never say whether a hidden, blocked or unknown person exists: all give one coarse answer.

- A request lasts seven days. A reciprocal request does not accept. Decline changes only the decliner's view.
- Remove ends the friendship for both people. Block ends it and refuses new requests; unblock restores nothing.
- `pairRevision` is one person's view of the friendship. It is not the private aggregate revision, which never
  leaves the server.
- Receipts are immutable outcomes. They record that a command was accepted. They are not current access, so
  every replay first checks the current accounts, epochs and friendship.

Rosters (`POST /v1/social/friends/page`, `/requests/page`) list friends, blocked people, and incoming and
outgoing requests, newest first. Each page reads at most 250 candidates by stable public person ID and
hydrates current profiles. An empty page can still have a next page. The cursor is a plain keyset record: the
filter, the limit, the account, universe and epoch it was made for, the roster head revision, the last person
and the traversal time bounds. It is not signed or encrypted, so it survives a restart and works across
instances. A wrong account, filter, limit or a changed head makes it `SHARING_UNAVAILABLE`, and the client
starts a fresh traversal.

Invitations: one active link per person, a 32-byte `ksfi_` token, only its SHA-256 stored, seven days. The
token is returned once, with the first answer. A lost answer means revoke, then a new command. Resolving or
requesting by invite rechecks the issuer, token and expiry. A link never accepts a friendship by itself.

## Conversations

Two people who are friends can talk. A conversation is tied to the friendship's lineage, so Remove and
Block end it for both people without saying why.

- **Messages** are text (up to the contract limit) or a card for an exact asset revision with an optional note.
  A withdrawn or unavailable asset cannot be sent. Messages are append-only. Account deletion turns a
  person's messages into tombstones.
- **Send is idempotent.** The caller's command ID with the same body replays the first answer. A different
  body under the same ID is refused. A client that lost the answer retries with the same ID, or reads the
  command's outcome with `send/read`.
- **Order.** Each message has a `sequence` (history order) and a `change_sequence` (for catching up). Both
  counters grow by `+1` in SQL, so account deletion can add tombstones without the friendship lock.
- **Read state is the member's own, and SEEN is the one way it is shared** (D-066, D-150). `read_through_sequence`
  belongs to its member and always moves, for their own unread dot. A direct conversation tells the other person how
  far they have read only through `peerRead`, below, which comes from a second position, `shared_read_through_sequence`. Nobody is ever told a person is typing. Mute is private.
- **SEEN** (`application/seen.ts`, rule in `domain/conversations.ts`: `visiblePeerRead`). A snapshot and a changes page
  carry `peerRead { throughSequence }` only while both people share (a switch on the person's settings row, on by
  default) and the conversation stands. The number is the other person's `shared_read_through_sequence`: how far they
  read while their own switch was on. It moves in the same statement as `read_through_sequence` and only while the
  switch is on, so it is never ahead of it, and what a person reads while SEEN is off is never shown, even after they
  turn it on again (they must read something new while it is on). In every other case the field is absent: the other person
  hides theirs, the reader hides their own, either person left, the other account is gone. The absence gives no
  reason (a person who expects a read and sees none can guess the other hid theirs: that is what mutual means); a blocked pair gets `unavailable` as for any read. Both switches are read under the pair
  lock on each read, so a change shows at the other person's next read. A read writes nothing. A `mark read` that
  moves the shared position also bumps the other person's inbox head (a disposable hint), only while both share and
  the conversation stands (`planReadMove`). It is a
  position, never a time: the app draws the sent time with the word. Threads and rooms have no such field.
- **Replies** (D-146). `replyTo` on a send names a message of the same conversation; a message of another
  conversation, an unknown ID and a tombstone are all `unavailable`, and nothing is written. The reply stores the
  original's sequence (a composite foreign key keeps it inside the conversation). A page of messages carries
  each reply's quote (`replyTo`: the original's author and first words, or `unavailable` once it was removed),
  read when the page is built.
- **Reactions** (D-147, D-148). Five fixed kinds (`spark`, `mind_blown`, `ha`, `heart`, `question`); one row per
  person, kind and message, so adding and removing are idempotent. `react` states the wanted state (`present`):
  a repeat is accepted and changes nothing, even under a new command ID. A change gives the message the
  conversation's next change number, so the changes feed carries it again with its reactions, and both inboxes
  hear a hint. It moves neither the message sequence nor the conversation's activity time. A page shows each kind
  once with the people behind it and whether the reader is one of them; people the reader blocked are left out. The people
  are ordered by display name and then person ID, never by when they reacted: no order of reacting is carried (D-147).
- **Leave** closes the conversation for both. The other person keeps the history, sees that it ended
  (`ended: true`) and cannot send.
- **A conversation shows in Talk once it has a message.** `start` alone does not announce.
- **The inbox reads consistently.** It lists conversations in one statement, then reads each one's last message by
  the exact (conversation, sequence) pair that statement returned, so a message that commits in between can never
  make a row say "N messages" and show message N+1. A cursor with a time no date can hold is treated as no cursor.
- **Cursors** for the inbox (`kci1_`), history (`kch1_`) and changes (`kcc1_`) are base64url of a version, a
  number and an ID. They are positions only. Every read checks that the caller is a member.
- **Deleted person.** When the other account is deleted, the friendship row goes and `conversations.pair_id`
  becomes null (`on delete set null`). The survivor reads the closed conversation through their own scope,
  with no friendship lock, and sees `DELETED_PERSON` (label `DELETED_ACCOUNT_LABEL`, D-043). Their receipts are
  personal ones.

### Lock order

Personal root first (`withPersonalScope`), then the account fences (`fencePair`: own account and the
peer's account in SHARE mode), then the one shared root (the friendship row), then the conversation rows.
`inbox_heads` rows are bumped in canonical account order inside the friendship lock. Shared receipts are keyed
by (`social_pair`, pair, actor, operation, command ID). A deleted-counterpart conversation takes only
`fenceOwn` and personal receipts.

### Live updates

A committed send or leave bumps `inbox_heads.revision` for each member, and a read that moves bumps it for the reader and,
while SEEN is mutual, the other person (a person who hides theirs tells nobody). It calls
`notifyInboxChanged` in the same transaction. The payload is `{ v: 1, scope: { kind: 'inbox', id: <universeId> },
revision, eventId }`. The socket subscribes with the caller's own universe ID and its ack carries the current
head. A hint is disposable: the client then reads `conversations/changes` from its cursor, so a missed or
late hint loses nothing. Talk also polls every 30 seconds and on focus.

## Share links

A link names an exact asset revision and has one audience: public (anyone with the link sees public
metadata) or one conversation (only its members). The token is `kssh_` plus 43 base64url characters. Only its
SHA-256 is stored. It is returned once, with the first answer of the command (`delivery: available`); an
identical retry gives `delivery: unavailable`. A link lasts 30 days (`SHARE_LIFETIME_MS`) and can be revoked.

Reading a link:

- `POST /v1/social/content-shares/resolve` (signed in) returns public metadata, or the conversation reference
  for a member.
- `POST /s/preview` (no sign-in) returns public metadata of public links only.
- `GET /s/:token` is the landing page, rendered by the API (see `apps/api/README.md`).

Unknown, malformed, revoked, expired, withdrawn and private-to-a-stranger links all give one unavailable
answer. It never names who shared the link. A corrected asset (a newer revision) says so and offers the
revised one. Opening a link is not consumption.

## Content threads

A thread brings one Reel or Scroll and the conversation about it onto one surface (blueprint §17, C04). It is
a conversation of kind `thread` with a root (an exact asset revision), a starter and up to eight invited friends.
Decisions are in D-046. Nothing here is consumption evidence: creating, inviting, sending, opening a snippet and
reading a thread add no exposure, observation or Keep.

- **Create** (`threads/create`) takes one to eight current friends, a root that is the current admitted revision, and
  an optional name. One failing friend makes the whole command `unavailable`, without saying which. The thread's ID
  is derived from the starter and the command, so a retry finds the same thread and its receipt. A refused create
  writes nothing.
- **Invitations.** A friend gets a pending membership with the lineage of the friendship that carried it. Until they
  answer (`threads/respond`: join or decline) they can read only the invitation: who asked and what it is about.
  Joining shows the whole history. Until then the row is dated and ordered by when the thread began, so it never
  shows when the others last talked. Declining ends the invitation.
- **Whose place stands.** An invited member keeps access while that friendship's lineage is unchanged. Remove, Block
  (either side) or a new friendship end it; every refusal looks the same. When the person who invited them leaves
  or deletes their account, those whose friendship still stands keep their place on their own membership, and anyone
  whose place had already ended stays out (`invitee-links.ts` closes it rather than letting the unlinking revive it).
  Leaving ends the leaver's place only.
- **Messages** are text or a snippet. Sequences, change sequences, cursors (`kch1_`, `kcc1_`), tombstones and the
  catch-up read are the direct conversation's, over the same rows. Send, react, respond, mark read and leave use shared
  receipts keyed by the thread, so Clear does not forget them. Replies and reactions work as in a direct
  conversation (see there): a reply names a message of the same thread, a reaction changes only its message, and
  every participant's inbox hears a hint. In a thread a person the reader blocked may still be a member, and their
  words stay as they are (D-046); their reactions are left out of what the reader sees (D-147).
- **Snippets** (`message_snippets`, one row per snippet message) are anchors into the thread's own sequence, checked
  against the exact current revision: a Reel range of at least one second inside the duration; a passage with a
  stable block, a range on character boundaries and the hash of the quote; a block with its id, type, version and
  an optional settings snapshot (a value the sender typed themselves needs `confirmPersonal`). The quote, the block
  label and the settings in words are copied when stored and shown only while the content is not withdrawn.
  `threads/snippets/open` asks Content where the snippet leads now: the same anchor, a Scroll anchor moved through
  the anchor map (`mapped`), or `changed` (a corrected Reel, or a passage that is gone). It never plays an old range.
  Both reads are gated (`adapters/snippet-audience.ts`): a snippet that names a Scroll made for another thread (D-049)
  is `unavailable` to anyone outside that thread, so a snippet cannot be used to quote it.
- **Episodes** in a thread view are the declared series that contains the root revision, by part, or the root alone.
  Each carries the caller's own `visited` (an activated exposure of that asset) and says `corrected` or `unavailable`
  when it is. No answer has any field for another member's position, current episode or seen marker; the only thing a
  member may tell the thread is a coarse place, and it has its own read (see Party places).
- **Direct inbox.** A thread never appears in the direct inbox: every direct read selects `kind = 'direct'`.
- **Talk** lists a person's threads (`threads/inbox`, newest activity first, at most 50). An invitation shows who
  asked and no message or count.

### What other modules may do inside a thread (#244, D-049)

The `scenarios` module (and later idea rooms) acts in a thread only through `THREAD_GUEST` (`application/thread-guest.ts`):
`enter` and `enterAsMember` (the same membership and lineage checks a member's own command makes, then the thread's
lock), `window` (the last messages, bounded, with the author reduced to "you" or "member"), `receipts` (find, begin,
complete, keyed by the thread, so Clear does not forget them) and `announce` (the inbox hint). `READ_THREAD_STANDING` is a
lock-free read of whether an account takes part now, for workers and audience checks that recheck before applying a result, on the connection they name (`ReadOn`);
`ANNOUNCE_THREAD` tells every participant's inbox after a commit. None of them decides who may take part: that stays here.
_Implemented._

### Lock order

Personal root, then the caller's own account gate (`fenceOwn`), then the thread's root (`social_thread`: the
conversation row, FOR UPDATE for commands and FOR SHARE for reads), then its members, messages and snippet rows.
Counters are atomic SQL increments. Inbox heads are bumped in account order, only for members whose place stands and
whose account is active. Account deletion takes the person's thread rows first, in id order, then everything else.

### Live updates

A committed send, join, leave or read bumps `inbox_heads` for each member whose place stands and calls
`notifyInboxChanged`, as direct conversations do. The thread screen catches up from its cursor on a hint, a focus or
its 20 second poll, so a lost hint loses nothing.

## Party places (T-D, D-065, D-152, D-153)

In a series thread each member may tell the others which part they are on. A place is a part, `on` or `finished`, and
a day. It is the one thing about where a member is in a series that the server holds, and it is coarse on purpose:
there is no column for a playhead, a branch, a selected episode, a seen marker or a time of day, and `day` is a
`date`. It is not consumption evidence: nothing here writes Experience, Composer, Planning or Geography, and nothing
here reads another member's Experience. _Implemented; not runtime-verified._

- **Write** (`threads/places/set`, `setPlace`). Only the caller's own row, from their own client: the command has no
  field for whose place it is. The part must be one of the series' parts (`invalid_input` otherwise, and for a thread on
  a single item). A place only moves forward (on a part, finished it, on the next), so a repeat or an earlier part
  changes nothing, not even the stored day. The day is the server's own UTC date. A change tells every taking-part
  member's inbox (a disposable hint carrying nothing, kept nowhere); a repeat tells nobody. **No receipt is written**
  for it or for hide (`inThreadWithoutReceipt` in `thread-command-frame.ts`): both are idempotent by their state, a
  receipt would keep the exact time of every report and survive leave and Clear, and so neither command has a command
  ID, a replay or a time in its answer. A test finds no receipt row and no clock time in any table after set, hide,
  leave and Clear.
- **Hide** (`threads/places/hide`, `setPlaceHidden`). "Hide where I am", per thread and per person, on the member's own
  row. Places are shown by default, so it is off until the person turns it on. Turning it on deletes their place in the
  same transaction. While it is on, `setPlace` is accepted, says `hidden` and writes nothing. Turning it off writes
  nothing: the place comes back with the person's next report. It is a wanted state, so a repeat changes nothing, and it
  is not mutual.
- **Read** (`threads/places/read`, `places`). Its own read, so the thread view and the thread list keep no place field.
  Under the thread's lock it lists a member only when they take part now, have not hidden, and neither side of a block
  with the reader exists. A member with no place, who hides, left, was removed or is blocked is simply not listed, and
  nothing says which. Order is by how far along and then by name, never by arrival. The reader's own place carries
  `you`. A stranger, an invitee who has not joined, a leaver and a stale membership reference get `unavailable`.
- **Removed** on leave (`thread-commands.ts` deletes it before ending the place), when the friendship that carried a
  member in ends (`forgetPlacesBetween` in the pair command, under the friendship's lock, for Remove, Block and Accept),
  when an inviter leaves and their invitees' places had already ended (`releaseInvitees`), on Clear (the places are
  deleted, "hide where I am" is kept: it is a choice, not history) and on account deletion (before the membership rows,
  because the row follows its member's).
- **Lock order** is the thread's: personal root, the caller's account gate, the thread's conversation row (FOR UPDATE to
  write, FOR SHARE to read), then the member and place rows. The pair command deletes places without the thread lock;
  a place is only ever shown through the standing check, so a row that outlives a race is never visible.
- **Export.** The person's own places (thread name, part, state, day) and how many threads they hide in, never anyone else.

## Challenge a friend (S-9, D-244, D-245)

A content card in a direct conversation can name one call of its exact Scroll revision (its Final call, else its first Call it). Each of the two people locks their own pick; nobody sees the other's pick or the right answer before they have locked theirs, and the same rule shows both once both have.

- **Send** (`conversations/send`). The body is a content card plus `challenge: { stopId }`. The stop must be a call of that revision (`READ_SCROLL_PLAY_FACTS`), or the send is `invalid_input`. No pick travels with it. It is an ordinary message: receipt, inbox hints, no evidence for anyone.
- **Lock** (`conversations/challenge/lock`, `lockChallenge`, `application/challenge-lock.ts`). Authority: the caller's personal scope, then the friendship's lock; the conversation must be open to the caller and the message must be a challenge of it that still stands, or the answer is `unavailable` (a stranger, a person who left, a blocked pair, another conversation and a plain card are the same). Recording must be on and the generation current (D-083), or nothing is stored and the answer says why. The first lock stands; a repeat answers `stands`. No receipt (D-156). A pick that reveals (the friend has already called) gives the message a fresh change number and tells both inboxes; a pick made before the friend has called moves nothing on the friend's side, so the wire never says whether the friend has called.
- **The card** (`application/challenge-cards.ts`, `domain/challenges.ts`). Built on every read from the immutable revision and the two people's pick rows: `open`, `locked` (own pick only) or `revealed` (both picks, the answer, why, and the twist after a wrong pick). A read writes nothing and works while recording is paused.
- **Stored.** `messages.challenge_stop` and the pick rows of `thread_calls` (keyed by the conversation, revision and stop, so one set of picks per call per conversation). Never whether a pick was right.
- **Removal.** Clear and account deletion erase the person's picks (`erasePicks`); a deleted sender's message becomes a tombstone and clears `challenge_stop`; the export lists the person's own pick in words with `challengeFromConversation`.
- Covered by `social-challenges.test.ts` (real PostgreSQL), `domain/challenges.test.ts` and the wall tests below. _Implemented; not runtime-verified on dev._

## Call it together (T-E, D-155 to D-157)

Before a part whose Scroll has an authored question, each member of a series thread locks a pick, and nobody sees
another's pick until they have locked their own and the party has finished the part. A pick is a play result (D-063):
it is shown to the thread's members after the reveal and to the person in their export, and nothing reads it for
ranking, planning, evidence, formation or the Composer. It is stored here, and not in `play`, because it needs the
thread's lock, the member's standing, the places that decide the reveal and the blocks between members (D-156).
No model is called. _Implemented; not runtime-verified._

- **The call of a part** is the first Call it of the part's Scroll (`threadCallOf`), found through Content's
  `READ_CONTENT_SEQUENCE` and `READ_SCROLL_PLAY_FACTS`. A Reel, a Scroll without a call and a single-item thread have none.
  It is about the revision the thread's members locked on, and only when none did, about the series' current revision
  (`callRevisionCandidates`, D-233), so a new revision of a Scroll never takes a pick away: the card keeps that question,
  and says `updated: 'held'` so the person is told. If the revision the picks are on can no longer be read, the card asks
  the current question afresh and says `updated: 'restarted'`. Only the locks the reader may count choose the revision
  (`presentMembers`), so a block never moves which question a reader is shown.
- **Read** (`threads/calls/read`, `calls`). Under the thread's lock (FOR SHARE): one call per part that has one, in
  the stage this reader may see (`open`, `locked`, `revealed`, `closed`). The stage decides what the answer can carry:
  counts only before the reader locks, their own pick after, and everyone's picks, the right answer, why, and, for a member
  whose pick was the Scroll's authored common guess, its reviewed source (D-157), only at the reveal. A stranger, a leaver and
  a stale reference get `unavailable`. It works while recording is paused. The one thing a read may write (and a lock
  that ends as "stands" or "closed" may too) is that a call first revealed for the thread, once, as a row in
  `thread_call_reveals` with no day, no person and no pick.
- **Lock** (`threads/calls/lock`, `lockCall`). Authority: the caller's personal scope, the thread's lock, and
  `FENCE_PERSONAL_RECORDING` with the generation the client sends (paused or stale: nothing is stored and the answer says
  why, D-083). The part must have a call and the option must be one of its options (`invalid_input` otherwise). The first
  lock stands; a pick for a revision the call is no longer about answers `changed` and stores nothing (the command carries the
  `assetRevision` of the card, D-233); a repeat or another pick answers `stands`; a call that is revealed, or on a part the caller's own place says
  they started, answers `closed`. The command carries no correctness and no stop, and keeps no receipt: it is idempotent by
  its key and a receipt would keep the time of the lock (D-156). A new lock tells every taking-part member's inbox (a
  disposable hint carrying nothing).
- **The rules** are pure, in `domain/calls.ts` (`viewCall`): the reveal opens when every member the reader can see who
  shares a place has finished the part, or on the second UTC day after the first lock (`REVEAL_AFTER_DAYS`), and never
  waits for a pick (D-155). `revealedForThread` is the same rule with nobody masked: the first time it holds, that is
  recorded, and from then on the call stays revealed whoever leaves, clears or joins, for a reader with no block (either
  way) with a member who takes part; a reader with one keeps the live rule, which leaves the blocked member out, so the
  blocked member's lock or finish never moves their card (D-155). Nothing counts picks across threads (D-157).
- **Stored** as one `thread_calls` row per member and call: the option and a UTC `date`. Never whether it was right
  (worked out from the immutable revision when a reveal is built), never a time of day. `thread_call_reveals` holds, per
  thread and call that has revealed, a row and nothing else: no day, no person, no pick. It has a foreign key to the thread
  and is declared in the erasure registry as kept with the thread.
- **Removed** on leave (`thread-commands.ts`), when the friendship that carried a member in ends (`forgetPartyBetween`),
  when an inviter leaves and their invitees' standing had ended (`releaseInvitees`), on Clear and on account deletion
  (before the membership rows). A block hides a member's pick, count and progress from the blocker and the blocked and does not
  hold either reveal; it deletes nothing.
- **The wall.** `thread-pick-wall-only-listed-modules-import-social` (an allow-list of who may import this module),
  `wall.test.ts` (no file outside this module names `social.thread_calls`, and no migration but this module's own or
  operations script names it in SQL), and the integration check that a lock, a
  reveal, a read, a leave and an export change no table outside Social.
- **Export.** The person's own picks in words (thread name, the question, the option picked, the day), never whether they
  were right and never another member's pick.

## Visibility, availability and the friend visit

A person decides what friends may see (F02, D-047). Everything starts off: nobody may visit, no system is
shared and availability is hidden; SEEN in direct conversations starts on (D-066). No row means the defaults, so
reading the settings writes nothing.

- **Who may visit.** The audience is `nobody`, `chosen_friends` or `all_friends`. The chosen friends are rows
  that only mean something while the two are friends: accepting, removing or blocking deletes the rows between
  the two people under the friendship's lock, so an old choice never returns with a new friendship. A chosen
  list with nobody in it reads as `nobody`.
- **What they see.** The owner chooses factual systems. A visitor gets each chosen system with its factual
  planets, as names under random public IDs: never stars, regions, routes, hypothetical places, activity,
  positions, a count of what is hidden, or anything about reading. An ID stays while its place stays shared
  and is new when it is shared again. Lists are sorted by label, so order carries no chronology.
- **The published copy.** A visitor's request never enters the owner's personal root. `visibility.set` draws
  the copy from the owner's own Geography (`visit_publications`, `visit_systems`, `visit_planets`) in the same
  transaction as the settings. After each scene projection the worker calls `REFRESH_VISIT_PUBLICATION` for the
  universe: a system actor in its own transaction that rechecks the universe and epoch, does nothing for a
  universe that shares nothing and writes nothing when the list is unchanged. `projection_token` is random and
  changes only when a visitor would see a difference; it counts nothing.
- **The visit read** (`POST /v1/social/visits/read`) runs in the visitor's own scope: own account fence and the
  host's account fence, the friendship's lock, both sides `friends` and neither blocking, the host's audience,
  then the copy. Every refusal is the same `unavailable` answer: never shared, revoked, an ended friendship, a
  block, an unknown person, yourself. The answer's authority is the visitor's pair revision and the copy's
  token; the owner's settings revision never leaves the owner. A visit writes nothing, tells the owner nothing
  and is not evidence for either person.
- **Availability.** The app sends `presence_heartbeat` over the socket every 20 s while connected and visible;
  the gateway checks the session and the caller's own scope again and answers `{ ok: true }` whatever the
  setting. `recordHeartbeat` is one statement stamped with the database clock: it stores the time only for an
  active account whose preference is not `hidden`, and starts a new window after 15 minutes of silence with a
  new random `window_token`, the answer's `expiryRevision`, which counts nothing. Setting `hidden` deletes the row. A friends page and a pair read turn the stored age (measured by the database) into a word
  (`domain/presence.ts`): "Online" for 60 s, then "Recently active" until 15 minutes, never above the person's
  choice, with a constant lease (30 s or 60 s) that never reveals the last beat. Hidden, expired and unknown are
  one `unknown` answer. There is no push: friends reread while Friends is open.

- **SEEN switch** (`read-receipts.set`, `GET/POST /v1/social/read-receipts`). A wanted state, with its own revision on the
  same settings row: a repeat is accepted with no change and no new revision, and turning it off or on touches no
  conversation, read position or other setting. Nobody is told: the other person's screen follows at its next read.

Commands (`visibility.set`, `presence.preference.set`, `read-receipts.set`) use personal receipts, expect the revision the client
read (`stale_revision` otherwise) and replay the same ID and body. Choosing a friend who is not a friend now
(or yourself), or a system that is not the caller's own factual system, is `invalid_input` and changes nothing.

Status: implemented with tests against real PostgreSQL (`tests/integration/modules/social-visibility.test.ts`)
and the installed API (`tests/integration/release/visits-http.test.ts`). Not runtime-verified on dev.

## Erasure and export

| Store                                                                             | Exploration Clear                                            | Account deletion                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| profiles, pairs, requests, rosters, invites, bindings                             | kept                                                         | deleted; roster heads of former friends are bumped first                                                                                                                                                                                |
| conversations, members, inbox heads                                               | kept                                                         | a direct conversation is closed; a thread goes on for the others. The person's rows are deleted and the peers' inbox heads bumped (hint); invitees whose friendship stood keep their place on their own membership, the others stay out |
| messages                                                                          | kept                                                         | the person's messages become tombstones with new change sequences and no reply pointer                                                                                                                                                  |
| message_reactions                                                                 | kept                                                         | the person's reactions and every reaction on their messages are deleted; each message of another person that loses one gets a new change sequence, so the others' catch-up replaces it                                                  |
| content_shares                                                                    | kept                                                         | deleted                                                                                                                                                                                                                                 |
| content_threads                                                                   | kept                                                         | the starter link is cleared; the thread stays for the others                                                                                                                                                                            |
| thread_places | **deleted** (a place is drawn from the person's own exploring) | deleted with the account, before the membership rows |
| thread_calls | **deleted** (a pick is a play result, D-082) | deleted with the account, before the membership rows |
| thread_call_reveals | kept (thread state: no person, no pick, no day) | kept with the thread |
| message_snippets                                                                  | kept                                                         | deleted with the author's tombstoned message                                                                                                                                                                                            |
| visibility_settings (audience, availability, SEEN), visibility_audience, presence | kept (choices and a lapsing signal, not exploration history) | deleted; the chosen-friend rows naming the account on either side too. The export names the SEEN switch in words (`seenInDirectConversations`) and never the other person's                                                             |
| visit_publications, visit_systems, visit_planets                                  | deleted (friends who visit then see an empty universe)       | deleted with the universe                                                                                                                                                                                                               |

Clear never removes messages, cards, snippets, reactions, threads or links, but it deletes the person's party places (`erasePlaces`) and picks on thread calls (`erasePicks`). `eraseAccount` order: take the person's thread rows (id order), delete the person's links, delete the snippet rows of their messages, erase their reactions (`eraseReactions`), delete their party places (`erasePlaces`) and their picks on thread calls (`erasePicks`), tombstone
their messages, pick the peers, close conversations, delete their membership and heads, hint the peers, then
the friendship rows. The export (`socialErasure.export`) holds the profile, counts of connections, the
invitation state, the conversation count and the person's own words (newest 2,000, with `truncated`; a reply is marked `wasAReply`), their own reactions (kind, when, and whether on their own message or someone else's; newest 2,000, with `reactionsGiven` and `reactionsTruncated`) and
their shared links without tokens, how many threads they are in and started (with the names they gave), and in
words who may visit, how many friends they chose, how they show as available, whether SEEN is on and the titles of
the systems they share (never a heartbeat, a public ID or who the friends are). It names no other person.

## Failure and recovery

- A lost response: retry with the same command ID.
- A lost hint: the next hint, a focus, or the 30 second poll reads `changes` from the cursor.
- A stale friendship view: the command is refused as stale and the client rereads the pair.
- A stale settings page: `visibility.set`, `presence.preference.set` and `read-receipts.set` answer `stale_revision`, and the page
  rereads and shows what the server holds.
- A lost heartbeat: availability lapses by itself within a minute; nothing keeps someone "Online".
- A failed refresh: the job retries; the visitors keep the last copy, and the next successful projection or the
  owner's next change redraws it.

## Related

- Blueprint 02d sections 14 and 17; decisions D-049 (what other modules may do in a thread), D-042 (conversations and links), D-043 (deleted accounts), D-046
  (threads and snippets), D-047 (sharing and visibility, availability, the friend visit), D-066 and D-150 (SEEN), D-065, D-152 and D-153 (party places), D-155 to D-157 (Call it together).
- Contracts: `packages/contracts/src/sharing.ts`, `conversations.ts`, `threads.ts`, `content-shares.ts`,
  `friend-pages.ts`, `socket.ts` (`presence_heartbeat`).
- Tests: `tests/integration/modules/social-*.test.ts` (threads: `social-threads`, `social-thread-snippets`; SEEN: `social-seen`; party places: `social-places`; Call it together: `social-calls`),
  `tests/integration/release/conversations-http.test.ts`, `threads-http.test.ts`, `visits-http.test.ts`.
