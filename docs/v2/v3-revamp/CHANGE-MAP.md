# Change map: from the new designs to the code (29 Oct 2026)

This map was written by the owner's coordinating session on 29 Oct 2026. It compares the final designs in
`01-designs/` with `dev` at `5d1271d5` (schema `0068_feedback`). The detail is in three findings files:

- `findings-universe-cartographer.md`: Universe tab, Cartographer, geography, scenes, renderer.
- `findings-scrolls-recommendation.md`: V3 Scrolls, `scroll-document.v2`, production, Composer, Jev,
  Planner, evidence, Ask.
- `findings-rooms-talk.md`: R3 Rooms, T3 Talk, room AI, conversations, threads.

Read this page first. Verify any claim against the code before you build on it: subagents wrote the
findings by reading the code, and nothing was run.

**The core idea.** Every visible change has a matching change behind it. When the Universe changes,
Scenes and the Cartographer change with it. When Scrolls change, the document model, the writer,
coverage, evidence and the Composer change with them. When rooms change, the room AI and its budgets
change with them. Ship them as **one vertical slice each**, never "UI now, algorithm later".

---

## 1. Universe tab → Cartographer, Scenes, renderer

**Formation itself does not change.** Code still forms systems, planets and regions from the
code-owned catalogue: 6 systems, 17 topics (planets) and 52 facets (regions), with the same
thresholds. The model may still only add labels or routes. What changes:

| UI change (design) | Algorithm, data or contract change | Where |
|---|---|---|
| 3D space views: orange suns, haze, planets that revolve without orbit lines, nebula dust, a fly-in, a 30 fps cap | **A new renderer.** It replaces the `react-native-svg` space views with three.js: a DOM canvas on web, `expo-gl` on native. One render loop at most every 33 ms. The pixel ratio is capped at 1.5. The loop pauses off screen or in the background, and reduced motion draws a single frame. Labels and tap targets stay React Native views placed from projected points. Supersedes D-026 for space views. | `apps/client/features/universe/space/*` (new), `packages/scene-core` |
| Planet **type** (6 painted biomes: lush, ocean, frozen, scorched, barren, gas), `rings`, `moon`; system **haze family** (teal, cobalt, coral, amber, pink, violet) | **Persisted look data, assigned once.** Type is least-used first and prefers a type not already in the same system. Rings and moon come from the seed. Haze comes from a new `haze` field on each `LibrarySystem`. `scenes.guard_object` freezes the v1 payload, so use a sibling `scenes.looks` table, or a new descriptor version with a capability string. Backfill existing dev worlds without moving any slot, seed or anchor. | `content/domain/library/plan.ts`, `scenes/application/projection.ts`, migration, `contracts/scenes.ts` |
| "A type never repeats inside one universe", yet up to 17 planets can form | **Rule decided:** types are unique while possible, using the least-used-first order above. A repeated type gets a different hue shift and layout. | same |
| U03 globe and U04 landed map: continents, irregular region borders, grey "not reached yet" land, never labelled or counted | **Stable seeded geometry generated on the client,** from a fixed site table per planet. The planet descriptor carries `siteCount` (its facet count). Each region carries `site` (its facet ordinal). The client lays out all K cells from the planet seed, so a cell keeps its shape when a region forms. Unformed cells are grey and non-interactive, and absent from lists, search and the accessibility tree. Add decorative grey continents, so the visible grey count never equals the unformed count. Move the generators into `scene-core` with pinned maths: no `Math.sin`/`cos`, a generator version pinned on the descriptor. **Do not copy the design's `buildWorld`:** it seeds from `regions.length`, which moves every border when a region forms. | `packages/scene-core`, `scenes` projection, client planet views |
| Lately: quiet systems go calm. "Everything is where you left it." | **A rules-only sweep, so places go quiet without new reading.** Today `set_activity` is computed only inside a Cartographer run, and runs start only on new evidence. Store `next_quiet_at` on `geography.state`. A scheduled job settles due states with no model call. The 30-day window stays. "Everything is where you left it" stays device-local (`seenAt`). | `geography` (state, schedule, run), migration |
| No orbit lines and no route lines; a "Route to <planet>" chip | Routes stay Cartographer relations. Delete the line drawing and its tests. Supersedes the line part of D-039. | `universe-layout.ts`, `composeSystem` |
| Ship parked at the last place; "Return to <planet>"; per-planet `sel` | Stays **device-local** (`universe-memory.ts`, `universe-here-marker.ts`) and is never sent. The ship sits on the planet of the last place. Add an optional per-planet last-region map. **Map browsing still writes no evidence**: extend the J3 check to the 3D renderer. | client |
| Search over systems, planets, regions **and rooms**, on device only | Add rooms (from the stations read), the mono path, best match first, and fly-to. No network call: assert this in a test. | `universe-search.ts` |
| Orbit dial (replaces List view): wheel, filters All / Lately / With rooms / A–Z, planet search | Client only, built from existing reads. | new component |
| Simple drawing = two plain lists | Client only. Turn it on automatically when WebGL is missing, the context is lost or memory is low. | client |
| Friend visit in the space look; only what they share; no Lately, stations or ships | No contract change. Derive type, haze and positions on the visitor's device from public ids (precedent: `visitor-scene.ts`). The "Only what X shares" chip is **constant**, never conditional on hidden content (D-047). | client |
| Entering a system by ship (an animation, a pure function of T) | Client only. Add Skip, and a jump when reduced motion is on. The same animation for every system in this version (design, 30 Oct). | client |
| First open: dust spirals into a star that bursts, a long trip, a slow build to light speed, a smooth stop on U01 Empty (21.2 s, Skip always there) | Plays **once in the lifetime of the account**, on any device. The seen flag lives **on the account**, not the device: synced across devices, kept through reinstalls, set when it starts, so a crash never replays it. Skip and finishing both count as seen. Where it ends when the account already has places is not decided in the design (drawn ending on U01 Empty). | client + an account-level seen flag |
| Entering a planet (U02 → U03, one glide; the U03 globe comes into focus on the 3D planet) and its ringed version (the 3D ring and moon turn into the U03 ones on the way in) | Client only. Each frame projects the 3D planet and lays the 2D globe on it. The ringed version plays when the planet has rings or a moon (from the look data). Replaces the existing planet transition. | client |
| Entering a world (U03 globe → U04 map at planet level, nothing highlighted); the U03 hint now reads "Drag to rotate · tap to land" | Client only. A tap on the globe enters the map at planet level; choosing a region stays on the map. While it moves, the map is a still picture of the same drawing; the live map takes over once landed. | client |
| Rules for all five animations | A pure function of one time value `t`, clamped to 0.1 s per frame. Each starts and ends exactly on a final screen; the tab bar never moves. Reduced motion and Simple drawing play none of them. Taps are ignored while one plays; Back jumps to the end frame. Going back up is not designed: a 0.3 s cross-fade. Long jumps (search to a region) go straight to the destination. Desktop D02 has none. | client |
| Room stations on the map | Already provided by `/v1/rooms/stations` (`placement.systemId`). Draw them as 3D stations. They show the room's emblem and earned stars (§3). | client + rooms read |
| U05 formation sequence (not in the new file) | Keep the once-per-formation claim/ack. Restyle it with the new builders: nebula to sun. | client |

## 2. Scrolls (V3) → document model, writer, coverage, evidence, Composer, Jev, Planner

| UI change (design) | Algorithm, data or contract change | Where |
|---|---|---|
| Stage + Spine: a pinned picture, short stops, a dots spine, a dock (Ask, sparks, •••, Part 2 →), a top bar with Universe and Next ↑ | **`scroll-document.v2`** (23 blocks: 12 new, 5 kept, 6 changed, 6 cut or merged), plus `scroll-limits.v2` (≤ 1 stage, ≤ 4 calls including the Final call, ≤ 2 other interactives) and `scroll-measures.v2` (230 wpm plus 10 s per call; 3–6 min). v1 documents keep rendering until the last wave. A **stage engine** and **drawing kit** (Ray the sunbeam, Earth with 23.4° tilt, Sun, orbits) are the biggest build: ship Seasons first, then generalise. | `packages/scroll-model`, `packages/ui/src/scroll/{stage,kit}` |
| (hidden, but critical) | **Coverage rule v2.** Coverage today binds facets to top-level paragraph, quote and callout blocks, and needs ≥ 3 of them. A v2 document made of stops would yield **no coverage, so planets would stop forming.** Add `scroll-recipe-coverage.v2` and reading facts v3 **before** regenerating the library. | `content/domain/{coverage,recipe-coverage,reading-facts}.ts` |
| Writer fills stops, stage states, calls, a misconception with a source, a limits aside (not last), recap, `ask_suggestions[≤3]`, `simple` text per stop | Writer prompt v14 with a flat authoring shape (nested JSON failed before, D-032). The validator enforces the v2 rules. The misconception source is **recipe data set by code**, not model text. Answers to calls are claims and must cite. | `content/production/*`, `scroll-model/producer` |
| Call it → Lock it in → reveal; Plot twist; sparks; combo; Final call; gold or plain landmark; weekly Orbit (3 days); clear skies | **A new `play` module.** Tables `play.calls` (correctness recomputed on the server from the immutable revision), `play.scroll_results` and `play.landmarks`. Command `call.lock{stopId, option}` is idempotent. Erasure (Clear = erase), export, and the erasure registry. **A hard wall:** Composer, Jev, Planner, Evidence, Personal Context, Geography and Scenes never read which option was picked, whether it was right, sparks or tiers. Enforce it with a dependency-cruiser rule. Only "locked/finished" counts as engagement. | `modules/play` (new), `contracts/play.ts`, `client-core` |
| Landmarks stand on planets; an Orbit ring around the star | Read-only overlay on the Universe from the `play` read API. **No formation linkage** (V3 Q7). A landmark earned before its planet forms waits in a tray, then attaches when the planet forms. | `scene-core` drawables, universe client |
| Swipe left = Part 2 (same topic); pull up / Next ↑ = **new** topic in the same format | **Composer policy v1.** (1) A hard `same_series` exclusion on vertical moves. (2) Lower the vertical Intent weight (0.35 → about 0.15) and add a recent-topic repeat penalty; choose the numbers by replaying stored `composer.decisions`. (3) Sticky format: the vertical intent gains `format`, retrieves that format first, and falls back only when none is eligible. Today "next" usually offers Part 2 or another Earth Scroll, which fights the new grammar. **Land the minimum of this with the first reader slice.** | `composer/{application,domain}/*`, `contracts/navigation.ts`, `experience/application/navigation-prepare.ts` |
| Swipe-left possible mid-read, instantly | **`activity.v1`:** the +1.5 continuation credit (H) counts only when the source has `coverage ≥ 0.5`. Otherwise swiping through Parts 1→2→3 inflates topic interest by about 4.5 without any reading. | `evidence/domain/activity.ts` |
| Game-heavy versus plain Scrolls | Content derives `traits.playLevel` (plain / stage / game). Evidence keeps Q/O per (topic, kind, playLevel) and shrinks each cell toward the (topic, kind) parent. Composer's format feature reads the cell. Correctness is never an input. Exploration covers each play level. | `content` traits, `evidence` migration, `composer/domain/features.ts`, `personal-context` |
| (Jev) | `jev.2`: `describe()` adds kind, play level, minutes, "Series: part n of m" and the misconception claim (two Scrolls busting the same myth are redundant). Never play outcomes. Watch the call rate: vertical now leaves the planet more often (D-058 bound). | `composer/application/jev.ts` |
| Endings: E1 payoff (recap picture, sparks, landmark, Part 2 peek, "Done for today", Small print) | Client, plus `series.total` derived from admitted `series_units` (D-059 forbids invented totals). Nothing auto-advances. | client, `content` series read |
| Ask D1: suggested questions from where you are, scope inferred, honest wait plus a 20-second puzzle | The ask context gains `anchor {stopId \| passage}`. **"Ask orders" are a new made-to-order production path**, modelled on the What-if branch orders (D-049), with their own caps. Create can only commission library recipes today, and a context-bearing ask closes as unsupported. The scope matcher gets the current topic. "Usually N min" appears only with ≥ 5 real samples. | `supply`, `content/production` (question mode), `contracts/supply.ts` |
| Ask D2: select text → Simpler / Ask; "Quick answer · not a checked Scroll" | Final per the owner, so **build it compliantly.** Simpler is authored at production per stop: instant and free. Quick answer is a **worker job** (HTTP command → pg-boss → MiniMax → socket hint and poll) with a daily cap, labelled, reportable, never evidence, never in the Universe. No model call on the HTTP path. | `supply`/`content` worker role, client selection menu |
| Library | **Regenerate in waves** after a 20-topic writer spike (§7). Calls go everywhere, which is cheap. A stage goes only where a kit exists: Earth & sky and Space first, human body second. Seasons Part 3 becomes "Seasons elsewhere" as a new recipe and facet (`seasons-limits` keeps its pinned facet). Target ≥ 20 stage Scrolls and 30+ with calls. All 54 get a misconception decided ("none" is allowed for editorial). | library plan, `/root/ks-produce-library.sh`, `produce-library --only <wave>`, `admit-continuity`, `readmit-coverage` |

## 3. Rooms (R3) and Talk (T3) → room AI, budgets, social data, privacy rules

T3 (29 Oct) wins over R3 (27 Oct) where they overlap. The owner's room rulings of 26 Oct still bind:
the Explainer and Skeptic are always alive and speak unprompted, AI is always labelled and never
poses as a person, General is the default channel, and the data notice shows once.

| UI change (design) | Algorithm, data or contract change | Where |
|---|---|---|
| Residents (2–3 per room, T3 Q10) who speak unprompted: an Explainer and a Skeptic always (owner, 26 Oct), plus a Quizmaster who hosts the Launch; "while you were away" becomes Halley's habit (T3 Q15) | **Unprompted AI has no payer or authority on dev:** every inhabitant call runs as the person who asked. Add a **room reasoning scope** (nonpersonal, its own enable switch and daily caps; today's nonpersonal scope is hard-wired to `scroll-supply`). Add a new budget class `ambient`, which can never take what a person asked for. Add an `ai_turns` ledger that replaces "every AI message has an asker". Widen the inhabitant enum and CHECK (max 2 today) to a cast table of 2–4 rows. | `reasoning`, `rooms`, migrations, config + Ansible dev values |
| R3's "Stage manager" decides who speaks | **A code policy, not a model call** (blueprint: models propose, code validates; no autonomous loops). Caps, ratio, timers, no-repeat, levels and the single AI-to-AI reply are arithmetic under the room lock (`rooms/domain/router.ts`). The two semantic judgements ("is it a question?", "is this claim overstated?") use a lexical pre-filter, plus the speaking role's own `nothing_to_add`. An optional proposal-only classifier can come later. This keeps the behaviour table's *behaviour* and removes about half of its cost. | `rooms` |
| Caps: 1 unprompted per 3 human messages, 8/hour, 40/day; Ray 4/h; Null 3/h and 1 per person per hour; asked turns 10/person/hour and 80/room/day | Configure the design's caps (R3 Q3: start there, tune after two weeks with cost data). **Raise the dev budgets first:** the world's 300 requests/day is already mostly Jev's. Set the global cap to about 1000/day and the room scope to about 150 requests and 1.5M tokens. The MiniMax 5-hour window is the real ceiling (D-030). A cap refusal on an unprompted turn posts nothing. | `/etc/knowscroll/dev.v2.env`, Ansible template, `reasoning` config |
| "Ray never answers while someone is typing" | An **ephemeral suppress-only typing signal**, never shown to anyone (blueprint allows ephemeral typing signals; D-042's "no typing indicator" still holds for display). Also re-check at fire time. | `rooms`, socket gateway |
| Residents' feed posts, memory ("what Nova remembers"), heartbeat about 3×/day | **Code** picks finds from admitted library assets in the room's topic. The model writes only a short note, and each post must link an existing asset; if nothing is new, there's no model call. Cooldown: 1 post per resident per room per 6 h. Memory is a bounded derived text that goes stale on forget, opt-out or deletion, and moderators replace it (audited). Agents can't vote, DM, earn flair or count as people. The voice guard forbids claiming experience ("changed how I picture…"). **The library is finite** (about 9 Scrolls per system), so feeds run dry unless Create keeps producing. | `rooms`, `content` public reads |
| Scouts (opt-in, off by default, ≤ 1 post/day/room, signed "sent by <name>") | A worker job over **public library metadata only**. It starts **no encounter and writes no evidence** (test: row counts in `experience`, `composer`, `planning` and `geography` are unchanged). Interests come from the owner's explicit choice, **never from their private universe**. A new author kind `agent` with an owner. Build it after residents. | `rooms`/`social`, worker |
| Room as a place: an art band, the Now strip, faces, an honest quiet pill, a menu with About, Guidelines, AI level, Members, Pins, Topics… | Discussion kinds (General, Today, Topics), `members.ai_level`/`keep_out`/`notice_seen_at`, and room presence on a room-scoped lease. A number shows only at 3+; never "0 online" or "1 online"; the cast is never counted. Use an explicit allow-list in the contract; the owner lifted D-051's ban on counts on 26 Oct. | `rooms`, `contracts/rooms.ts`, client |
| "Keep my messages out of what AI reads" | Substitute "[a member's message]" **before** context items are built. Mark cached summaries and memory stale. | `rooms` context builder |
| Per-room identity: palette, emblem, motif, motion; a painted backdrop | The kit role returns closed-enum JSON, and the app draws it. **Painted backdrops need an image provider and a budget that don't exist** (the MiniMax key is text-only; fal is Cutroom's). Ship the drawn kit, and ask the owner before adding any image provider. | `rooms` (`room_identity`), `ui`, operator review |
| Stars (four room acts) → a 7-star constellation the room names → the station lights on everyone's map | **No Cartographer or Scenes change.** `rooms.stations` gains `sky{lit, of, state, constellationName?}` and `live`. Add a `rooms.stars` ledger, unique per (room, act, source) and awarded in the act's transaction. Anti-farm rules: a different person gives Useful, replays earn sparks not stars, AI never earns, ≤ 3 per day per room. Draw it on the Universe map **in the Universe file's station style** (no sparkles). Never add rooms to the friend-visit copy. | `rooms`, `contracts/rooms.ts`, universe client |
| The Launch: a live quiz with a podium per Launch, a replay against real recorded answers, today's question, Spot the flaw | A **new activity kind**; moderator polls and quizzes stay unscored (amend the R03 text). A nightly batch over admitted library Scrolls, with code checks and **operator approval on dev**. Never generate questions live. Answers are recorded as game state, never as evidence. Templates cost 0 calls. | `rooms` (rituals, launch), `operator` |
| Talk in the New Universe look: dark by default with a Paper option, cobalt for your own bubbles, date capsules, a time under each run, swipe to reply, five reactions, a long-press menu | Tokens shared with the Universe. Reply and reaction commands (idempotent), plus the changes feed, migrations, erasure and export. A per-person theme setting. | `design-tokens`, `ui`, `social`, `contracts` |
| **SEEN** read receipts, on by default, a mutual switch (T3 Q16) | **Reverses D-042's private read state.** Record it as an owner decision; the switch is mutual (hide yours and you don't see theirs). | `social` |
| Threads as a party: a header of part worlds with each member's face on their part, "Ravi is on Part 2", "all finished" (T3 Q6) | **Amends the rule "peer playback positions … are private".** Add `social.thread_places(thread, account, part, on\|finished, day)`, written only by the member's own client, **coarse** (part plus on or finished; never a playhead, branch or time finer than a day). Visible only to members of a thread they joined. A per-person "hide where I am" switch (on by default per T3). Removed on leave, block, Clear and deletion; exported as own data. The server never reads another member's Experience. | `social`, `contracts/threads.ts`, client |
| "Watch together" in a DM (T3 Q5) | The DM stays, and a thread is created for the same two people. No sync. | `social` |
| "Watch together" synced in rooms; Stage mode while something is live (R3) | A **shared-clock session**: the server holds only the start time. "N watching" shows only at 3+ and only among people who joined. Amends blueprint §1152 ("no synchronised co-watching in the initial version"). Build it after the Launch exists. | `rooms`, socket |
| Call it together before a part (only parts with an authored call, T3 Q7): guesses hidden until you lock yours; reveal after the party has watched | Uses `play` (§2) and `thread_places`. A lock is a shared contribution. The reveal waits until every member who shares their place has finished. Correctness never feeds ranking. Aggregate room or thread calls feed a Scroll's "common guess" only past 30 calls (R3 Q16), with no per-person data. | `play`, `social` |
| What-if in threads: any member, up to 5 per thread **per day** (T3 Q8), as a branch card from writer JSON (assumption, changed, kept, answer, numbers), labelled "What-if, made by KnowScroll", checked like a Scroll, about a 30 s honest wait; "Call it first" only after checks pass | Change the scenario caps from 6 per thread in total to **5 per thread per day**. The **short answer card** is a new worker role with its own validator (claims cite, assumption line mandatory). It is not a full Scroll, but it opens into the full branch Scroll where one exists. | `scenarios`, `supply`, `content/production` |
| One shared game layer: Sparks, Orbits (3 days a week of anything), flair, landmarks | **One `play` module** shared by Scrolls, rooms and threads. Rooms own stars and constellations. Flair from Scroll calls shows only if the person chooses (it reveals reading behaviour). | `modules/play` |

## 4. Decisions to record before building (owner rulings and resolved conflicts)

Record each item as a numbered decision in `docs/v2/decisions.md`. Take the next free number after
checking `origin/dev`; D-059 is the last today. Name the blueprint lines or earlier decisions each one
amends. **Do not edit the blueprint itself:** it stays identical to the owner's copy, and the
amendments live in `decisions.md` and the `AGENTS.md` product rules.

**Owner rulings (29 Oct 2026), to record as given:**

1. All of the following designs are final: the New Universe file, world internals 05, simple views,
   entering a system, V3 Scrolls, R3 Rooms and T3 Talk. Every "my pick" and "LEANING" is decided.
   The newer design wins where two overlap.
   Added on 30 Oct 2026: the animations first open, entering a planet, entering a ringed planet and
   entering a world are final too ("Never change it"), with the New Universe file updated to match.
2. Access for the build session: GitHub Write plus VPS root SSH, and no provider keys on the
   machine. Real model calls run only through the dev worker.
3. Earlier, and still binding: Scrolls are game-like (26 Oct). Rooms are alive, with unprompted
   Explainer and Skeptic, a notice shown once, General first, per-room art and game feel (26 Oct).
   AI is always labelled.

**Rules the final designs change.** The owner's ruling decides these; record the amendment:

| Rule today | Amended to |
|---|---|
| AGENTS: "Consumer UI never shows … scores" | "…never shows internal ranking, model or evidence scores." Game points (sparks, landmarks, stars, podium) are play-layer features. |
| AGENTS / blueprint / D-046: peer positions private | A member may share a **coarse part-level place** with a thread they joined; "hide where I am" is per person. Playheads, branches and seen markers stay private. |
| D-042: read state private, no typing indicator | Mutual **SEEN** receipts in DMs, on by default. Typing is used only as an ephemeral, never-shown signal that suppresses AI. |
| D-051: AI speaks only when asked; no counts or presence | Residents speak unprompted under a room scope with caps; presence and counts follow R3's honesty rules. |
| D-051 R03: quizzes never scored | The Launch is a new scored activity; moderator polls and quizzes stay unscored. |
| D-040: no horizontal swipe in Scrolls | Swipe left/right moves between Parts from text and stop surfaces only; the stage and gesture blocks keep their drags; native edge zones stay platform Back. |
| D-026: SVG-only Universe | three.js for space views; SVG for the landed map; plain lists for Simple drawing. |
| D-039: route lines drawn | No route lines; the route is a chip. |
| Blueprint §1152: no synchronised co-watching | A shared-clock Watch together in rooms only (start time only, "N watching" at 3+). |
| Scenarios: 6 branches per thread in total | 5 per thread per day, plus the short What-if answer card. |
| E08/D-040 "no counts or progress" | Counts, minutes, "3 min · 3 calls", the spine and Orbits are allowed for Scrolls. "You learned" and mastery wording stay banned. |

**Implementation choices the designs leave open.** These are the session's decisions within the
blueprint. Record them, list them for the owner under "Waiting for owner", and continue:

- Planet types are unique while possible (least-used first, then by system); a repeat gets a new hue
  and layout. The look is assigned once and persisted in `scenes.looks`, with a backfill.
- "Not yet reached" land uses the exact facet sites plus decorative grey; it is never labelled,
  counted or interactive.
- Lately keeps the 30-day quiet window and gains a rules-only sweep. The ship marks the planet of the
  last place, and stays device-local.
- The room "Stage manager" is code, not a model.
- Play data is erased by Clear and by account deletion, and included in export. **While recording is
  paused, play works on the device but saves nothing on the server**, and the screen says so.
- A landmark earned before its planet forms waits in a tray, then attaches when the planet forms.
- Quick answers and Simpler (V3 D2) are built without a model call on the HTTP path. Simpler is
  authored at production. A Quick answer is a capped worker job, labelled, and never evidence.
- **Design-to-design conflicts on the Universe map.** The New Universe file (28 Oct) is the authority
  for anything drawn there:
  - The V3 weekly **Orbit ring around the star** clashes with "no orbit lines, no sparkles". Show the
    Orbit in the Scroll recap, the play summary and the Universe panel or list text, not as a ring on
    the map.
  - V3's **"clear skies thin as you finish Scrolls"** clashes with clouds meaning "not reached yet".
    Don't build cloud thinning.
  - **Landmarks** are drawn as small painted markers on the planet's globe and map, in the Universe
    style.
  - The room **constellation** is drawn with the station in the Universe style.

  Post all four for the owner.
- Painted room backdrops: none until the owner approves an image provider and budget.
- **Open in the animation design** (New Universe file, Animations, "Edge cases and open questions"):
  where first open ends when the account already has places, and reverse animations for going back
  up (until designed, a 0.3 s cross-fade). Post both for the owner.

## 5. Order of work

The detail is in each findings file's §7. The coordinator turns the slices into issues and runs
them in parallel lanes, with at most about 4 heavy agents at once.

- **Lane U (Universe):** U-0 three.js plus `expo-gl` spike on web and the Android lane → U-1 look
  data (`scenes.looks`, `haze`, `site`, backfill) → U-2 space views in 3D → U-3 quiet sweep → U-4
  globe and landed map → U-5 search, orbit dial, Simple views, desktop D02 → U-6 friend visit and
  the five animations (first open, entering a system, a planet, a ringed planet and a world).
- **Lane S (Scrolls and personal algorithm):**
  - S-0: a 20-topic writer spike for `scroll-document.v2` on real MiniMax through the dev worker.
    Deploy the spike branch to dev by manual dispatch.
  - S-1: the Stage + Spine reader for Seasons, with coverage v2 and Composer `same_series` plus
    sticky format.
  - S-2: Call it and the `play` module. S-3: Final call, landmark and the E1 payoff.
  - S-4: the Universe collection overlay (needs U-2 and U-4).
  - S-5: Composer policy v1, `activity.v1`, playLevel cells and `jev.2`.
  - S-6: library regeneration in waves. S-7: Ask D1 with ask orders.
  - S-8: more blocks and kit. S-9: Simpler and Quick answer, Challenge a friend, and the Reels top
    bar.
- **Lane T (Talk):** T-A thread readable on a phone → T-B the Universe look, DM basics, reactions
  and replies → T-C SEEN and the theme setting → T-D party places → T-E Call it together (after S-2)
  → T-F What-if answer cards.
- **Lane R (Rooms):**
  - R-1 Campfire, General first, presence, AI level, keep-out.
  - R-2 residents at home: the room scope, the `ambient` class, the code router, and the raised dev
    caps.
  - R-3 asks, challenges, topics and the away summary. R-4 the room's face (kit).
  - R-5 Today and the sky: stars, constellation and the lit station (needs U-2).
  - R-6 the Launch. R-7 the quiet room and the replay.
  - Later: the residents' feed, then scouts, then synced Watch together.
- **Last:** design fidelity for every final screen at phone and desktop widths; journeys on dev
  with real services; the handover.
