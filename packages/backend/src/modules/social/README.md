# Social: friends, conversations and share links

People find each other by handle, become friends, send each other a Reel or Scroll and talk about it.
A link to a Reel or Scroll can also be shared outside the app. A person can let friends visit their universe
and see whether they are around. Nothing here is consumption evidence: sending, receiving or opening a shared
card, visiting a universe and being shown as online never create an exposure, an observation or a Keep.

Status marks: **implemented** means merged with tests against real PostgreSQL. **Runtime-verified**
means used on a running dev system. Nothing in this module is runtime-verified yet.

## What the module owns

| Area | Tables (schema `social`) | Use cases (`public.ts`) | Status |
| --- | --- | --- | --- |
| Profiles and friendship | `profiles`, `pairs`, `pair_sides`, `requests`, `command_bindings` | `SOCIAL_USE_CASES`: profile, lookup, pair read, request, accept, decline, cancel, remove, block, unblock | Implemented |
| Rosters and invitations | `roster_entries`, `roster_heads`, `invites` | `SOCIAL_USE_CASES`: friend and request pages, invite create, revoke, status, resolve | Implemented |
| Conversations | `conversations`, `conversation_members`, `messages`, `inbox_heads` | `CONVERSATION_USE_CASES.conversations`: start, inbox, read, history, changes, send, read of a send, mark read, mute, leave | Implemented |
| Share links | `content_shares` | `CONVERSATION_USE_CASES.shares`: create, revoke, read own, list own, resolve, public preview | Implemented |
| Visibility, availability and visits | `visibility_settings`, `visibility_audience`, `presence`, `visit_publications`, `visit_systems`, `visit_planets` | `VISIBILITY_USE_CASES`: read and set visibility, read and set the availability choice, read a visit; `RECORD_HEARTBEAT`; `REFRESH_VISIT_PUBLICATION` | Implemented |

Dependency direction: `domain/` (pure rules and cursors) <- `application/` (use cases over ports) <-
`adapters/` (PostgreSQL, Nest providers, erasure). Other modules and the API import only `public.ts`.
Content metadata for cards comes from the Content module's `READ_SHAREABLE_CONTENT` and
`READ_PUBLIC_CONTENT`, and the systems and planets a person can share from Geography's
`READ_GEOGRAPHY_SCENE_INPUT` (never their tables). The module has no queue of its own: the worker calls
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
- **Read state is private.** `read_through_sequence` belongs to its member. The other person never sees it, nor
  a typing signal. Mute is also private.
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

A committed send, read or leave bumps `inbox_heads.revision` for each member and calls
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

## Visibility, availability and the friend visit

A person decides what friends may see (F02, D-047). Everything starts off: nobody may visit, no system is
shared and availability is hidden. No row means the defaults, so reading the settings writes nothing.

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
  universe that shares nothing and writes nothing when the list is unchanged. `projection_revision` moves only
  when a visitor would see a difference.
- **The visit read** (`POST /v1/social/visits/read`) runs in the visitor's own scope: own account fence and the
  host's account fence, the friendship's lock, both sides `friends` and neither blocking, the host's audience,
  then the copy. Every refusal is the same `unavailable` answer: never shared, revoked, an ended friendship, a
  block, an unknown person, yourself. The answer's authority is the visitor's pair revision and the copy's
  revision; the owner's settings revision never leaves the owner. A visit writes nothing, tells the owner nothing
  and is not evidence for either person.
- **Availability.** The app sends `presence_heartbeat` over the socket every 20 s while connected and visible;
  the gateway checks the session and the caller's own scope again and answers `{ ok: true }` whatever the
  setting. `recordHeartbeat` is one statement: it stores the time only for an active account whose preference is
  not `hidden`, and starts a new window (`window_number`, the answer's `expiryRevision`) after 15 minutes of
  silence. Setting `hidden` deletes the row. A friends page and a pair read turn the stored time into a word
  (`domain/presence.ts`): "Online" for 60 s, then "Recently active" until 15 minutes, never above the person's
  choice, with a constant lease (30 s or 60 s) that never reveals the last beat. Hidden, expired and unknown are
  one `unknown` answer. There is no push: friends reread while Friends is open.

Commands (`visibility.set`, `presence.preference.set`) use personal receipts, expect the revision the client
read (`stale_revision` otherwise) and replay the same ID and body. Choosing a friend who is not a friend now,
or a system that is not the caller's own factual system, is `invalid_input` and changes nothing.

Status: implemented with tests against real PostgreSQL (`tests/integration/modules/social-visibility.test.ts`)
and the installed API (`tests/integration/release/visits-http.test.ts`). Not runtime-verified on dev.

## Erasure and export

| Store | Exploration Clear | Account deletion |
| --- | --- | --- |
| profiles, pairs, requests, rosters, invites, bindings | kept | deleted; roster heads of former friends are bumped first |
| conversations, members, inbox heads | kept | closed; the person's rows deleted; peers' inbox heads bumped (hint) |
| messages | kept | the person's messages become tombstones with new change sequences |
| content_shares | kept | deleted |
| visibility_settings, visibility_audience, presence | kept (choices and a lapsing signal, not exploration history) | deleted; the chosen-friend rows naming the account on either side too |
| visit_publications, visit_systems, visit_planets | deleted (friends who visit then see an empty universe) | deleted with the universe |

Clear never removes messages, cards or links. `eraseAccount` order: delete the person's links, tombstone
their messages, pick the peers, close conversations, delete their membership and heads, hint the peers, then
the friendship rows. The export (`socialErasure.export`) holds the profile, counts of connections, the
invitation state, the conversation count and the person's own words (newest 2,000, with `truncated`) and
their shared links without tokens, and in words who may visit, how many friends they chose, how they show as
available and the titles of the systems they share (never a heartbeat, a public ID or who the friends are). It
names no other person.

## Failure and recovery

- A lost response: retry with the same command ID.
- A lost hint: the next hint, a focus, or the 30 second poll reads `changes` from the cursor.
- A stale friendship view: the command is refused as stale and the client rereads the pair.
- A stale settings page: `visibility.set` and `presence.preference.set` answer `stale_revision`, and the page
  rereads and shows what the server holds.
- A lost heartbeat: availability lapses by itself within a minute; nothing keeps someone "Online".
- A failed refresh: the job retries; the visitors keep the last copy, and the next successful projection or the
  owner's next change redraws it.

## Related

- Blueprint 02d sections 14 and 17; decisions D-042 (conversations and links), D-043 (deleted accounts), D-047
  (sharing and visibility, availability, the friend visit).
- Contracts: `packages/contracts/src/sharing.ts`, `conversations.ts`, `content-shares.ts`, `friend-pages.ts`,
  `socket.ts` (`presence_heartbeat`).
- Tests: `tests/integration/modules/social-*.test.ts`, `tests/integration/release/conversations-http.test.ts`,
  `tests/integration/release/visits-http.test.ts`.
