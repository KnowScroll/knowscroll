# Social: friends, conversations, threads and share links

People find each other by handle, become friends, send each other a Reel or Scroll and talk about it.
Several friends can explore one Reel or Scroll together in a content thread, and point each other at an exact moment, passage or block.
A link to a Reel or Scroll can also be shared outside the app. Nothing here is consumption evidence:
sending, receiving or opening a shared card never creates an exposure, an observation or a Keep.

Status marks: **implemented** means merged with tests against real PostgreSQL. **Runtime-verified**
means used on a running dev system. Nothing in this module is runtime-verified yet.

## What the module owns

| Area | Tables (schema `social`) | Use cases (`public.ts`) | Status |
| --- | --- | --- | --- |
| Profiles and friendship | `profiles`, `pairs`, `pair_sides`, `requests`, `command_bindings` | `SOCIAL_USE_CASES`: profile, lookup, pair read, request, accept, decline, cancel, remove, block, unblock | Implemented |
| Rosters and invitations | `roster_entries`, `roster_heads`, `invites` | `SOCIAL_USE_CASES`: friend and request pages, invite create, revoke, status, resolve | Implemented |
| Conversations | `conversations`, `conversation_members`, `messages`, `inbox_heads` | `CONVERSATION_USE_CASES.conversations`: start, inbox, read, history, changes, send, read of a send, mark read, mute, leave | Implemented |
| Share links | `content_shares` | `CONVERSATION_USE_CASES.shares`: create, revoke, read own, list own, resolve, public preview | Implemented |
| Content threads | `content_threads`, `message_snippets` (and `conversations`, `conversation_members`, `messages`, `inbox_heads` with `kind = 'thread'`) | `THREAD_USE_CASES`: create, read, history, changes, send, respond, mark read, leave, inbox, open snippet | Implemented; not runtime-verified on dev |

Dependency direction: `domain/` (pure rules and cursors) <- `application/` (use cases over ports) <-
`adapters/` (PostgreSQL, Nest providers, erasure). Other modules and the API import only `public.ts`.
Content metadata for cards comes from the Content module's `READ_SHAREABLE_CONTENT` and
`READ_PUBLIC_CONTENT` (never its tables). Threads also use Content's `READ_CONTENT_SEQUENCE`, `VALIDATE_SNIPPET_ANCHOR` and `RESOLVE_SNIPPET_ANCHOR` and Experience's `READ_VISITED_ASSETS`. The module has no jobs and no queue work.

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
  catch-up read are the direct conversation's, over the same rows. Send, respond, mark read and leave use shared
  receipts keyed by the thread, so Clear does not forget them.
- **Snippets** (`message_snippets`, one row per snippet message) are anchors into the thread's own sequence, checked
  against the exact current revision: a Reel range of at least one second inside the duration; a passage with a
  stable block, a range on character boundaries and the hash of the quote; a block with its id, type, version and
  an optional settings snapshot (a value the sender typed themselves needs `confirmPersonal`). The quote, the block
  label and the settings in words are copied when stored and shown only while the content is not withdrawn.
  `threads/snippets/open` asks Content where the snippet leads now: the same anchor, a Scroll anchor moved through
  the anchor map (`mapped`), or `changed` (a corrected Reel, or a passage that is gone). It never plays an old range.
- **Episodes** in a thread view are the declared series that contains the root revision, by part, or the root alone.
  Each carries the caller's own `visited` (an activated exposure of that asset) and says `corrected` or `unavailable`
  when it is. No answer has any field for another member's position, current episode or seen marker.
- **Direct inbox.** A thread never appears in the direct inbox: every direct read selects `kind = 'direct'`.
- **Talk** lists a person's threads (`threads/inbox`, newest activity first, at most 50). An invitation shows who
  asked and no message or count.

### Lock order

Personal root, then the caller's own account gate (`fenceOwn`), then the thread's root (`social_thread`: the
conversation row, FOR UPDATE for commands and FOR SHARE for reads), then its members, messages and snippet rows.
Counters are atomic SQL increments. Inbox heads are bumped in account order, only for members whose place stands and
whose account is active. Account deletion takes the person's thread rows first, in id order, then everything else.

### Live updates

A committed send, join, leave or read bumps `inbox_heads` for each member whose place stands and calls
`notifyInboxChanged`, as direct conversations do. The thread screen catches up from its cursor on a hint, a focus or
its 20 second poll, so a lost hint loses nothing.

## Erasure and export

| Store | Exploration Clear | Account deletion |
| --- | --- | --- |
| profiles, pairs, requests, rosters, invites, bindings | kept | deleted; roster heads of former friends are bumped first |
| conversations, members, inbox heads | kept | a direct conversation is closed; a thread goes on for the others. The person's rows are deleted and the peers' inbox heads bumped (hint); invitees whose friendship stood keep their place on their own membership, the others stay out |
| messages | kept | the person's messages become tombstones with new change sequences |
| content_shares | kept | deleted |
| content_threads | kept | the starter link is cleared; the thread stays for the others |
| message_snippets | kept | deleted with the author's tombstoned message |

Clear never removes messages, cards, snippets, threads or links. `eraseAccount` order: take the person's thread rows (id order), delete the person's links, delete the snippet rows of their messages, tombstone
their messages, pick the peers, close conversations, delete their membership and heads, hint the peers, then
the friendship rows. The export (`socialErasure.export`) holds the profile, counts of connections, the
invitation state, the conversation count and the person's own words (newest 2,000, with `truncated`) and
their shared links without tokens, and how many threads they are in and started (with the names they gave). It names no other person.

## Failure and recovery

- A lost response: retry with the same command ID.
- A lost hint: the next hint, a focus, or the 30 second poll reads `changes` from the cursor.
- A stale friendship view: the command is refused as stale and the client rereads the pair.

## Related

- Blueprint 02d sections 14 and 17; decisions D-042 (conversations and links), D-043 (deleted accounts), D-046 (threads and snippets).
- Contracts: `packages/contracts/src/sharing.ts`, `conversations.ts`, `threads.ts`, `content-shares.ts`, `friend-pages.ts`.
- Tests: `tests/integration/modules/social-*.test.ts` (threads: `social-threads`, `social-thread-snippets`), `tests/integration/release/conversations-http.test.ts`, `threads-http.test.ts`.
