# KnowScroll — complete product design brief

Updated 19 October 2026. Design handoff for a fresh implementation, not a request to implement the backend. Read with [the blueprint](02d-greenfield-blueprint.md) and [reference guide](design-references/README.md). The owner explicitly retired the Software Factory workflow. No PIO.

**19 October social-flow revision:** the owner selected an integrated content thread for friends and idea rooms after reviewing the first design export. Keep the existing visual theme; replace the fragmented conversation → invitation → separate scenario workspace with one thread containing the episode navigator, encounter, messages, snippets and inline exploration cards. Frame IDs below describe capabilities/states, not mandatory separate pages.

## Product intent

KnowScroll helps someone discover themselves through the evolving way they understand the world. It feels like effortless, enjoyable scrolling with thoughtful, visually compelling content. Reels and interactive Scroll articles are equal encounter formats. The universe makes accumulated exploration visible without announcing a psychological interpretation, learning result or score.

A user can watch ML Reels, read history Scrolls, ask for football right now, and return to a calm ML system later. Immediate intent changes the next encounter rapidly. Lasting geography needs accumulated qualified exploration. A person who never presses Like can still develop a universe. Do not put the scoring or formation thresholds into consumer UI.

Do not design a classroom, productivity dashboard, generic AI chat home, consumption leaderboard or compulsory onboarding questionnaire. Optional user-authored asks are welcome. No routine quizzes or tests in the feed; optional activities may exist only inside deliberately entered rooms. Keep entry easy, depth inviting and exits satisfying. No missed-reward pressure, attendance streak or destruction after absence.

## Selected implementation context, for feasible design

One Expo application targets Android/iOS with React Native and browser with React Native Web. Reuse components and meaning while adapting layouts, text selection, media, native sharing and keyboard/back behaviours appropriately. The backend will use TypeScript, NestJS with its Express adapter, PostgreSQL, pnpm and Socket.IO. These internals should not appear as consumer interface labels.

Design the universe as a coherent visual system before deciding 2D/canvas versus 3D. There is no requirement for WebGL, Three.js or photorealistic planets. Depth can come from composition, light, texture and motion. Preserve an accessible navigable alternative and reduced-motion version. This task produces editable screens, components and an interactive design prototype, not a production application.

## Current theme to evolve

Two registers belong to the same product:

| Register | Existing identity to retain | Improve |
|---|---|---|
| Content / social / ordinary controls | Warm paper `#FFFBF0`, near-black `#111111` (web variant `#111214`), cobalt `#2C46E8`, yellow `#FFE44D`, teal `#14C79B`; bold editorial headings, crisp outlines and rich diagram blocks | Reading rhythm, comfortable body size, action placement, hierarchy and consistent component variants |
| Spatial universe | Deep navy web ground `#050B19` / raised `#0B1630`; Cosmos references also use `#03101A` / `#061A27`; teal water, angular continents, restrained glowing stars, delicate orbits, cream floating controls | Spacious compositions, readable labels, direct navigation, distinct worlds and calm motion |

Use Bricolage Grotesque for expressive headings; Instrument Sans is the current body family; DM Mono is present in native micro-labels, while current web labels use a system monospace stack. Treat this as an opportunity to unify tokens, not a claim every platform already matches. Specify semantic tokens with light-content/dark-spatial roles; do not blindly apply one palette to every screen.

Retain the approved poster Scroll and spacious universe/system composition. Avoid overlapping oversized globes, long colliding labels, large metadata sheets as the primary planet interaction, and generic grey dialogs with teal links. Reference screenshots may contain obsolete sources, debug captions, counts, moon semantics and old navigation: retain visual qualities only where consistent with this brief.

Source-grounded reference details and copied images are in `design-references/`. Old source inspection is not a live-runtime or animation-equivalence claim. Fresh product semantics outrank older prototype behaviour.

## Complete frame inventory

Every row needs a primary mobile frame and a desktop adaptation, or a documented shared overlay/component variant. Frame IDs remain stable across iterations. Each applicable loading/empty/offline/failed/denied/revoked/corrected state needs an explicit variant; a single generic error frame is insufficient.

| IDs | Surface and required contents | Key variant / interaction |
|---|---|---|
| A01–A03 | Entry/sign-in, recovery/expired session, lightweight first arrival | Easy entry without interest survey; no invented auth-provider commitment |
| E01 | Dimensional TV Reel feed | Video/captions, Like, Save, Share, optional Ask, equal Reel/Scroll access, continuation and next topic |
| E02 | Full Scroll article | Strong title, sustained readable prose, rich approved blocks; same core actions |
| E03 | Interactive Scroll block gallery | Diagram, comparison, slider-driven example, disclosure and code block; accessible alternatives and gesture ownership |
| E04 | Topic/content request | Optional concise composer, chosen format/context, pending/ready/unavailable; no general chatbot takeover |
| E05 | Horizontal continuation | Distinguish actual series Part 2 from another mechanism/example/angle; back/return position |
| E06 | Format conversion | Existing variant versus preparing requested variant; preserve original position and context |
| E07 | Supply waiting and availability | Quiet pending, ready notification, failure/retry/cancel and honest exhaustion; no made-up percentage |
| E08 | Natural thread ending | Satisfying stop, save a return path or choose another topic; no guilt |
| S01–S02 | Saved library and saved-item detail/resume | Empty, unavailable/corrected and restored reading position |
| U01 | Universe overview | First empty environment, emerging, established and returning after absence; distinct personal systems |
| U02 | Topic system | Organising star, subtopic planets, routes and station; readable composition |
| U03 | Planet close-up | Direct spatial arrival, optional ship, meaningful entry into regions; not a metadata-first sheet |
| U04 | Planet regions / topic card | Fine-grained areas with direct encounter entry; concise context overlay |
| U05 | Formation transition storyboard | Dust/protostar/system/planet change after an actual committed change; skip and reduced motion |
| U06 | Friend universe visit | Different but recognisable worlds, visitor identity, visibility and revoked access; no exposed private interests |
| H01 | Share sheet and friend picker | Send to conversation / Explore with friends / copy link / external share; search, recent contacts, checkboxes, visibility-controlled availability, Create thread · N friends |
| H02 | Share landing / invitation | Exact content revision, signed-out/access-required/available/revoked/withdrawn variants |
| C01 | Conversation inbox | Real conversations, unread state, connection/retry state; no fabricated active users |
| C02 | Conversation and integrated content thread | Root Reel/Scroll, horizontal episode strip, collapsible player, text/replies, snippets, inline exploration cards, typing/retry and block/report |
| C03 | Content-thread invitation | Root content, participants and exact shared scope; accept/decline/revoke for new participants, no repeated invite for each authorised branch |
| X01 | Inline exploration input | What if changes assumptions; Another perspective changes the lens. Start from content, snippet or message; suggestions optional |
| X02 | Inline branch options | Several bounded suggestions; explicit selection commissions content; complete direct request skips redundant selection. Preparing/ready cards stay in the thread |
| X03 | Sequence within the content thread | Distinct episode thumbnails/ordinals, caller-only viewed/current states, ready/upcoming versus preparing, branch context and exact return from full-screen playback |
| X04 | Branch history | Root, parent, alternatives and current path; readable on narrow screens, no giant unreadable graph |
| R01 | Cosmic room preview/discovery | Station location in personal geography; room topic and access state; no fake activity counts |
| R02 | Cosmic room discussion | Human participants, scoped content threads, moderator controls, labelled AI inhabitants, replies and moderation; no room-wide forced branch |
| R03 | Optional room activity | Poll/discussion prompt or optional quiz inside room; never required for universe formation |
| H03 | Snippet composer and card | Reel timestamp/range; Scroll passage/block; optional explicitly included diagram configuration; source unavailable/corrected/denied variants |
| R04 | Room content thread | Reuse C02/X01–X04/H03 within one room discussion; another simultaneous room discussion remains independent |
| F01–F02 | Friends/invites and sharing settings | Handle/invite-link discovery, pending/accepted/blocked/revoked, visibility controls; no address-book upload assumption |
| P01 | Account/settings | Session access, notifications, accessibility/reduced motion, playback and general preferences |
| P02 | Privacy/history | Pause recording, export, scoped clear/reset and account deletion; precise consequences and pending/completed/failed receipts |
| P03 | Feedback/report | Hide/not interested, content error, abuse report; no mandatory justification for simple preference |

Navigation labels and placement are a design decision, but every listed destination must be reachable without overcrowding the main feed. Use familiar social actions; preserve KnowScroll's identity. Friend management and sharing settings support the authorised social scope; no public leaderboard or follower economy is requested.

## Interaction requirements

Vertical browsing changes subject; horizontal browsing follows the current idea. Horizontal moves can be declared sequels or related continuations, with different visual cues. A format variant is the same explanation in a different representation. A what-if branch changes assumptions. Series, related perspective, format variant and hypothetical branch must remain distinguishable.

In a long Scroll, vertical movement reads first. Reaching the bottom with existing momentum must not eject the reader. Show an explicit next affordance and allow a fresh deliberate transition. Charts/sliders retain their gesture until release. Native back-edge gestures, browser text selection and keyboard scrolling must remain usable. Restore the exact article anchor, player position, branch and camera when returning.

The universe uses broad topic systems with organising stars, subtopic planets and finer regions. Visual family resemblance makes ML recognisable across people, but routes, terrain and composition vary. Calm dormant worlds persist. No explosions, black holes or disappearance merely because someone stopped watching. Moons have no assigned semantic role in this version; if a reference shows one, treat it as illustration and do not invent a save-counter meaning.

A shared room has one identity but can occupy different positions in each person's universe. Human and AI inhabitants are distinguishable. The moderator organises discussion; AI inhabitants can converse and disagree without pretending to be humans or filling empty rooms with fake popularity.

Shared exploration never merges private profiles or forces one participant's player to follow another. Show participation clearly and leave playback independent by default. What-if content must visibly retain its hypothetical assumptions without exposing internal prompts or chain-of-thought.

## Integrated content-thread specification

- **Entry:** Share offers Send to a conversation, Explore with friends, Copy link and external sharing. The friend picker has search, recent friends/conversations, checkboxes, selected-person chips and Create thread · N friends. Show online/recently-active only under the person’s visibility preference; unknown is valid. Never reveal watched topics or fake availability. A thread may start from one Reel or Scroll, not only a series.
- **Composition:** header/participants → horizontal episode navigator → collapsible encounter → messages and inline exploration cards → composer. Desktop can place content beside messages. Provide full-screen playback with exact return and only one active player. Draw explicit touch/scroll regions and Back behaviour. Dragging the episode strip, reading the Scroll and scrolling messages must not navigate the whole feed.
- **Navigator:** distinct thumbnail/title and numbering for declared series parts. Viewed check marks and current highlight are the caller’s own history/selection, not shared progress or learning. Upcoming ready episodes remain selectable; Preparing and Suggested are separate states. Perspective alternatives are named branches, not invented Part 4s. Current selection alone never earns a viewed marker.
- **Snippets:** select a Reel moment/range or Scroll passage/block, optionally include validated diagram settings, add a message, send. The card links to the original revision; do not imply a freshly exported clip is required. Opening it restores the exact source location. Returning restores the message-list anchor and prior content context. Show corrected/unavailable/access-denied states honestly.
- **Exploration:** What if… changes an assumption; Another perspective changes the lens. Both can originate from root content, a snippet or a message. Offer a few suggestions or accept a complete direct request. Only a person’s explicit selection/request starts production. Inline cards move through preparing, ready and failure; the sequence opens in the same thread. The detailed branch map is secondary.
- **Shared scope:** messages, snippets, chosen branch requests and generated sequences are shared with authorised participants. Viewed markers, current branch/episode, playback anchors and personal universes are private. “Ravi requested More instances” is contribution history; do not display “Ravi is watching Part 1.” Online presence is not playback presence. New participants get an invitation; authorised participants need no extra join step per branch.
- **Rooms:** reuse the same components inside a particular room discussion. Several room discussions can explore independently. A moderator may pin/organise; an AI inhabitant can suggest or discuss, visibly labelled. Neither suggestion nor pin automatically commissions content. Room access does not grant access to a private source Reel or friend conversation.
- **Tone:** consumer labels describe actions and content. Keep gesture-ownership, telemetry, model/harness and implementation annotations outside the phone/browser UI.

## Connected prototype journeys

1. **Asha's encounter path:** first Reel about ML → related horizontal explanation → request Scroll → read and adjust a diagram → return to original position → fresh vertical topic → later revisit a subtly richer universe. Formation is represented as design data, not proof the prototype computed evidence.
2. **Asha, Ravi and Meera:** Share → Explore with friends → select two people → Create thread → Ravi joins and Meera arrives later → episode navigator with independent positions → send/open Reel range → return to same message → What if requests grow tenfold, model/latency target unchanged → select batching → inline Preparing/Ready → generated Reel/Scroll sequence → share passage/block settings → alternative branch → independently resume. Also show ordinary Send to conversation without creating a thread.
3. **Spatial exploration:** universe → ML system → inference planet → deployment region → encounter → return to the same region/camera → visit Ravi's visibly different ML world → enter the same shared room from a different map location.
4. **Room exploration:** enter a room discussion → create/open its content thread → share a snippet → explicitly choose a What-if or Another perspective suggestion → ready sequence → return to discussion. Show a second discussion staying unaffected; moderator pin and AI suggestion do not trigger production.
5. **Recovery/privacy:** failed send → retry once without a duplicate bubble; reconnect → missing messages appear in order; share revoked → access stops; paused recording → no personal growth claim; explicit clear/reset → clear consequences and honest completion/failure.

## Deliverables and review format

Create a Figma-like editable design workspace, using native Figma if available. Include a foundation/tokens board, reusable component library with variants, all page frames, state sheets, responsive adaptations, interaction annotations and clickable journey entry points. If Figma is unavailable, produce a self-contained interactive design artifact with a page index and editable structured source. Be explicit about the output format; do not claim a Figma file exists when it does not.

Start with a brief comparison to the existing references and identify what is preserved, refined and deliberately replaced. Then design the complete inventory. Use realistic authored example content instead of lorem ipsum and mark the artifact as a prototype; invented users/content are design examples, not product activity. Do not execute backend work, use PIO, publish externally or modify production data.

For each frame, annotate: route/origin, primary and secondary actions, overlay/state variants, emitted command/observation names, restoration behaviour, accessible name/focus/keyboard behaviour and platform-specific differences. Provide an inventory matrix with linked frame IDs so omitted pages are visible. Reuse state components rather than drawing redundant screens without explanation.

Reference sizes: phone 390×844, compact phone around 320px wide, tablet around 834px and desktop 1440×900; show responsive rules rather than promising these are the only devices. Provide portrait/landscape, larger text, keyboard, screen-reader and reduced-motion treatment. Keep at least 44–48 logical-pixel touch targets, readable article measure and non-colour status cues.

Internal logging is separate from consumer UI. Add a small operator appendix identifying required Grafana views (health, journey search, production, universe changes, realtime recovery, privacy/diagnostic health) and safe detail fields. Reuse operator tooling; do not turn the consumer app into a debug dashboard or spend the design task building a custom observability platform.

## Attachment priority

Minimum: this brief, `04-claude-design-prompt.md`, `design-references/README.md`, and the five numbered positive style targets. Add the current-web capture and two rejected examples for fidelity review. The blueprint is useful full architectural context. The supplied ZIP contains these in one portable folder; if the design tool cannot open ZIPs, unzip and attach the files individually. Original HTML references are optional and listed in the reference guide; they contain old behaviours and do not override this brief.
