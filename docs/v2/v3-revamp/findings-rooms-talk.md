# Rooms (R3) and Talk (T3): analysis against `dev`

> **Read with CHANGE-MAP.md.** A Sonnet 5.5 subagent of the owner's coordinating session wrote this file on 29 Oct 2026 by reading the code of `dev` at `5d1271d5`; nothing was run. Verify a claim before you build on it.
> **Owner ruling after this was written:** every design is final, including the PDFs' picks and "LEANING" answers, and the newer design wins where two overlap. Where this file says "not locked", "owner question" or recommends against a leaning, **CHANGE-MAP.md §4 governs**.

Analysis only. Code read: detached worktree of `origin/dev` (schema 68, STATUS 2026-10-25). Designs: R3 Rooms PDF and T3 Talk PDF (both marked EXPLORATION, NOT DECISIONS; leanings recorded in sections 2 and 3). Owner rulings of 26 Oct for rooms are treated as binding where they overlap. I did not open the old v2.1 HTML artboards (R01-R03, C01-C04, D03/D04, X01-X04); what they drew is taken from D-006, D-042, D-046, D-049, D-051 and from R3/T3's own "was -> now" notes. Section order: summary, 2 and 3 (what the designs ask), 1 (what dev has), 4 (change table), 5 (algorithms and AI behaviour), 6 (conflicts and owner questions), 7 (slices).

## Summary: the seven things the build session must know first

1. **Unprompted AI has no payer and no authority on dev.** Every inhabitant call runs as the *asker* (personal scope, personal budget, cancelled if they leave or Clear). Unprompted turns need a new nonpersonal **room reasoning scope** (the existing nonpersonal scope is hard-wired to `'scroll-supply'`), a new `ambient` budget class, and a turn ledger that replaces "an AI message always has an asker" (section 5b).
2. **Do the Stage manager in code.** Caps, ratio, timers, no-repeat, levels and the one AI-to-AI reply are arithmetic under the room lock; a model router adds cost and breaks "models propose, code validates". Only two judgements are semantic (is it a question, is a claim overstated), and the speaking role's own `nothing_to_add` can carry them (5a). That removes about half of R3's costed calls.
3. **The dev budget cannot carry the cast as it stands**: world 300 requests/day, already exhausted by Jev before D-058; R3's busy room alone is about 120 full calls/day. Needs a room scope cap, a raised dev global cap, and 20/day unprompted (not 40) to start (5b).
4. **Three product rules collide with the designs and need an owner call**: peer positions/seen markers private (T3 "who's where", "all finished", R3 synced Watch), no typing indicator and private read state (Ray stands down while typing; SEEN), and R03 "quiz never scored, nothing kept" (the Launch podium and replay). Each has a compliant default and an opt-in option (5f, 5g, 6.1).
5. **Stars and the station need no Cartographer or scene change.** A station is a read (`rooms.stations`); add `sky` and `live` fields to it and draw the emblem and constellation in the client. Persisted scene stations stay deferred (5e).
6. **The shared game layer does not exist** (Sparks, Final call, flair, Orbits, landmarks) and both the Scrolls round and these rounds need it; so do authored calls on Scroll parts and painted art for parts. Residents' "finds" are limited by the library (about 9 Scrolls per system) and must be linked, labelled and silent when there is nothing new (5c). Scouts must create no consumption evidence and read no private universe (5d).
7. **Start with what is independent and fixes real breakage**: Talk slice T-A (thread header, series sheet, dock, dates/times; client only) and rooms slice R-1 (General first, notice once, levels, presence), then R-2 (Ray and Null at home on real MiniMax) (section 7).

---

## 2. R3 Rooms: what the design asks for

### Idea in one line
A room is a campfire under its own sky. It needs a cast that is always home, a rhythm to come back for, and a sky the room builds together. "Nothing fakes a person."

### Recommendations A to F
- **A Place, "Campfire".** Land in a live General with the room's art band behind it. Faces of who is here, a Now strip (Launch, today's question, what is new) on top; everything else is behind "Room name v" (About, Guidelines with the one-time AI notice, AI here dial, Members, Notifications, Pins, Topics, Explorations, Moderation, Privacy, Leave). Stage mode (A2) only while something is live (Launch or a synced Reel); A3 "Observatory" scene only as first-visit landing. Desktop: rail, General, Now panel.
- **B Structure.** Only General, Today, Topics. A topic starts from any message ("Start a topic" in the message menu); a compact topic card stays in General and updates. Topics are a forum list (tags Question/Debate/Explainer/Share; Hot/New/Unanswered; "Useful" reaction, no downvotes, no karma shown). Echo may offer "Spin this into a topic?" (6+ replies, 2+ people, one claim; only to them; max 1/hour). Shared Scroll card carries "Call it together" (Final call locked before reading, hidden until you call); Reel card offers "Watch together" (synced) or alone. What-ifs ("Explore this") post a card and collect on an Explorations shelf. Pins: one pin bar, mods pin. Today = daily channel opened each morning by Echo (today's question, Null's Spot the flaw, tonight's Launch); yesterday moves to Past days. No member-made channels.
- **C AI cast of four.** Explainer (Ray in Space), Skeptic (Null), Quizmaster (T-minus), Keeper (Echo). Never drawn as people. Each message: name, role, AI badge, one-line "why it spoke", 4px character-colour edge, no dotted suggestion box, "Challenge / Other side / Explore this / Reply" actions, React and Report in the menu. A router called the **Stage manager** decides who speaks (see table). Per-person dial: Lively / Quieter / Off, plus "Keep my messages out of what AI reads" (messages replaced by "[a member's message]" before any model sees them). Data notice shown once at join, kept in room menu. Public rooms get all four; private rooms choose, default Quieter, summaries never leave the room.
- **D Identity, "Station kit".** The topic picks the planet; the planet picks emblem frame and palette slot; the writer returns JSON only (`palette{ground,accent,ink}`, `emblem{frame,glyph}`, `motif`, `motion` one of twinkle/draw/blink/pan/rise/ripple, `backdropPrompt`, `cast{explainer,skeptic}`). App draws emblem, stars, constellation from fields; no model-written HTML/JS. Image model paints a banded backdrop in a fixed house style (screenprint, 2 to 3 inks, no text, no faces). A person reviews the backdrop before the room goes public; until then palette+emblem+motif always work. Reduced motion shows a still frame.
- **E Game feel.** Same Sparks as Scrolls; plus room-level Stars. Four star acts: a Launch finished, a human answer marked useful, a debate closed by vote, the daily challenge solved. 7 stars = a constellation the room names (Echo offers 3 names, room votes); a full constellation lights the room's station on everyone's Universe map. Tap a star to see its moment. Replays earn sparks, not stars. Flair earned by acts (First answer, Good question, Flaw finder, Launch regular, Called it x5, Room founder). A podium per Launch only, gone after the night. Orbits 3 days a week shared with Scrolls. Banned still: streaks, weekly leaderboards, levels, karma totals, anything to buy. Rooms never touch your planets.
- **F Quiet room.** Honest quiet ("Quiet right now, last message 3 h ago"). Things to do alone: today's question, replay last night's Launch against real recorded answers (labelled replay), "leave a question for the next person" (Ray answers now, labelled; stays open on an Open questions shelf; you are notified when a person answers; the human answer earns a star). An empty room makes zero live model calls. Nothing speaks into an empty room.

### Behaviour table (design data, for sizing)
| Inhabitant | Unprompted trigger | Asked by | Max frequency | Tier | Never |
|---|---|---|---|---|---|
| Stage manager (invisible) | runs only after people posted since last pass, at most every 2 min; reads last 30 msgs, names replaced by speaker tokens; returns JSON `{speak, trigger, replyTo}` | none | <= 30 passes/hour, 0 idle | S (small) | writes visible text, sees names or opted-out messages, allows more than one speaking turn per pass |
| Ray (Explainer) | question unanswered by a person for 4 min (90 s if one person here); a newcomer's first question | @Ray, Ask Ray about this, Explore this | 4 unprompted/hour/room | L (full) | answers while a person is typing a reply, claims more certainty than sources, DMs, flatters |
| Null (Skeptic) | Stage manager flags a factual claim as wrong/overstated with high confidence; Ray overstated (one rebuttal); daily Spot the flaw from nightly batch | Challenge, Other side, @Null | 3 unprompted/hour/room, <= 1 per person per hour | L | argues taste/opinion, answers a newcomer's first message, mocks |
| T-minus (Quizmaster) | scheduled Launch (mods set time) if 1+ opted in; offers a quiz once after 30+ quiet min if a person is here | start a quiz (2+ here), solo replay | 1 live quiz per 2 h | batch/template (0 live calls) | start without opt-in, generate questions live, shame wrong answers |
| Echo (Keeper) | return after 12+ h with 15+ new msgs: while-you-were-away; side conversation 6+ replies: spin into topic (only to them); end of day 10+ msgs: Today digest; newcomer: one welcome line (template) | Catch me up, Summarise this topic | 1 suggestion/hour; 1 summary per return window (cached, shared) | M (mid) | moderate or remove, quote removed messages, include opted-out people, summarise a private room to outsiders |

Room caps (dev defaults): unprompted turns <= 1 per 3 human messages, <= 8/hour, <= 40/day. Asked turns do not count against it: <= 10 per person per hour, <= 80 per room per day. At most one reply between inhabitants (Null may answer Ray once), then the next AI turn waits for a person. No same inhabitant twice in a row without a person between (running Launch excepted). "One pass, one voice". Mods can tune per room; room menu shows the limits to everyone. Two AI turns within a minute fold into one card. AI never removes messages; Echo and Null can only flag to mods. Nightly batch (one job for all rooms): Today's question, Spot the flaw, tomorrow's Launch questions (pre-checked). Away summary: 1 call, cached for everyone.

Cost sizing in the design: dev room (2 people, 40 messages) about 42 calls/day (18 L, 20 S); busy room (30 people, 600 msgs) about 426 calls (120 L); idle day 1 (batch only).

### Presence rules
Faces always; a number only at 3+ here; never "0 online" or "1 online"; member total in the room menu; cast never counted as people; honest quiet pill.

### Owner-visible leanings on the R3 questions page (not locked)
1 Four inhabitants, four hard max: Yes. 2 Space Explainer = the Ray of astronomy Scrolls: Yes (one guide per topic family). 3 Caps 1 per 3 msgs / 8 per hour / 40 per day: start there, tune after two weeks with cost data. 4 Ray wait: 4 min, 90 s if alone; A/B 2/4/8. 5 Default AI level: Lively in public, Quieter in private. 6 "Keep my messages out": Yes. 7 Presence rules: Yes. 8 Launch frequency: a few evenings a week at a mod-set time; anyone can start one with 2+ here. 9 Podium per Launch, no weekly leaderboard: Yes; collective competition is room vs room. 10 Star acts: the four above; replays earn sparks not stars. 11 A lit station changes the room cosmetically: Yes (constellation joins the backdrop). 12 Spin off a topic: anyone, Echo only suggests. 13 Member-made channels: not on dev. 14 Private rooms: room chooses cast, summaries never leave, default Quieter. 15 Live audio: not this year. 16 Call it together results feed Scrolls' "common guess": Yes, once a Scroll has 30+ calls across rooms. 17 Backdrop review: operator queue on dev, moderators later. 18 Room vs room monthly match: Yes as experiment once three rooms have a regular Launch.

### Owner rulings 26 Oct (override design where they differ)
Explainer and Skeptic always alive and speak unprompted; data notice shows once; default General channel; each room has its own art and identity; game feel allowed (counts/scores/streaks/leaderboards bans lifted, so the design's own "no streaks, no weekly leaderboards, no levels" are the design's choices, not forced); AI always labelled, never poses as a person.

---

## 3. T3 Talk: what the design asks for

### Idea in one line
Talk should live in the same universe as Explore/Universe: dark sky, paper and ink, cobalt for you, glass bars, chunky shadow. DMs get the look, threads get the game ("DMs familiar, threads the special place, rooms with residents").

### What is broken in live app (their list)
No dates/times; no reply; thread on phone has a fixed ~470px series card covering the chat and cutting off the what-if; desktop wastes space; off-brand; nothing shows progress or who is where.

### Pieces
- **Look.** Paper #FFFDF2 + Ink #15302A for others' bubbles, cobalt #2C46E8 for yours, radius 20, chunky 0 4px 0 shadow. Date capsules (glass) per day, time under each run (new run after 5 min gap), SENT/SEEN on your last, exact time on tap. Dark sky default, light Paper option (per-person setting). Offline state "Waiting for a connection, drafts kept". Tab bar hidden inside a conversation.
- **DM rebuild.** Reply by swipe right (60px), menu or R; quote strip jumps to the original and flashes it; five drawn reactions (Spark, Mind blown, Ha, Heart, Question) shown as a pill under the bubble ("tap to see who"); long-press menu: React, Reply, Copy, Save as a moment, Start a thread, Report. Shared Scroll/Reel/moment cards (moment = Scroll passage or Reel timestamp, quotable and replyable). "Watch together" on a shared Scroll turns the DM into a thread (DM stays; thread is created for the same two people). Red rippling dot + "new since you were here" divider (same as the Universe "You were here"). SEEN read receipts.
- **Threads as a party on a series.** 64px header (72 on threads) with the three part worlds and each member's face on the part they are on; "Ravi is on Part 2, Asha and Kenji on Part 1" chip; series opens as a pull-down sheet; player plays in place and docks to a 56px bar. Finishing a part posts a quiet line. **Call it together** before a part (only parts with an authored call): everyone locks a guess; guesses stay hidden until you lock yours; reveal after the party has watched; right call +1 spark; wrong is a "Plot twist", never a loss. When the whole party finishes the series everyone gets the series landmark. No streaks or leaderboards in a thread.
- **Branches / What if.** Offers three changes drawn from the part or your own text; writer returns JSON (assumption, changed, kept, answer, numbers); app draws the card. Mandatory assumption line. ~30 s honest wait; labelled "What-if, made by KnowScroll"; each branch keeps its own replies, can branch again; Branches tab shows an indented list under its part; "Call it first" on a branch only once it passed checks.
- **Rooms with residents (replaces assigned AI).** Residents (Nova = Explainer, Halley = Skeptic plus "while you were away", Pixel = Quizmaster; new ones such as Vela arrive over time) with names, looks, interests, a memory of the room, a heartbeat. Marked by a small **orbit ring**, "AI agent" on the profile and in screen readers, not removable; no "AI - Explainer" pill. A **Feed** next to General (Hot/New/Top; Rising dropped) where residents and people post finds; **votes from people only**; agents can't vote, DM, or have karma. Heartbeat: one small-model pass per resident about 3 times a day; no model call if nothing new since last pass; at most one post or reply per pass on the full model; **one post per resident per room per 6 h**; each post must link a Reel, Scroll or source; one introduction per new resident set up by mods. Live activity strip above General. "What Nova remembers about this room" editable by moderators; anyone can ask their own messages be forgotten. R3 caps still apply.
- **Scouts.** Your own agent, opt-in (off by default), explores while you're away and posts finds into rooms you've joined, signed with your name ("Asha's scout, sent by Asha"), at most 1 post a day per room (Off / once a week / once a day), reads only public Reels/Scrolls/room posts (never DMs, threads, private rooms), every find links a Reel/Scroll/source; you are responsible; people can mute or report it; reports go to owner and mods; Pause my scout.
- **Desktop.** Talk list, chat in a 720px column, Series panel (worlds with next part, call it, branches, who is where).

### Owner-visible leanings on the T3 questions page (not locked)
1 Dark sky default, light Paper option per person: Yes. 2 Own bubbles cobalt (yellow means focus/picked): Yes. 3 Times under each run (5 min gap), tap for exact: Yes. 4 Flat quote replies everywhere, nesting only under branch cards: Yes. 5 DM becomes a thread when someone shares a Scroll and both press Watch together: Yes. 6 Members of a thread see which part each person is on: Yes inside a thread you joined on purpose, with a per-person "hide where I am". 7 Call it together only for parts with an authored call: Yes. 8 What-if in threads: any member, up to 5 per thread per day, labelled made by KnowScroll, checked like a Scroll, assumption line mandatory. 9 Branch playable with Call it first only after checks pass: Yes. 10 Residents per room: 2 or 3 (R3 says four inhabitants; note the conflict). 11 Who edits what a resident remembers: moderators; anyone can ask their own messages forgotten. 12 Scouts: opt-in, <=1 post/day/room, signed with your name, off by default, pausable: Yes. 13 Agents can't vote, no karma/leaderboard: Yes. 14 Orbit-ring mark plus "Agent" on profile enough: Yes, plus one-time explainer. 15 Launch quiz and while-you-were-away become residents' habits: Yes. 16 Read receipts SEEN default on in DMs, switch works both ways: Yes.

---

## 1. Today on dev

Sources: `AGENTS.md`, `docs/STATUS.md` (25 Oct), `docs/v2/handover.md`, D-006/D-042/D-046/D-047/D-049/D-051/D-058, module READMEs (rooms, social, scenarios, reasoning), blueprint §§10, 14-17, 267-277, 1045, 1096-1100, 1148-1154, 1205-1219. Paths are relative to the worktree root.

### 1.1 Rooms (`packages/backend/src/modules/rooms`, API `apps/api/src/http/rooms.controller.ts`, contract `packages/contracts/src/rooms.ts`, client `apps/client/features/rooms/`)

| Area | What dev does today | Where |
|---|---|---|
| Room | Seeded by an operator command, one per library system, no members, no moderator until named. Fields: slug, name, description, guidelines, topic (system or planet), join rule (`open`, `friends_of_members`, `invite_only`), status (`open`, `paused`, `closed`), `inhabitants text[]` with a DB CHECK to `{explainer, skeptic}`. People cannot create rooms. | `migrations/0062_idea_rooms.sql`, `adapters/seed.ts` |
| Channels | None. A room is a list of **discussions** (title, optional content root, optional origin message, pin, counters). No General, no Today, no tags, no kinds. A discussion can start from a card in another discussion (`origin_message_id` exists). Moderator pins one. | `application/discussion-commands.ts` |
| Messages | Person text or card, snippet, AI contribution, tombstone. Per-discussion `sequence` + `change_sequence`; moderator hide keeps place. No reply link, no reactions, no edit. Blocks are a per-reader mask (D-051). | `0062`, `application/discussion-reads.ts` |
| Moderator | A **person**, named by the operator CLI only. Pin, hide/restore, pause/resume room, remove member. The blueprint's model "Moderator" role is explicitly not built. | D-051, `application/room-commands.ts` |
| Polls and quizzes (R03) | Moderator-only. Poll votes visible to room; held back until you vote. Quiz is served whole and **answered on the device: the server has no command that sends an answer and holds no score, answer or position**. "Never scored, never required". | `0064`, `application/activities.ts`, README "Optional room activity" |
| AI inhabitants | Two, Explainer and Skeptic, labelled `AI · Explainer` / `AI · Skeptic`. **Speak only when a member asks.** | below |
| Presence, counts | None by design (R01/D-006 o): no member count, online count or activity on list, preview or station. Owner lifted the ban on 26 Oct; the code still enforces it in the contract. | `contracts/src/rooms.ts` lines 19, 82, 545 |
| Stations | A **read, not a stored object**: `rooms.stations` maps non-closed rooms whose topic is a factual system/planet on the caller's own map to `{room, standing, placement{systemId, planetId?}}`. Angle from room ID. No Scene or Geography change. No member/count/activity field. | `application/stations.ts`, `domain/stations.ts`, client `use-room-stations.ts` (re-read on Universe focus) |
| Live delivery | HTTP only. Client polls `changes` every 20 s (list 30 s, activities 15 s) and rereads while an AI reply is preparing. **No socket hint for rooms.** Socket scopes are `universe` and `inbox`, both keyed by the caller's own universe id. | `apps/client/features/rooms/use-room.ts`, `contracts/src/socket.ts`, `apps/api/src/realtime/scope.gateway.ts` |
| Reports | Member reports a room message via Feedback (`room_message`); moderators see counts per message, never reporter. | README "Reports" |
| Erasure | Clear keeps rooms (explicit communication). Account deletion tombstones messages, deletes membership/votes, keeps AI contributions. | README "Erasure" |

#### How an AI inhabitant turn runs today
1. Member taps Ask on one inhabitant (`InhabitantBar`, `apps/client/features/rooms/inhabitant-bar.tsx`). The bar shows a notice **every visit**: "Asking sends this discussion's recent messages, without names, to an AI model."
2. `makeInhabitantCommands.ask` (`application/inhabitant-commands.ts`): under the room lock FOR UPDATE, `askDecision` (`domain/contribution.ts`) allows it unless one ask is already open in the discussion, the room has 12 asks today (UTC), the person has 4 asks today or 12 requests of any outcome. Inserts `rooms.ai_requests` (`queued`) and enqueues `rooms.contribute` (IDs only: universe, epoch, request) **in the same transaction**.
3. Worker `makeContribute` (`application/contribute.ts`): runs **as the asker** (`PersonalAuthority` of the asker's universe and privacy epoch). Tx 1 rechecks the asker is still a member of an open room and builds context (`inhabitant-context.ts`): room name/topic meaning/guidelines, discussion title, the root content title+summary, newest **20** messages, **600** chars each, speakers "Member 1..n", AI as its label, snippets as words; hidden messages dropped; no names, ids, positions, friend threads.
4. Outside any transaction: `harness.propose` with role `rooms.explainer` or `rooms.skeptic` (`inhabitant-role.ts`, version `inhabitant.1`, prompt policy `rooms-inhabitant.v1`), `effort: 'low'`, `maxOutputTokens: 4096`, one call plus at most one repair, **no tool loop**. Output schema is strict: kind per role (Explainer `explanation`; Skeptic `assumption|perspective|counterexample`) or `nothing_to_add`; text <= 600 chars, no link, no "I am a person" phrasing, with one fixed repair hint.
5. Tx 2 rechecks authority; appends an `ai` message (`inhabitant`, `ai_kind`) and settles the request with role/prompt version, model, attempt id. `nothing_to_add` posts nothing and tells the asker.
6. **Model:** the single process-wide `KS_MINIMAX_MODEL` (default `MiniMax-M3.1-Flash`; others allowed in config: `MiniMax-M3`, `M2.7`, `M2.7-highspeed`). There is no per-role model. Reply `model` must equal the configured one (D-031).
7. **Budget:** role class `interactive` (never squeezed by D-058). Charged to the asker's personal scope (60 requests, 600k tokens per day), plus global (300 requests, 3M tokens), plus role cap (200/2M) per UTC day; MiniMax quota floor 25 %. A reservation is `request bytes + 4096`.
8. **Labelling:** contract `author: {kind:'ai', inhabitant, label}` with label fixed by role (`AI_INHABITANT_LABELS`); client `AiLabel` pill + dotted outline + square corner; screen reader says "AI, Skeptic". The contract has no way to show an AI as a person. Invariant stated in the migration: an AI message never exists without an `ai_requests` row, and that row's `requested_by_account_id` is the asker.

### 1.2 Conversations, threads, snippets (`modules/social`, client `features/conversations`, `features/threads`)
| Area | Today |
|---|---|
| DMs | Two friends. Text (<= 2000) or content card with optional note. Append-only, `recordedAt` on every message (**times exist in data; the client does not draw them**). No reply, reaction, edit, delete (tombstone on account deletion only). Read state is private; the other person sees "Sent" only. **No typing indicator** (D-042). Mute and leave are private/closing. |
| Inbox | Newest activity first from `conversations/inbox` and `threads/inbox`. `inbox_heads.revision` bumped per member; NOTIFY -> Socket.IO `scope_changed{inbox}` -> client reads `changes` from its cursor. Talk also polls 30 s. A peer's reading never moves your inbox revision. |
| Content threads | `kind='thread'` conversation with a root (exact revision) and starter, 1-8 invited **friends** (pending invitation until join; shared roots `social_thread`). Episodes are the declared series containing the root; "Visited" is the caller's own exposure; **selection, fold state and position stay on the device; no member's position, seen marker or playhead is on the wire** (D-046). Snippets: Reel range, Scroll passage (sentence), block; opening is not an encounter. |
| Thread UI | `thread-header.tsx`, `thread-view.tsx`, `episode-navigator.tsx` (56px strip, typographic tiles: **no thumbnails, no poster source**), `message-list.tsx`, `composer.tsx`, `start-thread-sheet.tsx`, `use-conversation-thread.ts`. The T3 "was" screenshots (fixed 470px card) are the live behaviour on phone. |
| Visibility / availability | Opt-in, default hidden (D-006 e, D-047). `presence_heartbeat` over the socket every 20 s; stored only if the person chose to show; "Online" 60 s, "Recently active" 15 min; friends only. Friend visit publishes a copy of shared systems/planets only. |
| Share links | `/s/<token>` landing, 30 days, revocable. |

### 1.3 Scenarios (What-if, Another perspective) (`modules/scenarios`, client `features/scenarios`)
Draft (private, <= 20/day/person) -> Scenario Planner (personal harness, interactive) proposes 1-3 directions -> `choose` makes a node and **commissions one made-to-order Scroll** through Quartermaster (caps `KS_SUPPLY_SCENARIO_DAILY_CAP` 6 on dev, `KS_SUPPLY_SCENARIO_THREAD_CAP` 6 **total per thread**, not per day). A branch binds when the Scroll is admitted (minutes; gives up at 30 min). Audience = thread members only. Card carries Hypothetical / Speculative tags and premises. **Not built: rooms, Reel branches, a discussion scoped to one branch, "call it first", branch replies.** Poll 20 s / 5 s while preparing.

### 1.4 Things that do not exist on dev at all
Sparks, Final call / Call it together, landmarks, flair, stars, constellations, Orbits, the Launch, reactions of any kind, message replies, read receipts, room presence, a room-level model scope, per-role model choice, an image-generation provider, push notifications (`notifications-screen.tsx` is account settings), painted/art thumbnails for Reels and Scrolls, the "New Universe" tokens (paper #FFFDF2, ink #15302A, glass, chunky shadow: `packages/design-tokens/src/color.ts` still has the v2.1 cream #FFFBF0 set).

### 1.5 Dev budget reality (matters for R3 sizing)
Defaults/dev: world 300 requests/day, 3M tokens; per person 60/600k; role 200/2M; background share 50 %. D-058 recorded that on dev in 24 h Jev made 408 runs and the 300 world requests were gone. R3's own sizing for a 2-person dev room is about 42 calls/day (20 small + 22 full); a busy room about 426. **The room cast cannot ship on the current world cap** without its own scope and cap (section 5b). Cutroom/fal is out of money (D-048: balance -$0.09), so no fal image generation either.

---

## 4. Change table by layer

Size: S under about 300 changed lines, M up to about 1,200, L more (split by slice per AGENTS.md; a slice is under about 2,500 non-test lines). "Dep" names what must exist first. Every new table needs an erasure entry (D-050 plain registry), an export line, a README row, and a Clear-or-keep decision.

### 4.1 Rooms

| # | Change | Contract (`packages/contracts`) | Backend module / migration | Algorithm / AI | Worker job | Client | Size | Dep |
|---|---|---|---|---|---|---|---|---|
| R1 | **General / Today / Topics.** A room gets a default **General** discussion and a daily **Today**; topics are discussions with `kind` (`general`, `today`, `topic`), `tag` (Question, Debate, Explainer, Share), `status`, optional `closesAt`. Echo opens Today each morning. Seeds create General for existing rooms (backfill). Start-a-topic from a message uses existing `origin_message_id`. | `RoomView` gains channel list; `DiscussionSummary.kind/tag/closesAt/replyCount/lastReply`; `CreateDiscussion` gains `tag`, `originMessageId` | `rooms`: `discussions.kind/tag/closes_at`; backfill migration; `ensureGeneral` in seed and in create-room path; sort Hot/New/Unanswered in `discussion-reads` | Hot = code formula (replies, recency, Useful); no model | Today opener is part of R6 batch | Room screen = General-first; topic card in the stream; forum list; Past days | L | none |
| R2 | **Cast of four with per-room characters.** Explainer, Skeptic, Quizmaster, Keeper; character name/skin from a room cast row (Ray/Null/T-minus/Echo in Space). Labels stay server-fixed. | `InhabitantIdSchema` -> 4 values (`explainer, skeptic, quizmaster, keeper`), `max(4)` instead of `max(2)`; label becomes `AI · <Role>`; add `character{name, glyph}` | `rooms.rooms.inhabitants` CHECK widened; new `rooms.room_cast(room_id, inhabitant, character_key)`; `AI_INHABITANT_LABELS/BLURBS` | Names come from a fixed catalogue, never from a model | none | `AiLabel`, avatars never drawn as people; "why it spoke" line | M | R10 for art |
| R3 | **Unprompted turns.** Turn ledger (generalise `ai_requests` -> `ai_turns` with `trigger`, `reply_to_message_id`, `why`, nullable asker); room-level caps (1 per 3 human msgs, 8/h, 40/day, per-inhabitant/hour, once per person/hour for Null, no repeat without a person in between, one AI reply to AI); per-member level **Lively / Quieter / Off**; per-member **keep-my-messages-out**; router; delayed "unanswered for N min" job | `RoomView.you.aiLevel`, `you.keepMessagesOut`, `limits{...}` shown to all; message gets `why` | `rooms`: `ai_turns`, `members.ai_level`, `members.keep_out`, `room_settings` (mod-tunable caps); pure `domain/router.ts` (see 5a); **new harness scope for room work (5b)** in `reasoning` | Section 5a, 5b | `rooms.cast-pass` (debounced after human posts, singleton per room), `rooms.cast-due` (delayed jobs `startAfter`, <= 24 h) | Level dial in room menu; folded "Ray added an answer. Show" in Quieter; bundling | L | R1, R2 |
| R4 | **Asked turns.** Challenge (Null checks that message), Other side (steelman), Ask Ray about this, @mention. Targets a message. Does not count against the unprompted cap; <= 10/person/h, <= 80/room/day. | `AskInhabitant` gains `targetMessageId`, `mode` (`ask`, `challenge`, `other_side`); Skeptic kinds + `check`, `steelman` | `rooms`: extend `askDecision`; context builder centres the target and quotes it | Role instructions v2; same one-call/one-repair harness | reuse `rooms.contribute` | Action row on AI messages; message menu "Ask Ray about this / Other side" | M | R2 |
| R5 | **Keeper (Echo).** Welcome line (template, 0 calls), while-you-were-away (1 cached call per return window), topic-spin suggestion (private to the 2+ people, <= 1/h), end-of-day digest | `RoomMessage` kind `nudge` visible to named viewers only; `AwayRead` | `rooms`: `read_positions(room, discussion, account, through_sequence)` (private, per member), `summaries(room, window, text, derived_through)` | Deterministic window cut + eligibility; model writes 2-4 lines from "Member N" tokens, opted-out and hidden messages excluded (5i) | `rooms.summarise` (on return, cached) | "12 new since 20:40" divider, away card | M | R1, R3 |
| R6 | **Nightly ritual batch.** One job for all rooms: Today's question, Spot the flaw, tomorrow's Launch questions. Grounded in the room topic's **admitted library Scrolls** (checked claims) not free generation. Operator review gate on dev. | `TodayQuestion`, `SpotTheFlaw`, `LaunchDraft` shapes | `rooms.rituals(room, day, kind, payload, state[draft|checked|approved|void])`; **new nonpersonal role** with source passages from `content` public reads | Section 5c | `rooms.nightly-batch` (cron UTC, per-room slice, idempotent by (room, day)) | Today channel cards | L | R1 |
| R7 | **The Launch.** Mod-set schedule or start with 2+ here; server-timed rounds (8 s); answers **recorded**; per-quiz podium (top 3, gone after the night); replay vs recorded answers; share card (spoiler-free squares). Replaces "answered on the device, nothing kept". | `LaunchView`, `AnswerLaunch`, `LaunchResult`, `LaunchReplay` | `rooms.launches`, `launch_questions` (frozen from R6), `launch_answers(launch, account, q, option, ms_after_open)`; T-minus lines are templates | Scoring is code: correct, then faster time; ties by total time; no model call live | `rooms.launch-tick` (open/close rounds), optional | Stage mode, countdown ring with text, options keys 1-4, podium, share card | L | R6, R9, R8 for the star |
| R8 | **Stars, constellations, flair, room sky.** Four star acts (Launch finished, human answer marked Useful, debate closed by vote, daily challenge solved). 7 stars -> constellation; Echo offers 3 names; room votes. Station state on every map. Flair earned by room acts. | `RoomSky{lit, of, constellations[], name?}`; `RoomStation.sky`, `RoomStation.live`; `Star{act, momentRef, at}` (members only) | `rooms.stars(room, act, source_ref unique, earned_at, constellation_no)`, `constellations(name, state)`, `flair_awards(room, account, flair, source)` ; award inside the same tx as the act | Award rules are pure code; anti-farm: Useful must come from a different person than the answerer, replay earns sparks never stars, per-room star cap/day | name suggestion: 1 cached call or code word lists | Sky card, tap star -> moment, station drawing with constellation | L | R7 / R11 / R13 |
| R9 | **Presence and Now strip.** Faces of who is in the room; number only at 3+; never "0/1 online"; honest "Quiet right now, last message 3 h ago" | `RoomView.here{faces[], count?}`, `lastMessageAt` | `rooms.room_presence(room, account, last_seen)` fed by a **room-scoped** heartbeat; lease semantics copied from `social/domain/presence.ts`; member total in menu | none | none | Campfire header, Now strip; hint subscription | M | R1; socket scope for rooms |
| R9b | **Room scope on Socket.IO** so General feels live and the Launch can run on 8 s rounds | `ScopeRef.kind` += `room`; id becomes room id, not universe id (`ScopeRefSchema` currently uses `UniverseIdSchema`) | `api` gateway authorises by current membership; relay `pg_notify` on message/turn/launch events | none | none | replace 20 s poll with hint + catch-up (keep poll as fallback) | M | none |
| R10 | **Station kit and room art.** Writer returns JSON (`palette`, `emblem`, `motif`, `motion` one of 6, `backdropPrompt`, `cast`), validated against closed enums and contrast rules; app draws emblem/stars/constellation; backdrop review queue; reduced motion = still frame | `StationKit` schema | `rooms.room_identity(room, kit jsonb, kit_version, backdrop_state[none|pending|approved], backdrop_ref)`; operator panel "backdrops to review" | Role `rooms.station-kit` (one call per room, at seed/creation); deterministic fallback kit by topic family; **image painting needs a provider that does not exist (5b/6)** | `rooms.paint-backdrop` (later) | Art band, emblem, motif, per-room cast skin; station drawing uses emblem | L (kit) + L (painting, blocked) | none |
| R11 | **Topics as forum, Useful, Debate.** Useful reaction (no downvotes, no count shown except on topics), Debate topic with vote and close date; Echo's spin-off nudge; Pins bar | `Reaction{useful}`; `DebateVote` | `rooms.reactions(message, account, kind)`; `debate_votes(discussion, account, option)` (reuse poll vote shape); close job | Tally and close in code; star awarded on close | `rooms.close-debates` (cron, minute) | Forum list, vote card, Useful | M-L | R1 |
| R12 | **Call it together / Watch together in rooms.** Scroll card carries a locked guess; Reel card "Watch together" | `RoomMessage.card.call{...}` | needs the Scrolls "Final call" model (not on dev) | Reveal rule uses only the caller's own state (5f) | none | cards | M (+L for synced watch, deferred) | Scrolls round |
| R13 | **Open questions shelf / leave a question.** Ray answers now (asked turn); question stays open; notify the asker when a person answers; star on human answer marked Useful | `OpenQuestion` | `rooms.open_questions` (or `discussions.tag='question'` + `answered_by_person_at`) | none beyond R4 | none | shelf, "Lena answered" card in the stream (in-app only: no push exists) | M | R4, R11 |
| R14 | **Moderator tools for the cast.** Per-room caps tunable, slow mode (Launch time), schedule; AI cannot remove messages; Echo/Null can flag to mods only | `RoomSettings` | `rooms.room_settings` | caps are inputs to the pure router | none | Moderation panel | S-M | R3 |
| R15 | **Notice once + room menu.** Notice shown at join (record `notice_seen_at`), repeated in menu "AI here"; remove per-visit text in `InhabitantBar`; Guidelines pin | `You.noticeSeenAt` | `members.notice_seen_at` | none | none | S | S | none |
| R16 | **What-if in rooms / Explorations shelf.** Scenarios today live on `social_thread` membership. | `ListBranches` for a room discussion | generalise `scenarios` audience/lock from "thread" to "thread or room discussion"; D-051 says #244 owns it | planner context from room window | reuse | cards in stream, shelf | L | decide scope (6.Q14) |

### 4.2 Talk

| # | Change | Contract | Backend | Algorithm / AI | Worker | Client | Size | Dep |
|---|---|---|---|---|---|---|---|---|
| T1 | **New Universe look for Talk**: paper/ink/cobalt bubbles, glass capsules and bars, chunky shadow, dark default + Paper option, tab bar hidden in a conversation | none | none | none | none | tokens (`packages/design-tokens/src/color.ts` has v2.1 values), new bubble/capsule/composer parts in `packages/ui`, rewrite `message-views.tsx`, `message-list.tsx`, `composer.tsx`, `conversation-screen.tsx`; theme preference in account settings (kept on device, D-057) | L | Universe tokens landing first |
| T2 | **DM basics**: date capsules and run times (data exists: `recordedAt`), swipe/menu/R **reply** with quote that jumps, **five reactions**, long-press menu, Save as a moment, offline banner | `SendConversationBody.replyTo?: messageId`; message `replyTo{messageId, preview}`; `ReactToMessage`, message `reactions[]` | `social.messages.reply_to_message_id`; `social.message_reactions`; changes feed carries reaction changes (new `change_sequence` on react); erasure of reactions | none | none | gestures, sheets | M-L | T1 |
| T3 | **SEEN receipts** | `peerRead` on snapshot, `ConversationSettings.shareReadState` | `social.conversation_members.share_read_state`; expose `read_through_sequence` only when **both** share; read bumps the other's inbox revision | none | none | SENT/SEEN | M | owner call (6.Q9) |
| T4 | **Thread header + series sheet + docked player** (fixes the broken phone layout) | none | none | none | none | 64/72px glass header, sheet, 56px dock, desktop Series panel; painted worlds need art (no poster source today) -> typographic fallback first | L | T1 for look; independent for layout |
| T5 | **Party places ("who's where")** and finish lines | `ThreadPlaces`, `SetMyPlace` | `social.thread_places(thread, account, part_asset, state, updated_at)`, written **only by the person's own command, only when they opted in** | none | none | faces on worlds, chip | M | owner call (5g) |
| T6 | **Call it together in threads** | `ThreadCall`, `LockCall`, `RevealCall` | `social.thread_calls(thread, part, account, option, locked_at)`; truth = the Scroll's authored call (Scrolls round) | server compares at lock; reveal gated by caller's **own** exposure (5f) | none | card, lock, reveal, Plot twist | M-L | Scrolls "Final call" + Sparks |
| T7 | **Branch cards restyle + Call it first + Branches tab** | `BranchCard.call?` | `scenarios` unchanged except `call` opt-in; keep Hypothetical/Speculative tags | none | none | cobalt-edge card, assumption line, Changed/Kept, own replies (**needs message scope per branch: "Not built" in scenarios README**) | M-L | T1; scenarios message scope |
| T8 | **What-if as a 30 s short answer** (T3 shows JSON -> card, ~26 s) vs dev's full made-to-order Scroll | maybe `ShortBranch` | new "short what-if" role beside the Scroll path, or keep Scroll with a faster preview | Section 6.Q12 | reuse | n/a | L if built | owner call |
| T9 | **DM -> thread via Watch together** | none | reuse `threads/create` with the single friend; mutual consent = friend presses join | none | none | `start-thread-sheet` flow in the DM card | S-M | none |
| T10 | **Residents + Feed** (see 5c) | `Resident`, `FeedPost` (room `kind='feed'` discussion or new table), "agent" author kind | `rooms.residents(room, character, interests, rhythm, memory_ref)`, `feed_posts`, votes by people only | Section 5c | `rooms.resident-heartbeat` | Feed beside General, profile, ring mark | L | R3 scope |
| T11 | **Scouts** (see 5d) | `Scout`, `ScoutPost` author kind `scout{owner}` | `rooms.scouts(account, room, cadence, interests, paused)`, posts through the same turn ledger | Section 5d | `rooms.scout-run` | Send/Pause scout, "sent by" card | L | T10 |
| T12 | **Desktop**: Talk list, 720px chat, Series panel | none | none | none | none | `features/shell/talk-frame.tsx`, D03 | M | T4 |

### 4.3 Cross-cutting

| # | Change | Size | Note |
|---|---|---|---|
| X1 | **Room-scoped reasoning scope** in `packages/backend/src/reasoning` (nonpersonal, no account/epoch; own enable switch, generation and daily caps; roles `interactive`/`ambient`) | L | 5b. The existing nonpersonal scope is hard-wired to `'scroll-supply'` by a CHECK in `migrations/0013_reasoning_production_scope.sql`. |
| X2 | **Per-role model choice** (`role.model`) so a small model can serve the stage-manager/classifier step | M | Only `MiniMax-M3.1-Flash` is verified (D-031/D-032); M2.7 variants send no `thinking` parameter. Measure before relying on S/M/L tiers. |
| X3 | **Game layer** shared with the Scrolls round: Sparks (personal), Final call (shared lock+reveal), Orbits, landmarks, flair. Decide an owning module. | L | Neither round can finish without it. Sparks must never be consumption evidence and never feed Planner/Composer/formation. |
| X4 | **Config + Ansible**: new caps, `KS_REASONING_ROOM_*`, dev raise of the world cap, rituals cron, Launch schedule | S | `/etc/knowscroll/dev.v2.env` is edited by hand; do not print it. |
| X5 | **Operator**: backdrop review queue, rituals review, per-room AI cost panel (calls/day vs caps, no text) | M | `modules/operator` panels show IDs/counts only. |
| X6 | **Tests**: integration over real PostgreSQL for every cap; harness fixture model; one dev journey with real MiniMax | M | See section 7. |

---

## 5. Algorithm and AI-behaviour changes

### 5a. Stage manager: code policy, not a model call (recommended)
**Recommendation: the router is a pure function in `rooms/domain/router.ts`. A model is used only for the one judgement code cannot make, and then only as a proposal that code validates.**

Why not a model call (the R3 design: small model returns `{speak, trigger, replyTo}` on a 2-minute debounce):
- Blueprint and AGENTS: "Models propose; deterministic code validates authority, structure and allowed effects"; no autonomous model tool loops. A model that decides *whether the room hears an AI* is a hidden policy owner. The caps in the behaviour table (ratio, hourly, daily, per-person, no-repeat, one AI-to-AI reply) are all arithmetic over rows. They must be enforced in code under the room lock anyway (as `askDecision` does today), so the model would only add a second, weaker gate.
- Most triggers are not semantic: "question with no human reply for 4 min (90 s if one person here)", "newcomer's first message", "return after 12 h with 15+ new messages", "quiet 30+ min and a person here", "6+ replies between 2 people", "end of day with 10+ messages", scheduled Launch. Only two are semantic: *is this a question?* and *is this claim overstated?*
- Cost: the design's 20 small passes per dev room per day disappear. Only a fired trigger costs a call.
- Testability: a deterministic router is exact under a fake clock; a model router needs fixtures and cannot be asserted for caps.

Proposed shape:
1. **Pass trigger.** A human `send` enqueues `rooms.cast-pass{room}` in the same transaction (pg-boss is the only outbox), only if the room has an active inhabitant and at least one member whose level is not Off. Singleton per room with `startAfter` = debounce (2 min). **No human post, no job, zero calls** (R3's idle rule holds by construction).
2. **Pass body (no model).** Under the room lock FOR UPDATE read: the discussion window, `ai_turns` counters (room hour/day, per-inhabitant hour, per-person hour for Null), the last AI turn and whether a person spoke after it, levels, `here` set. Pure `route(facts, now)` returns `none` or `{inhabitant, trigger, replyTo, notBefore}`. At most one turn per pass ("one pass, one voice").
3. **Delayed triggers.** "Unanswered for N min" is a delayed job (`startAfter`, <= 24 h), re-evaluated at fire time against live rows (still unanswered, caps still allow, room open, someone not Off). Idempotent by (room, trigger, message).
4. **Semantic judgement stays inside the speaking role.** Ray's trigger is a question by a code rule (ends with `?`, starts with an interrogative, or is addressed to the room) and Ray's schema already allows `nothing_to_add`. For Null, code pre-filters candidates (a person's message with strong-claim markers such as "proven", "always", "everyone knows", a number stated as fact, or a Ray message for the one rebuttal) and Null's own call may answer `nothing_to_add`. That is one L call per *candidate*, capped 3/h/room and 1/person/h.
5. **Optional small classifier later** behind `KS_ROOMS_CLASSIFIER=1`: a role that returns `{speak, trigger, replyTo}` only as a **proposal**. Code then checks that `replyTo` is a visible human message in the window, the inhabitant is eligible and all caps hold, recomputed under the lock at apply time. It never speaks, never selects text, never loops. Add it only if measurement shows the lexical pre-filter misses too much.
6. **Rules in code, not prompts**: no repeat from one inhabitant without a person between (Launch excepted); one AI-to-AI reply (Null may answer Ray once, `chain_root` on the turn row); ratio <= 1 per 3 human messages; <= 8/h and <= 40/day (use 20/day on dev, section 5b); Null at most once per person per hour; never on a newcomer's first message; no turn while the room is paused or the author left; Lively / Quieter / Off per member (Quieter folds unprompted turns to one line for that member, Off hides them; **asked turns always show**).
7. **"Answers while a person is typing"** needs a typing signal. D-042 deliberately has none ("a private behaviour signal for little value"). Do not add one. Replace with: re-check at fire time that no new human message arrived since the trigger; the 4-minute wait already makes collision unlikely. If the owner still wants it, make it an ephemeral socket signal that only suppresses AI and is never shown (blueprint §269 allows ephemeral typing signals).
8. **`nothing_to_add` and failed unprompted calls count toward the hourly and daily cap** (they cost money) but not toward the 1-in-3 ratio. Each trigger message is evaluated at most once (15-minute cool-off), so a Skeptic that keeps declining cannot burn the budget.

### 5b. Cost: who pays, how much, how it is capped
Facts: every AI turn is a paid MiniMax call through the harness; the only verified model is `MiniMax-M3.1-Flash`; reservation = request bytes + `maxOutputTokens` (4096 today); settled by reported usage; MiniMax quota floor 25 % fails closed; dev world cap is 300 requests/day shared with Jev, Cartographer, Planner, What-if.

Problems to solve:
1. **Unprompted turns have no payer.** Today the call runs as the asker (`PersonalAuthority`), counted on that person's 60/day, cancelled if they leave or Clear. An unprompted turn has no asker. Charging the author of the triggering message would spend a stranger's allowance and let Clear/leave kill a room's turn. Add a **room reasoning scope** (X1): nonpersonal, no account or epoch, like the Scroll production scope but not hard-wired to `'scroll-supply'` (the CHECK in `migrations/0013_reasoning_production_scope.sql` allows one id). Own enable switch + generation (`KS_REASONING_ROOM_ENABLED`, default 0; on in dev), own daily caps (`KS_REASONING_ROOM_REQUESTS_PER_DAY`, `..._TOKENS_PER_DAY`), included in the global cap. The production-scope rule "no personal context" must be relaxed for a *room-authorised* window; retention of request bytes is the existing 48 h and is not personal-erasable (same posture as today, where other members' words sit in the asker's stored request for 48 h; say so in the README).
2. **Class.** Unprompted = a new budget class `ambient` (not `interactive`, so it can never take what a person asks for). It must fit a share of the global cap (new `KS_REASONING_AMBIENT_SHARE_PERCENT`, suggest 30 on dev) in addition to the room-scope cap. D-058's background share is already full of Jev; do not reuse it.
3. **Asked turns** stay `interactive` on the asker's personal scope (no change). Raise the room bound from 12/day and person 4/day to R3's 10/person/hour and 80/room/day only after the dev world cap is raised; otherwise the person's own 60/day binds first and Ray's asks starve What-if.
4. **Per-room caps live in `rooms` code** (like `askDecision`), not in the harness: 1 unprompted per 3 human messages, 8/h, **20/day on dev** (R3 says 40; start lower and tune after two weeks as the leaning says), Ray 4/h, Null 3/h, 1 live quiz per 2 h. Mods may tune downward only on dev. Show the current limits to members (R3 asks for it).
5. **Dev sizing** (calls/day, assuming a code router and no small-model pass):

| Scenario | R3 design (S+L) | With code router | Which cap binds |
|---|---|---|---|
| Idle room | batch only | batch only (1 shared call for all rooms) | none |
| Dev room, 2 people, 40 messages | about 42 (20 S + 22 L) | about 20 (13 L unprompted max, ~5 asked, 1 away, share of batch) | ratio 40/3 = 13 |
| Busy room, 30 people, 600 messages | about 426 | about 40 unprompted + 80 asked = 120 L + batch | daily unprompted 20-40, asked 80 |

   Rough token cost per L call at effort low: 3-5k tokens settled (8-9k reserved until settled). A busy dev room is about 400-600k tokens/day. Raise dev `KS_REASONING_GLOBAL_REQUESTS_PER_DAY` to about 1000 and the room scope to about 150 requests / 1.5M tokens; the real ceiling is the MiniMax 5-hour window (D-030).
6. **Refusal is silent.** When a cap or the quota refuses an unprompted turn, nothing is posted and no error shows (like Jev). An asked turn shows "resting" as today.
7. **Tiers S / M / L.** The harness has one model per process. Adding `role.model` (X2) is only worth doing after measuring M3.1-Flash at `effort: 'low'` for the small passes. Until then all roles use the one verified model and R3's "S" cost line is moot (no model router).
8. **Kill switch and operator view**: `KS_ROOMS_CAST_ENABLED`, per-room "AI off" by a moderator, an Operator panel showing calls vs caps per room (counts only).

### 5c. Residents (T3) and the nightly batch (R3): where supply comes from
Rule: never fabricate social activity; everything unprompted is labelled and grounded.
1. **Conversation turns** (Ray, Null): grounded in the room's own window (5a).
2. **Ritual items** (Today's question, Spot the flaw, Launch questions): one nightly batch role over **admitted library Scrolls of the room's topic** (the 54 Scrolls carry cited claims). Output is validated in code: question text length, 2-4 options, exactly one correct, the key points to a cited passage, Spot-the-flaw's wrong sentence is a *validated alteration* of a checked sentence with the original kept as the answer key. Mechanical checks do not prove entailment (`content/production/README.md`), so on dev an operator approves each batch (`rituals.state = draft -> checked -> approved`) before it posts. Never generate a quiz question live (R3 already says so).
3. **Resident finds** (T3 Feed): chosen **by code** from admitted library Reels/Scrolls in the room's topic that this room has not been shown, within the resident's interest tags (mapped to the topic's concepts); the model writes only a one or two sentence note from the asset's title and summary, plus an optional moment that must pass `VALIDATE_SNIPPET_ANCHOR`. Cooldown 1 post per resident per room per 6 h; each post must link an existing asset (code-checked). **When the library has nothing new for the topic, the resident says nothing.** Supply is finite on dev (about 9 Scrolls per system today), so the Feed will run dry in days unless Quartermaster Create keeps producing. State this to the owner.
4. **Voice rule.** Existing guard: an inhabitant never claims to have watched, read or remembered beyond the items. T3's sample ("changed how I picture dark matter", "A certain album has a lot to answer for") is claimed experience. Rewrite as editorial voice ("Worth a look: at 0:40 ...") or the guard has to be loosened; recommend keeping it. Extend `contributionProblem` with first-person experience patterns.
5. **Heartbeat** (about 3/day/resident): code decides "anything new in the room or its topic since last pass" from rows (new human messages, new admitted assets, new rituals). **If nothing is new, stop before any model call.** One speaking turn per pass; counts toward the room's ambient caps; the residents' own 6 h rule is an extra limit.
6. **Memory ("what Nova remembers")**: a bounded derived text per resident/room, regenerated from the last N retained messages, never appended forever. It carries `derived_through_sequence` and a `stale` flag. Deleting an account, a hide, a "forget my messages" request or an opt-out marks affected memory stale; regeneration then excludes them. Moderators edit by replacing the text (audited). Never store names.
7. **Agents cannot vote, DM, earn flair or count as "a person answered"**; they never appear in member counts, here-now or the star rules. The ring mark is not removable; the server-fixed label still contains "AI" for text and screen readers.
8. **R3 four roles vs T3 two-to-three residents** is a product conflict (6.Q2). The same machinery serves both: a room cast table with 2-4 rows.

### 5d. "Your scout explores while you're away": compliant design
Concern: it must not create consumption evidence; only actual personal encounters do (AGENTS.md). Also it speaks under a person's name.
- **Evidence.** The scout runs as a worker job reading **public library metadata** (title, summary, kind) through the same public content read a share-link preview uses. It starts no encounter, writes no exposure, observation, Keep or progress for the owner. Add a test like D-047's visit test: row counts of `experience.*`, `composer.*`, `planning.*` unchanged around a scout run. UI must not say the scout "watched" or "read" anything: "picks something from the library that matches what you asked it to look for".
- **Interests come from the owner's explicit choice** (a closed list from the room topic's concepts, plus a short label), **not from their private universe**. Using the universe would publish a signal of what a person has explored, under their own name, to a room: a leak of formation. Leave "use my universe" out of scope.
- **Payer and class.** Runs under the owner's personal scope as a `background` role (D-058 share), so it cannot eat what they ask for; personal harness refuses when recording is paused or after Clear, which is the right silence.
- **Label.** A new author kind `agent` with `owner` (public person) and label "Agent · sent by Asha". Counts as AI for the room's ambient caps, cannot vote, earns no flair/stars/"person answered", never counts as Asha being present, never sets her last-seen. Mute and Report go to the owner and the mods.
- **Cadence.** Off by default; once a week / once a day; 1 post/day/room hard cap; only rooms the owner has joined; only public content, never DMs, threads or private rooms.
- **Recommendation: build residents first (T10), scouts later (T11).** T3 itself tests residents before scouts.

### 5e. Collective stars -> a room's station on everyone's map
- **No Cartographer or Scene change is needed.** A station is a *read* (`rooms.stations`) drawn by the client beside the scene object it names (D-051). Add `sky{lit, of, state, constellationName?}` and `live: boolean` (a Launch is on) to `RoomStation` and to `RoomSummary` (preview), and let the client draw emblem + constellation around the station from the room's kit. All are room-level facts that name no person. D-051's "no member, count, online or activity field" is replaced by an explicit allow-list (owner lifted the ban on 26 Oct).
- **Coordinate with the Universe design.** If the Universe round wants stations as persisted scene objects (anchors, camera targets, U06 visit), that is the Scene capability D-051 deferred: a breaking new scene-core kind plus a Geography store. Keep it out of this work; tell the Universe analysis that stars/emblem/constellation arrive through `rooms.stations`, not through scenes.
- **Friend visit (U06).** The published visit copy holds systems and planets only. Do **not** add rooms to it (that would reveal the host's rooms). Draw a station on a visited map from the **visitor's** own standing and the room's public sky, if the topic matches.
- **Star ledger.** `rooms.stars` row per act with a unique `(room, act, source_ref)` so retries cannot double-award; awarded in the same transaction as the act (Launch finished, debate closed by the close job, Useful reaction on a human answer to an open question, daily challenge first solve). Anti-farm rules in code: the Useful giver is a different person than the answerer; a person's own answer never earns; replays earn sparks not stars; at most N stars/day/room (suggest 3). AI messages never earn a star.
- **Constellation**: 7 stars create a `constellations` row in `naming`; Echo offers three names (code word lists per topic family are enough and cost nothing; a model suggestion is optional and validated); the room votes; the chosen name must pass the public-label rule used for profiles. The station state is `lit` once the 7th star lands.
- **Privacy of a star.** Count and name are visible to anyone who can see the station. "Tap a star to see the moment" is members-only and names the act, not the people, unless the act is already public in the room.
- **Rooms never touch planets.** Add a test that no rooms command writes `geography.*`, `experience.*`, `composer.*`, `planning.*`.

### 5f. Call it together and Watch together vs the privacy rules
Rule (AGENTS.md, blueprint 381/1045/1152, D-046, handover J2): peer playback positions, seen markers, selected episode and current branch are private; the UI does not announce "Ravi is watching"; no synchronised co-watching or shared cursor in the initial version.

What the designs ask: T3 "Call it together" with reveal "once the party has watched", "ALL 4 FINISHED PART 2", "2 of 4 in", "Ravi finished Part 2". R3 "Watch together" synced "0:41 / 1:10, synced for everyone", "4 watching".

Options:
| | Call it together | Watch together |
|---|---|---|
| **A (recommended default, no rule change)** | A lock is a **shared contribution** like "Ravi requested More instances": "2 of 4 have called" is allowed. Picks stay hidden until **you** have locked. The truth and everyone's picks reveal to you once **your own** exposure of that part is activated (the server reads only your own `READ_VISITED_ASSETS`). Nobody learns whether anyone else has watched. Drop "finished" lines and "reveal after the party watched". | T3's "Watch together" = **turn the DM into a thread** (no sync). Each person plays at their own pace. R3's synced stage is **not built**. |
| **B (needs owner amendment)** | Reveal waits for "everyone who opted in has watched". Requires the opt-in place marker in 5g. | A **shared clock** session: host starts, joiners opt in, the server holds only the session start time (a fact like a scheduled Launch), never anyone's position. Shows "N watching" only at 3+, only among those who explicitly joined. Conflicts with blueprint 1152 (initial version) and the "no watching" test; amend text first. |
| **C** | none | Live audio or synced scrubbing: no. |

My recommendation: ship A for both now; consider B for rooms only (Launch is a scheduled shared event anyway) after the Launch exists.

### 5g. "See where everyone is" in a thread series
This is the headline T3 feature and a direct conflict with the product rule. It cannot be derived from Experience for others (that would be a peer playback/seen read). Options:
- **G1 (no change):** header shows only your own place and the existing contribution history. Honest but loses T3's best idea.
- **G2 (recommended if the owner wants it): an opt-in, self-published coarse place.** New `social.thread_places(thread, account, part_asset, state ['on'|'finished'], updated_at)`:
  - written **only by the person's own command**, only while they have "Show my place to this thread" on; **default off**, asked once on joining (matches D-006 e: availability opt-in; it also answers T3's "hide where I am" leaning by inverting the default);
  - coarse: which **part**, and "on" or "finished". Never playhead, never branch, never "watching now", never time of day beyond day;
  - read only by current members of that thread, under the thread lock; every refusal looks the same; removed on leave, block, Clear (it is derived from the person's exploration), account deletion; exported as own data;
  - the server never reads another member's Experience to build it; the client sends it when the person's own encounter begins and the toggle is on;
  - must be added to the blueprint text and AGENTS rule as an explicit exception ("except a coarse place the person chose to share with a thread they joined").
  - Add tests: toggle off writes no row; a member who left sees nothing; no field carries a time finer than a day; export shows own row only; peer never receives a position without a row.
- Same machinery serves the room: **no** places in rooms (rooms have no series).

### 5h. "Keep my messages out of what AI reads"
Member flag (`members.keep_out`, default off, in the room menu). The context builder substitutes "[a member's message]" **before** the context items are created, so neither the model nor the stored request bytes see the text (the module builds items; the harness only stores what it is given). It still counts for ratio and presence. Past cached summaries or memory containing that member's words are marked stale. A member who opts out also cannot be quoted in Echo's digests. Turning it on changes the AI's usefulness; the R3 leaning accepts that.

### 5i. Summaries ("while you were away", topic recap, daily digest)
- A cached summary is a function of (room, window of change numbers, set of included messages). Per-person "since 22:10" differs, so cache **by hour or by sequence block** and let the client stitch or use the newest covering block; do not promise one summary for everyone.
- Exclude hidden, removed, opted-out and tombstoned messages; no names (speaker tokens only). **Blocks** (D-051) are a per-reader mask on words; a shared summary may paraphrase a blocked person's words to the blocker. Accept and say so, or skip summaries for the blocker; recommend accepting (no names, no quotes).
- Mark stale on hide, deletion, opt-out. Never summarise a private room to outsiders. 1 call per cache block, charged to the room scope as `ambient`.

### 5j. Other rules worth encoding
- **Welcome, Launch lines, quiet-room offers are templates** (0 calls). Echo's "offer a quiz once" is a template.
- **AI never removes messages**; Echo/Null can raise a flag to mods only (a report-like row with no reporter identity).
- **AI messages in reports**: today's reportable-room-message port yields no author account for AI; keep that and let a report on an AI message go to the operator/mods.
- **Every AI turn row records** trigger, why-line, replyTo, role/prompt version, model, attempt, counted/dispatched, and which cap decided. That is the provenance rule already used for asks.

---

## 6. Blueprint / AGENTS conflicts and owner questions

### 6.1 Conflicts (each needs a text change in the named file when the owner agrees)

| # | Where the rule is | Design asks | Resolution I recommend |
|---|---|---|---|
| C1 | D-051 "AI inhabitants speak only when asked"; rooms README; migration 0062 "an AI message never exists without an `ai_requests` row" with an asker | Unprompted Explainer/Skeptic (owner ruling 26 Oct) | Owner ruling wins. Amend D-051 and the README. Keep the spirit: every AI turn has a **turn row** naming trigger, why, caps decided. Blueprint 1211 ("AI activity is bounded and does not fabricate human activity") already allows it. |
| C2 | D-006 o, D-051, `contracts/src/rooms.ts` comments: no member/online/activity field anywhere | Faces, here-now, member total, "12 new", `4 answers today`, stars, Launch podium | Lifted by the owner. Replace with an explicit allow-list in the contract; keep R3's own honesty rules (number only at 3+, never "0/1 online", cast never counted). |
| C3 | D-051 R03: polls/quizzes "never scored", quiz answered on the device, server holds no answer | Launch podium, recorded answers, replay | Build the Launch as a **new** activity kind; leave moderator polls and quizzes as they are. Scores are game state, never consumption evidence. Update R03 text. |
| C4 | AGENTS "peer playback positions, seen markers and current branches are private"; blueprint 381/1045/1152; handover J2 "no peer playback or watching" | Who is on which part; "ALL 4 FINISHED"; synced Watch together | Default A (5f) with no rule change. If the owner wants the party view, add the narrow opt-in place exception (5g G2) and amend those lines. Keep the J2 test; add new tests. |
| C5 | D-042 "no typing indicator", read state private ("Sent" only) | Ray stands down while a person types; SEEN | Drop typing (re-check at fire time instead). SEEN only as a **mutual** switch (both share or neither sees), default on per T3 leaning but owner must approve (6.Q9). |
| C6 | D-046 "the server holds no position, selection or seen marker of any member" | `thread_places` | Amend to "except a coarse place the member chose to share with that thread". |
| C7 | `reasoning` README: production scope is `'scroll-supply'`, admits no personal context | Room-scoped unprompted calls reading member words | New scope kind; amend README and blueprint §15 role table (the "AI inhabitant" row gets a second authority: room). |
| C8 | D-051 "stations are a read; persisted placement waits for a Scene capability" | Station = emblem + constellation on every map | Compatible if stars arrive via `rooms.stations`. Only a persisted-scene station needs the capability (not required here). |
| C9 | `InhabitantIdSchema` max 2; DB CHECK to two ids; `AI_INHABITANT_LABELS` | Four inhabitants, residents 2-3 | Widen enum/CHECK; R3 four vs T3 two-to-three is a product question (6.Q2). |
| C10 | AGENTS "Consumer UI never shows ... model reasoning, scores" | "Why it spoke" line; Sparks are scores | Clarify: the rule is about model internals. The why-line must be built from the **trigger enum** by template, never model text. Sparks are game points, allowed. |
| C11 | AGENTS "only actual personal encounters create consumption evidence" | Launch answers, Called it, scouts, resident finds | Game acts and scout reads create none. Add negative tests (row counts unchanged in `experience`, `composer`, `planning`, `geography`). |
| C12 | AGENTS "never fabricate social activity" | Residents, cast, scouts, replays, "N played" | Allowed only if labelled and real: replays labelled and from real recorded answers; no AI counted as a person; no invented counts; quiet room says so (R3 agrees). |
| C13 | D-051 blocks are a per-reader mask on words | Faces, podium names, topic cards | Apply the same mask to faces, podium and flair for the blocker; blocked people see nothing different. |
| C14 | D-046 "no thumbnails: Reel and Scroll have no poster source" | "Painted worlds with faces" in the header, painted thumbs on cards | Keep the typographic tile as the fallback; painted art needs a Content/Scrolls-round art source. Do not block layout work on it. |
| C15 | Providers: only text models; fal account locked (D-048) | Painted room backdrops | No image provider exists. Ship the kit drawn by the app first; painting is a later, separately funded slice. |
| C16 | No push infrastructure | "Remind me at Launch", "we'll tell you when a person answers" | In-app only on dev (a card in the stream, Open questions shelf, a Talk badge via existing inbox mechanics). Say so in the design review. |
| C17 | Scenarios README: thread cap 6 total, daily cap 6 on dev, a branch is a full Scroll (minutes) | "any member, 5 per thread per day", 26 s short answer | Keep Scroll-backed branches; make caps per day, not total, when owner confirms; the "short answer card" is a different product (6.Q12). |
| C18 | Scenarios live on `social_thread`; "Not built: idea rooms" | Explore this / Explorations shelf in rooms | Generalising scenarios to room discussions is its own L slice (R16). |

### 6.2 Owner questions with a recommended answer

| Q | Question | Recommended answer |
|---|---|---|
| Q1 | Room cast: four inhabitants (R3) or two-to-three residents (T3)? | One cast table, **2 to 4 rows per room**. Dev default: Explainer + Skeptic always; Quizmaster and Keeper arrive with the Launch and the Away summary slices. Keep role names fixed, characters per room. |
| Q2 | Visual identity of an AI: pill "AI · Explainer" (R3, current) or orbit ring + "Agent" (T3)? | Ring on avatar + character name + role word in small text, with the server-fixed text label kept for screen readers and copy. It satisfies both and the contract. |
| Q3 | Who pays for unprompted turns? | A room scope with its own daily caps, class `ambient`, inside the global cap (5b). Not a member's allowance. |
| Q4 | Unprompted caps on dev | 1 per 3 human messages, 8/h, **20/day** (not 40), Ray 4/h, Null 3/h and 1/person/h. Review after two weeks of ledger data. |
| Q5 | Ray's wait before answering | 4 min, 90 s if one person is here; make it a room setting so the A/B (2/4/8) needs no deploy. |
| Q6 | Default AI level | Lively in open rooms, Quieter in private; per-person Lively / Quieter / Off. |
| Q7 | "Keep my messages out" | Yes (5h). It is what makes unprompted AI honest. |
| Q8 | Room presence | Faces while the room screen is open, via a **room-scoped** heartbeat with the same lease logic as availability; **opt-out** per person in the room menu (a member is already visible by name in an open room); number at 3+; separate from friends availability (D-047, default hidden). If the owner prefers D-006 e strictness, make it opt-in. |
| Q9 | SEEN in DMs | Yes, only as a **mutual** switch (hide yours, you don't see theirs); default on as T3 leans; owner must confirm because it reverses D-042. |
| Q10 | Where is everyone in a thread? | G2 opt-in coarse place, default off, asked at join (5g). If not now, G1. |
| Q11 | Call it together reveal | A: reveal after **your own** exposure, never peers' (5f). |
| Q12 | What-if in threads: full Scroll (today) or a 30 s short answer card (T3 mock)? | Keep the Scroll for now; ask the design to show a "making it" state honest to minutes. A short answer card is a second role, a second validation and a second product surface: schedule after rooms. |
| Q13 | Synced Watch together | Not now. DM->thread yes. |
| Q14 | What-if/Explore this in rooms | After the cast works. Restrict Explore this to discussions that have a content root; a General message has no root for a Scenario to branch from. |
| Q15 | Launch questions | Generated nightly from admitted library Scrolls, checked by code, operator-approved on dev; answers recorded; replay labelled; podium per Launch only. Needs the R03 amendment (C3). |
| Q16 | Star acts and anti-farm | The four acts in R3, plus: different person for Useful, replays never earn stars, <= 3 stars/day/room, AI never earns. |
| Q17 | Room backdrops | Ship the kit drawn by the app (palette, emblem, motif, motion). Defer painted backdrops until an image provider and budget exist; operator review queue is ready for when they do. |
| Q18 | Who can create a room? | Still operator-seeded on dev (new rooms get a kit at seed time). R3 does not ask for member-made rooms either. |
| Q19 | Residents memory editing | Moderators replace the text; anyone can ask their own messages forgotten (which marks memory stale). |
| Q20 | Scouts | Defer. Residents first. If built: 5d. |
| Q21 | Call-it counts feeding a Scroll's "common guess" (R3 Q16) | Defer; needs the Scrolls round. Aggregate only, with the 30-call threshold, no per-person data. |
| Q22 | Sparks and flair: who owns them? | A game module shared with the Scrolls round (X3). Rooms owns stars/constellations; flair earned in a room is shown to that room only; flair derived from Scroll calls ("Called it x5") is shown only if the person chooses to show it, since it discloses reading behaviour. |
| Q23 | Orbits ("3 days a week of anything") | Counts days with a room act or a Scroll act per person. Personal, never public, resets nothing. Belongs to X3. |
| Q24 | Moderator model role | Keep human. Echo/Null may flag only. |

---

## 7. Suggested slices

Each slice ends in something usable on dev. Dev acceptance uses **two or three disposable accounts** (A moderator named through the operator command, B and C ordinary members) and real `MiniMax-M3.1-Flash`. Count calls from the attempt ledger or `ops` views (counts only), never by reading message text from logs. Rooms and Talk work can run in parallel; **T-B depends on the New Universe tokens landing**, and R7/T-E depend on the game layer (X3). Branch each slice `claude/<issue>-<purpose>`; no slice above about 2,500 non-test lines.

### Rooms track

**Slice R-1: Campfire, General first** (R1 partial, R9, R9b, R15, parts of R3 data)
- Person can: open a room, land in **General**, see faces of who is here, "Quiet right now · last message 3 h ago" when quiet, the AI notice once on join and in the room menu, set Lively / Quieter / Off and "Keep my messages out".
- Touches: `contracts` (discussion kind, `you.aiLevel/keepOut/noticeSeenAt`, `here`), `rooms` (migration: `discussions.kind`, `members.ai_level/keep_out/notice_seen_at`, `room_presence`; backfill General), `api` gateway (room scope kind), `client-core`, `apps/client/features/rooms` (room screen General-first, menu), `social` public people read (faces).
- Accept: A, B, C join; General exists for old and new rooms; faces appear for 2 (names), number only at 3; "1 online" never rendered; notice once then only in menu; level and keep-out persist; hint arrives within seconds (no 20 s wait); a blocked person's face masked for the blocker; erasure/export entries tested; axe passes.

**Slice R-2: Ray and Null are home** (X1, R3, R2 for two inhabitants, 5a)
- Person can: post a question in General and, after the wait, **Ray answers unprompted, labelled, with a why-line**; a strong unsupported claim draws **one** Null rebuttal; nothing else speaks until a person does.
- Touches: `reasoning` (room scope, class `ambient`, config, README), `rooms` (`ai_turns`, `domain/router.ts`, `cast-pass` and `cast-due` jobs, context builder with keep-out substitution, caps), `config` + Ansible dev values, `operator` (per-room calls panel), `client` (AI message with why-line, folded turns in Quieter).
- Accept (real MiniMax, A/B/C): (1) idle 1 h: **0 calls**. (2) B asks a question, nobody answers: Ray posts at 4 min (90 s when only B is here) and the turn row names trigger and caps. (3) B answers within the wait: no Ray. (4) C says "so we've proven it": exactly one Null turn, `nothing_to_add` possible; Null does not answer a newcomer's first message. (5) Ratio: with 3 human messages, at most 1 unprompted; 8/h and daily cap hold; a second Ray without a person in between is refused. (6) B keep-out: request bytes through the ledger contain the placeholder, not B's text. (7) Level Off for C: C sees nothing unprompted, still sees asked turns. (8) Cap refusal posts nothing and shows no error. (9) Room scope exhausted: asked turns still work. (10) No write to `experience`, `geography`, `composer`, `planning`. (11) Count the total calls for the session; compare with 5b.

**Slice R-3: Ask, challenge, topics** (R4, R1 topics, R11 minimal, R5 welcome/away)
- Person can: Challenge, Other side, Ask Ray about this, @Ray; start a topic from any message; browse Topics as a list with tags; mark an answer Useful; get a template welcome and a "while you were away" card.
- Touches: `rooms`, `contracts`, `client`; `read_positions`, `summaries`.
- Accept: asked turns do not count against the unprompted cap; limits are visible; Useful by the same person is refused; away summary is one call for a return window and excludes opted-out and hidden messages.

**Slice R-4: Every room has a face** (R10 without painted art, R2 four-cast skins)
- Person can: see the room's emblem, palette, motif and ambient motion; cast characters (Ray/Null, Chalk/Var ...); the station on the map uses the emblem.
- Touches: `rooms` (`room_identity`, kit role), `operator` (review), `design-tokens` or room-local theme, `ui`, Universe station drawing (`apps/client/features/universe`).
- Accept: JSON validates against closed enums and contrast; bad kit falls back; reduced motion = still frame; no model-written markup reaches the client.

**Slice R-5: Today and the sky** (R6 Today question + Spot the flaw, R8, R11 Debate)
- Person can: answer today's question and solve Spot the flaw; close a Debate by vote; see stars appear; at 7 stars see the room name its constellation and **the station light on another member's map**.
- Touches: `rooms` (rituals, stars, constellations), `content` public reads, `operator` (approve rituals), `contracts`, Universe station drawing.
- Accept: ritual item cites a library passage and passes code checks; operator approval gate; star idempotence under retry; anti-farm rules; station state matches on A's and C's maps; no AI star.

**Slice R-6: The Launch** (R7, R9 stage mode)
- Person can: play a live 5-question Launch with timer, podium and a spoiler-free share card; T-minus lines are templates.
- Accept: round timing server-side, ties by total time, answers hidden until reveal, replay not available yet, finishing earns one star.

**Slice R-7: The quiet room** (R13, replay)
- Person can: replay last night's Launch against real recorded answers (labelled), leave a question; be told when a person answers.

**Later:** R12/T6 (Call it together after X3), R16 (What-if in rooms), painted backdrops, room vs room.

### Talk track

**Slice T-A: Threads readable on a phone** (T4, T12 desktop panel; no new data)
- Person can: open a thread with a 64/72px header strip, a series sheet, a docked player and the chat keeping the screen; dates and times on messages (the data already exists).
- Touches: client only (`features/conversations/thread-*`, `features/threads/episode-navigator.tsx`, `message-list.tsx`). Typographic tiles remain.
- Accept: at 390px at least 60 % of the viewport is conversation; Back and sheet behaviour (D-006 k); keyboard map; axe.

**Slice T-B: Talk in the Universe + DM basics** (T1, T2, T9)
- Person can: use dark/paper bubbles, date capsules, swipe-to-reply with a jumping quote, five reactions, long-press menu, DM->thread with "Watch together".
- Touches: `design-tokens`, `ui`, `contracts` (reply, reactions), `social` (migration, changes feed), client.
- Accept: replay and idempotency of reply/react commands; reactions in changes feed; erasure and export; two accounts at phone and desktop widths; reduced motion.

**Slice T-C: SEEN, if approved** (T3) and theme preference (T1 setting).

**Slice T-D: Party** (T5, G2) - only after the owner answers Q10.
- Accept: toggle off writes no row; faces appear only for opted-in members; no time finer than a day; leave/block/Clear remove; no peer position on the wire without a row; the J2 test still passes.

**Slice T-E: Call it together in threads** (T6) after X3 and authored calls.

**Slice T-F: Branch cards** (T7, T8 decision).

**Slice T-G: Residents and Feed** (T10) after R-2, then scouts (T11) after a week of residents.
- Accept: a resident post links an existing admitted asset or is not made; cooldown 6 h; zero calls when nothing is new; agents cannot vote or count in presence; ring and label read by a screen reader.

### Cross-cutting acceptance for every slice
Typecheck, lint, unit, integration on a disposable PostgreSQL; new tables in the erasure registry and export; README rows marked planned/implemented/runtime-verified; a dev run recorded in the PR with the call count; screenshots at phone and desktop widths against the new boards (R3, T3), not the old R01-R03/C01-C04.
