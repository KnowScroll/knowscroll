# Rooms: idea rooms with a moderator and labelled AI inhabitants

A room is a shared place to talk about a library topic. It has its own identity, its own members and
its own discussions; where its station sits on a map is each person's own. People join, read and
write in discussions, share a Reel or Scroll into the room to start a content thread, and a moderator
keeps the room in order. A member lands in the room's **General**, sees the faces of who has the room open,
and sets how much the AI inhabitants may speak to them. AI inhabitants answer when a member asks, are always
labelled as AI, and make nothing. Each room has a cast of named residents (an Explainer and a Skeptic): they answer
when a member asks and, under caps the router keeps, speak on their own when a question goes unanswered or a claim is
stated very strongly. Blueprint §10, §15 (roles), §16–§17 ("Idea rooms use the same exploration
model"); decisions D-006 o, D-051, D-062, D-069, D-160 to D-165, D-166 to D-171.

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
| Land in the room's General (one per room, backfilled for rooms that existed); topics and pins stay in the room menu (v3 R-1) | Implemented (CI-verified) |
| See the faces of who has the room open (a number only from three, never an AI, a blocked person left out) and an honest "Quiet right now · last message 3 h ago" (v3 R-1, D-069) | Implemented (CI-verified) |
| Read the AI notice once on first opening, then only in the room menu; set AI level Lively / Quieter / Off and "Keep my messages out of what AI reads" (v3 R-1) | Implemented (CI-verified). Keep-out changes what AI reads in every context path; the level decides what a member sees of a resident that spoke on its own (R-2) |
| The room menu: About, Guidelines, AI here, Members with the total, Pins, Topics (v3 R-1) | Implemented (CI-verified) |
| Room hints on the socket: a message or a face appearing is read within seconds (v3 R-1) | Implemented (CI-verified) |
| A named Explainer (Nova) and Skeptic (Halley) in every room, always labelled AI (v3 R-2, D-163) | Implemented (CI-verified) |
| A resident answers a question nobody answered, after the wait, with a one-line why; a strong claim draws one Skeptic rebuttal; nothing else speaks until a person does (v3 R-2, D-164) | Implemented (CI-verified; fixture model). Off until `KS_REASONING_ROOM_ENABLED`; not yet runtime-verified |
| Unprompted caps (1 per 3 human messages, 8 an hour, 40 a day, per resident, per person), quiet refusals, the AI level (Lively shows, Quieter folds, Off hides), keep-out on every context path (v3 R-2) | Implemented (CI-verified) |
| A typing hold: a resident does not speak over a member who is typing (v3 R-2, D-165) | Implemented (CI-verified) |
| Challenge a message, ask for the other side, ask about it, or name a resident (@Nova, @Halley): an asked turn of its own kind that never counts against the unprompted caps (v3 R-3, D-167) | Implemented (CI-verified; fixture model). Not yet runtime-verified |
| Start a topic from any message: it becomes the topic's first item and leaves a card; browse topics as a list with tags, sorted Hot, New or Unanswered (v3 R-3, D-168) | Implemented (CI-verified) |
| Mark a message Useful: one mark per member, never one's own, counted only on a topic (v3 R-3, D-168) | Implemented (CI-verified) |
| A welcome from a resident when joining: a template, no model call (v3 R-3, D-169) | Implemented (CI-verified) |
| A "while you were away" card for a member who comes back after 12 hours to 15 new messages: Halley writes it once per room and 12-hour window, without kept-out members and removed messages, and it is erased when what it read is removed (v3 R-3, D-169) | Implemented (CI-verified; fixture model). Off until `KS_REASONING_ROOM_ENABLED`; not yet runtime-verified |
| Every room has a face: an emblem, palette, motif and one slow loop on its band, the residents' marks, the emblem on its Talk row and on its station on the Universe map. A room wears the default its ID gives it until an operator approves a kit (v3 R-4, D-170) | Implemented (CI-verified) |
| Operator: propose a room's kit from its topic (the `rooms.station-kit` role, one call, closed vocabulary, contrast checked), review it, and approve or reject it (v3 R-4, D-170, D-171) | Implemented (CI-verified; fixture model). Not yet runtime-verified |
| Operator: paint a room's backdrop with MiniMax's image model within a $1 total cap, every attempt in a ledger, review it before any member sees it (v3 R-4, D-166, D-171) | Implemented (CI-verified; fixture image provider and a real media store). Not yet runtime-verified: whether the token-plan key may call the image route is not known |
| What-if branches inside a room thread, reports, a quiz's results (a quiz keeps none) | Planned (not built) |

## What the module owns

| Table (schema `rooms`) | Holds |
| --- | --- |
| `rooms` | A room: slug, name, topic (a library system or planet), join rule, status, guidelines. Its old `inhabitants` array is no longer read (D-163) |
| `room_cast` | The residents that live in a room: role, name (from a fixed catalogue) and position; two to four per room, an Explainer and a Skeptic always (D-163) |
| `members` | One row per person per room: role (`member`, `moderator`), joined, ended (`left`, `removed`), and the member's own settings: `ai_level` (`lively`, `quieter`, `off`), `keep_out` and `notice_seen_at` |
| `read_positions` | Private: one row per member per room, the last time their device had it open (moved by their own presence beats) and, after a long return, when they left and the window of the summary written for it. Never sent to anyone but its member |
| `room_presence` | One lease row per member who has the room open: `last_seen_at`, renewed by their own device and read only while it is under a minute old |
| `invitations` | A member's invitation of a friend; valid while the inviter is still a member |
| `discussions` | A room thread: `kind` (`general`, one per room by a partial unique index; `topic`; `today`, reserved), title, optional `tag` (question, debate, explainer, share; topics only), `title_derived` (the title is the first words of the origin message, not the starter's typing), optional root (an exact asset revision), origin message (the message a topic began from, or the card a content thread began from), starter, pin, counters |
| `messages` | A person's text or card, a topic card (`topic_discussion_id`: the topic a member started from a message, no words of its own), an AI inhabitant's contribution (with `trigger`, why it spoke, when it spoke on its own), or a tombstone; `hidden_at` is a moderator's removal |
| `message_useful` | One mark of Useful per member per message (`message_id`, `account_id`, `marked_at`). Never on one's own message; counted only on a topic of the list; the author is never told |
| `summaries` | A resident's "while you were away" for one room and 12-hour window: the unique key (room, window) is the one-call cap, the words (`ready` only), the span they cover, and the provenance of the call. Erased (`stale`) when what it read is removed |
| `message_snippets` | The anchor of a snippet message, copied from the exact revision when sent |
| `ai_turns` | One row per AI turn, asked or unprompted: the trigger (`asked`, or why a resident spoke), for an ask its kind (`ask`, `challenge`, `other_side`, `about`, `mention`), the message it answers or is about, the cap that decided it (`caps_clear`, or the cap that refused it), the counts it compared, an answer held back for someone typing, and the provenance of the contribution. The rate-bound ledger; an AI message never exists without a row |
| `room_identity` | A kit a model proposed for a room: closed-vocabulary JSON with its version, the role's provenance, and the operator's decision (`pending`, `approved`, `rejected`, `superseded`). One waits and one is approved per room, by partial unique indexes. Not personal (D-170, D-171) |
| `backdrop_attempts` | The ledger of every paid image attempt: its state (`dispatched`, `succeeded`, `failed`, `not_sent`, `unknown`, `reconciled`, `written_off`), the estimate and the charge it counts against the $1 cap in millionths of a dollar, the price's source and the day it was read, the prompt's hash, who asked and the outcome code. No prompt text, no image, no account (D-166) |
| `room_backdrops` | A painted still an attempt made: its place in the media store, its digest, type and size, and the operator's decision. Only `approved` is served (D-171) |
| `typing_holds` | Unlogged: one row per discussion, `held_until` a few seconds ahead. No account, no text. Holds back an AI turn and is read by nothing else (D-165) |
| `activities` | A moderator's poll or quiz: kind, title, the validated definition (options and explanations with server-assigned IDs), `open`, `closed` or `removed` |
| `poll_votes` | One row per person per poll: the option chosen; changing a vote replaces it |

Use cases (`public.ts`, `RoomUseCases`): `list`, `read`, `join`, `leave`, `invite`, `moderate`,
`setPreferences` (AI level, keep-out, notice acknowledged), `setPresence` (`here` or `away`), `create` (a discussion),
`readDiscussion`, `history`, `changes`, `send` (which asks the resident a text message names, or else queues the resident check for a
question or a strong claim), `openSnippet`, `pin`, `hideMessage`, `markUseful`, `ask` (a plain ask, or one pointed at a message),
`topics`, `dismissAway`, `stations`, `activities`, `readActivity`, `createActivity`, `votePoll`, `moderateActivity`. `create` also starts
a topic from a message. `setPresence` also moves the member's place and, on a long return, claims the window and queues the summary. The
worker's `ContributeAsInhabitant` consumes the `rooms.contribute` queue, `DecideCast` the `rooms.cast-due` queue, `RunCastPass` the
`rooms.cast-pass` queue and `Summarise` the `rooms.summarise` queue (the last three only where `KS_REASONING_ROOM_ENABLED` is on). `HoldCast` is the socket gateway's port for a typing hint.
Operator controls: `libraryRoomSeeds`, `seedRooms`, `setRoomModerator`, and the face controls of `composeFaceOperator` (`kit.propose`, `kit.list`, `kit.review`, `backdrop.generate`, `backdrop.list`, `backdrop.review`, `backdrop.spend`, `backdrop.reconcile`, `backdrop.writeOff`; none of them runs on an HTTP path).

Dependency direction: `domain/` (pure rules: join decision, ask bounds, contribution text rules,
cursors) <- `application/` (use cases over ports) <- `adapters/` (PostgreSQL, Nest providers, erasure).
Other modules and the API import only `public.ts`. Rooms reads other modules only through their
public ports: the caller's own map from Geography (`READ_GEOGRAPHY_SCENE_INPUT`, for stations), people, friends and blocks from Social (`READ_PUBLIC_PEOPLE`, `READ_FRIEND_ACCOUNTS`, `READ_BLOCKED_AMONG`, and the
`snippetCard` presentation rule), content cards, sequences and snippet anchors from Content, a person's
own visited markers from Experience, and the personal harness from Reasoning. It never reads Social's
conversations or threads.

## Rules that matter

- **Nothing is invented.** A seeded room has no members, no messages and no moderator, only an empty General. A
  room list and a preview count nobody and say nothing about activity. An empty room says it is empty.
- **Who is here (D-069, D-160).** Only a member's own view of a room carries `here`, `memberTotal` and
  `lastMessageAt` (an explicit allow-list in the contract). Faces come from a one-minute lease the member's own
  device renews (`setPresence`), never from messages or another module. The number appears only from three people
  and the contract refuses one below that, so "0 online" and "1 online" cannot be said. The AI cast has no lease and
  is never a face or counted. The reader is always a face. A blocked person is left out of the blocker's faces and
  count, and nobody else's. The quiet pill is worked out on the device from `lastMessageAt`.
- **Keeping messages out (D-161).** A member's `keep_out` makes the asked-turn context builder replace each of
  their messages with `[a member's message]` before any item is built, so neither the model nor the stored request
  bytes carry their words, the title of what they shared, their note or the title of a discussion they started (it becomes
  `[a member's topic]`). Nothing else a member types reaches a context item. A test reads the stored request. The "while you
  were away" summary uses the same builder and reads no topic title at all.
- **The AI notice.** Shown once (`notice_seen_at`, first acknowledgement kept), then only in the room menu. Its words
  describe what is true now.
- **AI inhabitants are always labelled.** A message's author is either a person (a public profile) or
  `{ kind: 'ai', inhabitant, name, label }` with a name from the cast and a label fixed by the role. The contract has no way to
  show an AI as a person. The client draws the name, the label, a dotted outline and a square corner, and the
  screen reader says "AI, Skeptic" before the words.
- **A turn begins in one of two ways, and each has a row.** A member asks (`ask`), or the router decides a resident
  may answer a message (`cast-due`). The room is locked FOR UPDATE for both, so the bounds are exact. Asks: one ask
  prepared per discussion at a time (a resident preparing an answer of its own does not count), at most 80 asks per room per UTC day, 10 per person per hour and 20 of any outcome
  per person per hour (D-068). An ask is counted unless it never reached the provider (`dispatched`): the worker
  rechecks that the asker is still a member of an open room before it stores anything, so a member who left, a pause or a
  Clear drops the contribution even if the model finished, but the call was made, so the ask stays counted and
  leaving and rejoining buys no extra call. Only an ask that ended before any call (the asker had already gone,
  no provider configured) is handed back, and the any-outcome bound keeps those from piling up.
- **Asks come in kinds (D-167).** A plain ask names a resident; a challenge or the other side goes to the Skeptic and a question about
  a message to the Explainer, whatever the client says; a text that names a resident (`@Nova`, `@Halley`) asks it, once. Each is an
  `ai_turns` row with `trigger = asked`, its kind and the message it is about, and counts against the asked bounds only. A pointed ask
  must name a message of the discussion that is shown to the asker, by someone they have not blocked. The message of a member who
  keeps messages out is accepted and ends without a call, so the choice is not revealed. A mention never fails its message. The
  message a turn is about is read by its ID when it is older than the newest 20 the context holds.
- **Topics and Useful (D-168).** A topic that begins from a message reads it as its first item (so a removal or a block applies to
  it) and leaves a card where the message was. A title left as the message's own words is another person's: readers see it only
  while the message is shown to them (not removed, author present, not blocked by the reader) and otherwise "A topic from a
  message" (`titlesFor`); deleting the author rewrites it. For AI it is withheld when the starter or the
  author of the message keeps out, or that message was removed. Useful is one mark per member per message, refused on one's own
  message, on one that is not shown and on one whose author the member blocked; a message carries only `usefulByYou`.
- **The welcome and "while you were away" (D-169).** The welcome is a template read from the room, so it costs no call. A long
  return claims the window (a 12-hour UTC block) with one insert on a unique key, queues the one summary job in the same transaction
  and records the member's own mark; everyone who returns in the window reads the same words. The summary reads the window through
  the same builder as every context path and leaves kept-out members and removed messages out altogether; a topic is "a topic" in
  it, never its title. Removing a message it
  read, turning keep-out on after writing in it, or deleting the account erases it (`stale`) and the window is not rewritten. A
  member's card is read only for a day after the summary was written.
- **The router is pure and runs under the room lock (D-081, D-164).** `domain/router.ts` takes facts read under the lock
  and answers: let go, look again later, refuse (a cap), or speak. Its caps are code, not configuration. A message that
  reads as a question (or, for the Skeptic, as a claim stated very strongly) queues `rooms.cast-due` for after the wait
  people are owed; at fire time the router re-reads who is here, whether a person answered and whether anyone is typing. A
  refusal is a `refused` turn row that names the cap and posts and shows nothing. An idle room, and a world with residents
  off, queues nothing and makes no call.
- **What a reader sees depends on their AI level.** Lively sees a resident's unprompted message; Quieter receives it
  `folded` (one line, the words on request); Off receives a `muted` marker with no words. An answer the member asked for
  always shows. The one-line why is a fixed phrase for the trigger, never model text. If every member is Off, nothing is asked of a model.
- **Residents are paid by the room, not by a person (D-162).** The model call runs under the nonpersonal `rooms`
  reasoning scope as an `ambient` role; the worker acts as a system actor for the trigger author's universe only to take
  the lock in order and to stop when that person is gone.
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
  model the worker is configured for and the reasoning attempt it came from (`ai_turns`).
- **Rooms never write to the personal universe.** No code here names a table of `experience`, `geography`, `composer`,
  `planner`, `evidence` or `personal_context` as a write target (`write-boundary.test.ts`), and a resident's turn
  changes no row there (`rooms-residents.test.ts`).

## A room's face (v3 R-4, D-166, D-170, D-171, D-172)

Every room has an identity the app draws: an emblem (a frame and a glyph), a palette, a faint motif with one slow loop, and the mark each
resident wears. It is a **kit**: closed-vocabulary JSON (17 swatches, 6 frames, 16 glyphs, 8 motifs, 6 motions) with a version, never markup
and never free text. The vocabulary and its wire shape are `packages/contracts/src/room-identity.ts`; the rules that need arithmetic are
`application/kit.ts`; what each word looks like is the app's (`apps/client/features/rooms/identity/`).

- **A model proposes, code validates, an operator approves.** `rooms kit --room <slug>` runs the `rooms.station-kit` role on the nonpersonal
  `rooms` scope (`interactive`, one call and at most one repair, outside any transaction, on a run whose ID is fixed by the room, revision and sequence: an unknown outcome is never sent again, and a run that ended is never reopened, so a failed proposal is asked for again on the next run).
  It reads the topic and its library meaning and nothing else. Its instructions (`station-kit.2`, D-172) name each glyph with what it stands for
  (`GLYPH_MEANINGS`: `globe` for Earth, `cell` for the human body, `centre-circle` for sport only) and ask for the closest meaning. The harness refuses an answer outside the vocabulary or with a palette that does
  not read (ink on ground at least 4.5, accent on ground at least 3, three different swatches), with a fixed hint; a kit that fails is stored
  nowhere. A kit that passes is stored `pending`. `kit-review` approves or rejects it; only `approved` is shown, and approving supersedes the
  one shown so far.
- **Every room has a face from the start.** With no approved kit a room wears `defaultKit(roomId)`: a deterministic pick from eleven palettes that
  pass the rule and from the first fourteen glyphs (`DEFAULT_GLYPHS`, so a larger vocabulary never changes a default). It is never stored. A stored kit is checked against today's vocabulary and contrast rule whenever it is
  shown (`kitToShow`); one that no longer passes shows the default instead. `identity` is on every room summary (list, preview, station, room),
  optional on the wire.
- **Painted backdrops.** `rooms backdrop --room <slug>` asks MiniMax's `image-01` for one wide still, built by code from the library topic's
  label and the kit's words (never member text; the house style bans text, faces, logos and any signature, mark or stamp, D-172), stores it in the media store (`MediaStore`, as a content-addressed `.jpg`, `.png` or `.webp`)
  and records it `pending`. It is served at `GET /media/room/<sha256>` only after `backdrop-review` approves it, to a signed-in session. A room
  with no approved picture draws its kit alone. At most one picture waits for review per room.
- **The $1 cap.** `BACKDROP_SPEND_CAP_MICRO_USD` is 1,000,000 millionths of a dollar in code. The estimate is `BACKDROP_PRICING` ($0.0035 per
  image, with its source and the day it was read), recorded whether the image is paid or drawn from a plan's quota. A request is refused
  when the recorded total plus its estimate would pass the cap, **before any row exists**; the check and the reservation share one transaction
  that holds the advisory lock `rooms.backdrop-spend`, so two operators at once cannot both pass. Each attempt is one row of `backdrop_attempts`,
  recorded `dispatched` before the request leaves. Only a refusal MiniMax documents as coming before an image is made (status 1002, 1004, 1008, 1026, 2013, 2049; HTTP 400, 401, 403, 404, 413,
  422, 429) and a call that never left count nothing; everything else keeps its full estimate. An unknown outcome (any other status, HTTP 408 or a
  5xx, a timeout, a reset, a success with no image, images blocked after generation, or a crash) is **never
  sent again** and blocks that room until an operator settles it (`backdrop-reconcile --charged yes|no`, or `backdrop-write-off`, which stays charged).
- **Lock order.** The spend lock is taken alone, in its own transaction; it is never taken under a personal root or the room root. The kit is
  stored inside the rooms scope's own transaction (`production_scopes` root `FOR NO KEY UPDATE`), together with ending the run.

Operator commands (`node dist/operator.js rooms …`, results are one JSON line, exit 0 done, 2 refused, 1 failure; they need `KS_WORLD` and
`DATABASE_URL`, and `KS_REASONING_ROOM_ENABLED=1` plus a provider for `kit`, and `KS_MEDIA_ROOT` plus a provider for `backdrop`):

| Command | What it does |
| --- | --- |
| `kit --room <slug> [--dry-run]` | Proposes a kit (one model call). A dry run shows the role and the context and calls nothing |
| `kit-list` | The kits waiting and the kits approved, as words, with whether each still passes today's rules |
| `kit-review --room <slug> --revision <n> --approve\|--reject` | The decision. Approving refuses a kit that no longer passes |
| `backdrop --room <slug> [--dry-run]` | Paints one backdrop (one paid request). A dry run prints the prompt, the price, its source, the recorded total and what a real run would be refused for, and calls nothing |
| `backdrop-list` | The pictures waiting and approved, with their place under the media root, to open on the server |
| `backdrop-review --backdrop <uuid> --approve\|--reject` | The decision. Approving refuses a picture whose file is gone |
| `spend` | The recorded total, the cap, the images left, and any attempt still unresolved |
| `backdrop-reconcile --attempt <uuid> --charged yes\|no --reason <text>` | Settles an unknown attempt from the provider's own record |
| `backdrop-write-off --attempt <uuid> --reason <text>` | Gives up on an unknown attempt; it stays charged |

`ops.room_faces` counts kits and pictures by review state, the attempts still unresolved and the spent total in millionths of a dollar, and
shows no prompt, image or room. Rooms are not personal: no face table names an account (who decided is `cli:<name>`), so neither a Clear nor an
account deletion touches them and the erasure registry has nothing to declare, as for `room_cast`.

## Stations on a personal map (U01, U02)

A room belongs to its topic, not to anyone's coordinates, so a station is not stored anywhere. `stations` reads the
caller's own map through Geography's public scene input and places each non-closed room whose topic is a system (or a
planet) that map holds as a factual place: `{ room, standing, placement: { systemId, planetId? } }`. The IDs are the
map's own object IDs, so the client draws the station beside the scene object they name; the angle comes from the room's
ID, so a station keeps its spot. The same room sits beside different places on different maps. A person with no map has
no stations, a hypothetical place never carries one, a closed room is not shown, and the answer has no member, count,
online or activity field, only the room's own face (D-170): the station draws the room's emblem over its hub and its ring in the kit's accent. Asking reads, writes and enqueues nothing. No scene object or Geography row is added: persisting
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
the room's own root (`rooms.rooms` row: FOR UPDATE for join, leave, invite, moderate, ask, `cast-due` and `cast-pass`; FOR
SHARE for sends, pins, hides, reads, a member's settings and presence beats), then the room's discussion, message and turn rows. A
discussion's counters are atomic increments on its row, so sends are gapless; reads take the counters
before the messages, so a message that commits meanwhile is read again by catch-up, never missed.
Account deletion locks the discussions the person wrote in or started, in id order, before it touches
anything else.

## The worker jobs

`rooms.cast-due` (IDs only: universe, epoch, room, discussion, message, trigger, round) decides, with no model call, whether a
resident answers one message (see "Rules that matter"). `rooms.cast-pass` (IDs only) is the model call of a turn the router
allowed: (1) one transaction rechecks authority and that the turn is still wanted (open room, resident in the cast, message
not removed, nobody has answered) and builds the bounded context with keep-out applied; (2) the room-scope harness makes
one call (plus at most one repair) outside any transaction, on a run whose ID is the turn ID, so a redelivery never pays
twice; (3) one transaction stores the message and settles the turn, or settles it without a message (`declined` for a
resident's own "nothing to add", `failed` otherwise, handed back when nothing reached the provider), and the run is closed.
Step 1 also lets the turn go if its author has since asked that their messages be kept out. Posting is put off while someone
is typing: the paid answer is stored on the turn (`held_kind`, `held_text`), which counts as having reached the provider,
and the next delivery posts it, or drops it with the turn still counted, without building a context or calling the model
again. `dispatched` is only ever raised. After an Explainer that overstated, the same transaction queues the Skeptic's one
reply.

`rooms.summarise` (IDs only: universe, epoch, room, summary) writes one window's "while you were away", in the same three steps as
`rooms.cast-pass`: (1) one transaction rechecks authority and that the summary is still queued, the room open and Halley in the cast, and
builds the bounded window (no call, and the summary handed back, when fewer than five messages are readable); (2) the room-scope harness makes
one call (plus at most one repair) as the `ambient` role `rooms.ambient-away`, on a run whose ID is the summary ID; (3) one transaction stores
the words (`ready`), or settles it `declined` or `failed`, announces the room, and the run is closed. A summary made stale during the
call is never stored but stays counted.

`rooms.contribute` (IDs only: universe, epoch, request). A pointed ask or a mention reads the message it is about as the turn's
focus, and ends without a call when that message is gone or its author keeps messages out. Steps: (1) one transaction rechecks the
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
| members, invitations | kept (a member's AI level, keep-out choice and notice mark are part of the membership) | the person's rows are deleted |
| message_useful | kept: explicit communication, like votes | the person's marks, and the marks on their messages, are deleted |
| read_positions | kept: a lease of the account, not exploration | the person's rows are deleted; also deleted when they leave or are removed |
| summaries | kept (they hold the room's words, no account) | one that read what the person wrote is erased (`stale`) before their messages become tombstones; a queued one whose job is erased with a universe ends as failed |
| room_presence | kept: a lease of the account, not exploration; it ends by itself after a minute | the person's rows are deleted; also deleted when they leave or are removed |
| discussions | kept | the starter link is cleared; the discussion stays for the others |
| messages | kept | the person's messages become tombstones (no author, body, card or note; same place and number; fresh change number) |
| message_snippets | kept | deleted with the author's tombstoned message |
| ai_turns | kept; asks and unprompted turns still queued under the universe end as failed (and stay counted) | the asker link is cleared and queued asks end as failed, as do queued unprompted turns whose job the universe owned; an AI contribution a deleted person asked for, and every unprompted turn, stays with the room |
| room_cast, typing_holds | kept: no account | kept: no account (a hold lapses in seconds) |
| room_identity, backdrop_attempts, room_backdrops | kept: not personal, no account (an operator is `cli:<name>`) | kept: no account |
| activities | kept | the creator link is cleared; the poll or quiz stays with the room |
| poll_votes | kept | the person's votes are deleted |
| pg-boss `rooms.contribute`, `rooms.cast-due`, `rooms.cast-pass`, `rooms.summarise` | the universe's job payloads are deleted (the turns they named are settled first) | the same (universe erasure runs first) |

Clear never removes messages, cards, discussions or memberships: they are explicit communication (D-042).
The export holds the person's rooms (with their AI level, keep-out choice and when they read the AI notice; never where they were), the discussions they started and their own words (newest 2,000, with
`truncated`; a topic card is "a topic they started"), how many times they asked an inhabitant (never the turns residents took on their own), their poll votes (with the option's words), the room and time of each mark of Useful they made (never whose message it was) and the activities they started; it names no other person and no AI text, and a
person who never took part in a room has no section.

## Failure and recovery

- A lost response: retry with the same command ID; the receipt replays it.
- A lost update: the client reads `changes` from its cursor on focus, on reconnect and every 20 seconds, and
  reads the discussion afresh while an inhabitant is preparing a reply. A room hint on the socket (a message sent, a
  lease starting or ending, someone leaving, an AI reply the worker stored) makes a member's client read within seconds; it is disposable and
  names only the room. A lease that lapses without a hint is noticed on the next poll.
- A lost job: an ask still queued after 15 minutes no longer holds its discussion; a new ask is allowed.
- A moderator's hide or restore gives the message a fresh change number, so catch-up replaces the bubble.

## Related

- Contracts: `packages/contracts/src/rooms.ts` (routes under `/v1/rooms/*`, sharing Social's problem
  family and private cache policy).
- Tests: `tests/integration/modules/rooms.test.ts`, `rooms-residents.test.ts` and `rooms-residents-migration.test.ts` (residents, the router's caps,
  keep-out bytes, levels, typing, the room scope), `rooms-campfire.test.ts` (General, presence, hints, settings, keep-out),
  `rooms-campfire-migration.test.ts` (migration 0069 over existing rooms), `rooms-inhabitants.test.ts`, `rooms-erasure.test.ts`,
  `rooms-stations.test.ts`, `rooms-activities.test.ts`, `rooms-asks.test.ts` (pointed asks, mentions, topics, Useful, the welcome),
  `rooms-away.test.ts` ("while you were away"), `rooms-face.test.ts` (kits, the $1 cap under concurrency, the ledger, review), `kit.test.ts` and `backdrop-prompt.test.ts` and `domain/backdrop-spend.test.ts` (the vocabulary, contrast, the prompt, the money rule), and `tests/integration/release/rooms-http.test.ts` over the installed API;
  domain tests next to `domain/`.
- Operator: the face commands above, `node dist/operator.js rooms seed [--dry-run]` and `rooms moderator --room <slug> --account <uuid> [--remove]`
  (naming needs a claimed profile and never undoes a removal; `--remove` only takes the role from a current member;
  a moderator who leaves and comes back is an ordinary member until named again)
  (`apps/worker/src/rooms-operator.ts`).
