# Rooms: idea rooms with a moderator and labelled AI inhabitants

A room is a shared place to talk about a library topic. It has its own identity, its own members and
its own discussions; where its station sits on a map is each person's own. People join, read and
write in discussions, share a Reel or Scroll into the room to start a content thread, and a moderator
keeps the room in order. AI inhabitants answer when a member asks, are always labelled as AI, and
make nothing. Blueprint §10, §15 (roles), §16–§17 ("Idea rooms use the same exploration model");
decisions D-006 o, D-051.

Status marks: **implemented** means merged with tests against real PostgreSQL and the reasoning
harness over a CI fixture model. **Runtime-verified** means used on a local system with the real
model and two disposable accounts (see D-051 for the evidence). Nothing here runs on dev yet.

## What a person can do

| Capability | Status |
| --- | --- |
| See their rooms and invitations (Talk), preview a room before joining, join (by the room's rule) and leave | Implemented |
| Read and write in a room's discussions; share a card for current content; share a Reel moment, a Scroll passage or a block inside a content thread | Implemented |
| Start a content thread from shared content, or from a card in a discussion | Implemented |
| Ask a labelled AI inhabitant to contribute (Explainer, Skeptic) | Implemented; runtime-verified |
| Moderator: pin a discussion, hide or restore a message, pause or resume the room, remove an ordinary member | Implemented |
| Operator: seed one room for each library system, name a moderator | Implemented |
| Find a room's station beside a system of their own map (U01, U02, the list view) and open it | Implemented; runtime-verified |
| Moderator: start a poll or a quiz (R03); members vote in a poll (visible to the room, changeable until it closes) and read a quiz one question at a time; the moderator closes or removes it | Implemented; runtime-verified |
| The desktop room (D04): the room, the open discussion and the room extras in three panes | Implemented (client); runtime-verified |
| What-if branches inside a room thread, reports, a quiz's results (a quiz keeps none) | Planned (not built) |

## What the module owns

| Table (schema `rooms`) | Holds |
| --- | --- |
| `rooms` | A room: slug, name, topic (a library system or planet), join rule, status, guidelines, which inhabitants it has |
| `members` | One row per person per room: role (`member`, `moderator`), joined, ended (`left`, `removed`) |
| `invitations` | A member's invitation of a friend; valid while the inviter is still a member |
| `discussions` | A room thread: title, optional root (an exact asset revision), origin message, starter, pin, counters |
| `messages` | A person's text or card, an AI inhabitant's contribution, or a tombstone; `hidden_at` is a moderator's removal |
| `message_snippets` | The anchor of a snippet message, copied from the exact revision when sent |
| `ai_requests` | One row per ask of an inhabitant: the rate-bound ledger and the provenance of the contribution |
| `activities` | A moderator's poll or quiz: kind, title, the validated definition (options and explanations with server-assigned IDs), `open`, `closed` or `removed` |
| `poll_votes` | One row per person per poll: the option chosen; changing a vote replaces it |

Use cases (`public.ts`, `RoomUseCases`): `list`, `read`, `join`, `leave`, `invite`, `moderate`,
`create` (a discussion), `readDiscussion`, `history`, `changes`, `send`, `openSnippet`, `pin`,
`hideMessage`, `ask`, `stations`, `activities`, `readActivity`, `createActivity`, `votePoll`, `moderateActivity`. The worker's `ContributeAsInhabitant` consumes the `rooms.contribute` queue.
Operator controls: `libraryRoomSeeds`, `seedRooms`, `setRoomModerator`.

Dependency direction: `domain/` (pure rules: join decision, ask bounds, contribution text rules,
cursors) <- `application/` (use cases over ports) <- `adapters/` (PostgreSQL, Nest providers, erasure).
Other modules and the API import only `public.ts`. Rooms reads other modules only through their
public ports: the caller's own map from Geography (`READ_GEOGRAPHY_SCENE_INPUT`, for stations), people, friends and blocks from Social (`READ_PUBLIC_PEOPLE`, `READ_FRIEND_ACCOUNTS`, `READ_BLOCKED_AMONG`, and the
`snippetCard` presentation rule), content cards, sequences and snippet anchors from Content, a person's
own visited markers from Experience, and the personal harness from Reasoning. It never reads Social's
conversations or threads.

## Rules that matter

- **Nothing is invented.** A seeded room has no members, no messages and no moderator. A room list
  and a preview count nobody, show nobody online and say nothing about activity. An empty room says it
  is empty.
- **AI inhabitants are always labelled.** A message's author is either a person (a public profile) or
  `{ kind: 'ai', inhabitant, label }` with a label fixed by the role. The contract has no way to
  show an AI as a person. The client draws the label, a dotted outline and a square corner, and the
  screen reader says "AI, Skeptic" before the words.
- **An inhabitant speaks only because a member asked.** `ask` is the only way a contribution begins. The
  room is locked FOR UPDATE so the bounds are exact: one ask prepared per discussion at a time, at
  most 12 asks per room and 4 per person per UTC day, and at most 12 asks of any outcome per person and
  day. An ask is counted unless it never reached the provider (`dispatched`): the worker rechecks that
  the asker is still a member of an open room before it stores anything, so a member who left, a pause or a
  Clear drops the contribution even if the model finished, but the call was made, so the ask stays counted and
  leaving and rejoining buys no extra call. Only an ask that ended before any call (the asker had already gone,
  no provider configured) is handed back, and the any-outcome bound keeps those from piling up.
- **An inhabitant never starts production.** A contribution is a message. Nothing it says creates a
  demand, a job or a branch; a person who likes a suggestion asks for it themselves.
- **Private friend context never flows in.** The context an inhabitant reads is this room's own
  discussion, the content it is about, the room's name, topic and guidelines, and nothing else. Speakers
  are "Member 1", "Member 2": no name, handle, ID, reading position or hidden message is sent. A test
  puts a friend thread with distinctive words beside the room and proves they never reach the model.
- **Messages and pins are conversation, not evidence.** Joining, chatting, pinning, hiding and asking
  create no exposure, observation or Keep. Reading a Reel or Scroll from a room is an ordinary encounter
  with its own recorder, started by the person.
- **Provenance.** A stored contribution names its inhabitant, kind, role version, prompt version, the
  model the worker is configured for and the reasoning attempt it came from (`ai_requests`).

## Stations on a personal map (U01, U02)

A room belongs to its topic, not to anyone's coordinates, so a station is not stored anywhere. `stations` reads the
caller's own map through Geography's public scene input and places each non-closed room whose topic is a system (or a
planet) that map holds as a factual place: `{ room, standing, placement: { systemId, planetId? } }`. The IDs are the
map's own object IDs, so the client draws the station beside the scene object they name; the angle comes from the room's
ID, so a station keeps its spot. The same room sits beside different places on different maps. A person with no map has
no stations, a hypothetical place never carries one, a closed room is not shown, and the answer has no member, count,
online or activity field. Asking reads, writes and enqueues nothing. No scene object or Geography row is added: persisting
a placement would need a new scene-core kind and capability (D-051).

## Optional room activity (R03)

A moderator starts a poll (a question and two to five different options) or a quiz (one to five questions, each with two to
four options and an explanation). Both live only inside the room: never in a feed, never required, never scored, never an input
to a universe, and no observation or exposure is created by reading, voting or answering. An AI inhabitant has no path to
start one. Bounds are exact because starting one takes the room lock FOR UPDATE: five open at once and twenty started per room
and UTC day (`rate_limited` beyond), definitions of at most 32 KiB.

- **Poll.** One vote per person, visible to the room (the first 12 voters of an option are named; counts are exact).
  Results are the server's to hold back: until the person has voted, or the poll is closed, a view carries no tally,
  no voter and no `yourVote`, whatever the client does (a moderator is a member, and waits like the rest). A new
  command is a change of mind; the same command replays. A vote takes the activity row FOR SHARE and a close FOR UPDATE, so no
  vote lands after a close. Voting needs an open poll in an open room.
- **Quiz.** Served whole to members, answered on the device. There is no command that sends an answer, so the server never
  holds an answer, a score or a position, and a reload starts over. The answers view shows the moderator's explanations.
- **Moderation.** Close keeps the votes and shows them; remove hides it from everyone (a removed activity reads as
  `unavailable`). Closing a closed poll is already what was asked.

## Access, receipts and lock order

Access is membership: an open `members` row and an active account. A stranger, a person who left or was
removed, and a missing room all answer `unavailable` in one shape. A removed person cannot join again.
Join rules: `open`, `friends_of_members` (a friend of a current member, or an invited person), `invite_only`
(an invitation from a current member). A person needs a claimed sharing profile: members show by name.

Commands use shared receipts keyed by (`rooms_room`, room, actor, operation, command ID); the same
command and body replay the first acceptance, another body is `command_key_reused`. A refusal writes
no receipt.

Lock order: personal root (`withPersonalScope`), the caller's own account gate (`fenceOwn`), then
the room's own root (`rooms.rooms` row: FOR UPDATE for join, leave, invite, moderate and ask; FOR
SHARE for sends, pins, hides and reads), then the room's discussion, message and request rows. A
discussion's counters are atomic increments on its row, so sends are gapless; reads take the counters
before the messages, so a message that commits meanwhile is read again by catch-up, never missed.
Account deletion locks the discussions the person wrote in or started, in id order, before it touches
anything else.

## The worker job

`rooms.contribute` (IDs only: universe, epoch, request). Steps: (1) one transaction rechecks the
asker's authority and reads the room's own discussion into the bounded context; (2) the harness makes
one model call (plus at most one repair) outside any transaction, on a run whose ID is the request ID,
so a redelivery never pays twice and an unknown outcome is never resent; (3) one transaction rechecks
membership and the room's status, stores the message with its provenance and closes the run. The answer
schema allows only the kinds an inhabitant may use (the Explainer explains; the Skeptic names an
assumption, another perspective or a counterexample) and refuses a link or a claim to be a person with a
fixed hint. `nothing_to_add` is an honest answer: nothing is posted and the asker is told. The harness
refuses every call while no model provider is configured (`KS_REASONING_PROVIDER=none`), and the ask then
ends as failed.

## Reports on room messages (#250, D-055)

A member reports a room message through the Feedback module (`reportAbuse`, target `room_message`). Rooms answers two
questions for it. `READ_REPORTABLE_ROOM_MESSAGE` says whether the caller is a current member who can see the message (not
removed by a moderator, not a tombstone) and gives its room and author's account (none for an AI inhabitant). The other
way, `reports` (`POST /v1/rooms/reports`) shows a room's **moderators** which messages were reported: the message, its
discussion and number, the reasons, how many *different people* reported it and on which *day* (the start of the UTC
day of the newest report, never the time), newest first (50). It never carries who reported, the note
or the author, and it leaves out reports about the asking moderator's own words. A member who is not a moderator, a
stranger and an unknown room all get the same `unavailable`. The list reads Feedback's `READ_ROOM_REPORTS` port; only the
API provides it, and the worker's inhabitant consumer never asks. *Implemented; CI-verified.*

## Erasure and export

| Store | Exploration Clear | Account deletion |
| --- | --- | --- |
| members, invitations | kept | the person's rows are deleted |
| discussions | kept | the starter link is cleared; the discussion stays for the others |
| messages | kept | the person's messages become tombstones (no author, body, card or note; same place and number; fresh change number) |
| message_snippets | kept | deleted with the author's tombstoned message |
| ai_requests | kept; asks still queued end as failed (and stay counted against the day) | the asker link is cleared and queued asks end as failed; an AI contribution a deleted person asked for stays with the room |
| activities | kept | the creator link is cleared; the poll or quiz stays with the room |
| poll_votes | kept | the person's votes are deleted |
| pg-boss `rooms.contribute` | the universe's job payloads are deleted | the same (universe erasure runs first) |

Clear never removes messages, cards, discussions or memberships: they are explicit communication (D-042).
The export holds the person's rooms, the discussions they started and their own words (newest 2,000, with
`truncated`), how many times they asked an inhabitant, their poll votes (with the option's words) and the activities they started; it names no other person and no AI text, and a
person who never took part in a room has no section.

## Failure and recovery

- A lost response: retry with the same command ID; the receipt replays it.
- A lost update: the client reads `changes` from its cursor on focus, on reconnect and every 20 seconds, and
  reads the discussion afresh while an inhabitant is preparing a reply. There is no socket hint for rooms.
- A lost job: an ask still queued after 15 minutes no longer holds its discussion; a new ask is allowed.
- A moderator's hide or restore gives the message a fresh change number, so catch-up replaces the bubble.

## Related

- Contracts: `packages/contracts/src/rooms.ts` (routes under `/v1/rooms/*`, sharing Social's problem
  family and private cache policy).
- Tests: `tests/integration/modules/rooms.test.ts`, `rooms-inhabitants.test.ts`, `rooms-erasure.test.ts`, `rooms-stations.test.ts`,
  `rooms-activities.test.ts`, and `tests/integration/release/rooms-http.test.ts` over the installed API;
  domain tests next to `domain/`.
- Operator: `node dist/operator.js rooms seed [--dry-run]` and `rooms moderator --room <slug> --account <uuid> [--remove]`
  (naming needs a claimed profile and never undoes a removal; `--remove` only takes the role from a current member;
  a moderator who leaves and comes back is an ordinary member until named again)
  (`apps/worker/src/rooms-operator.ts`).
