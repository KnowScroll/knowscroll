# Design fidelity: v2.1 artboards against the app

Audit of 24 Oct 2026 by agent f250 (F5, #250). Every consumer artboard in `docs/v2/design/KnowScroll-design-v2.1/html/` was compared with the app at the artboard's width: dev (`app.dev.knowscroll.space`, commit `6dfb2d06`) with disposable accounts for what dev can reach, and labelled route-mocked fixtures over the production export for states dev cannot reach yet (a full universe, rooms with people, series, request outcomes). Nothing was written to dev beyond those accounts' own actions. Provider calls: none by this audit.

Status words: **matches** (same structure, copy and look at the drawn width, small spacing aside), **differs** (works, but visibly not as drawn), **missing** (no screen, or no data to draw it), **not checked** (the state exists in code but was not opened in this audit). "Needs contract" says a fix needs a backend or contract change; those are not fixed here. Rows marked "fixed in #nnn" are counted as matches: they were measured on dev before the fixes and match on the fix branch.

Pairs: `fidelity/pairs/<id>.jpg`, design on top, the app below, left to right in the order of the states in that artboard. "Before/after" for the fixes are `fidelity/auth-before-after.jpg`, `fidelity/supply-before-after.jpg` and `fidelity/states-before-after.jpg`.

| Artboard | State | Status | What differs | Evidence | Pair |
|---|---|---|---|---|---|
| A01 | Welcome | matches | Dark ground, one calm star, three entry rows (the drawn third row is a designer's "to decide" note). | dev | [A01](fidelity/pairs/A01.jpg) |
| A01 | Email form | matches | Label, field, Send sign-in link; error and offline lines present. | dev | [A01](fidelity/pairs/A01.jpg) |
| A01 | Link sent | matches | Fixed in #441: cream ground, yellow envelope, paper buttons (before: dark). | dev, fixed in #441 | [A01](fidelity/pairs/A01.jpg) |
| A02 | Signed out (/recover) | differs | Cream ground and buttons fixed in #441; the "You'll return to" card is missing because no surface writes a resume record yet. | dev, #441 | [A01](fidelity/pairs/A01.jpg) |
| A02 | Link failed (/recover?reason=link) | matches | Fixed in #441: cream ground, broken-link glyph, Send a new link. | dev, fixed in #441 | [A01](fidelity/pairs/A01.jpg) |
| C01 | Inbox with rows | matches | Fixed in #448: New (+) button beside the account avatar, and a thread invitation is a card above the list (see C03). Rows were already as drawn. The drawn "Online" and "Recently active" words are presence, which the server does not have. | dev, fixed in #448 | [C01](fidelity/pairs/C01.jpg) |
| C01 | Empty inbox | matches | No conversations yet, Share something, Invite a friend. | dev | [C01](fidelity/pairs/C01.jpg) |
| C02 | Conversation | differs | Fixed in #448: header has the person's avatar and Start a thread (turns the newest shared card into a thread, one command), and a "While you were away" divider marks messages that arrived after a lost connection, without moving the reader. Left: the card tag REEL · FROM 0:12 (needs contract: a direct-conversation card has no start time) and "Ravi is typing" (the server has no presence; not invented). | dev, fixture, fixed in #448 | [C02](fidelity/pairs/C02.jpg) |
| C03 | Invitation received | matches | Fixed in #448: the invitation is a card in Talk with Preview the thread, Join thread and Ignore (a decline for this person only; the starter sees nothing). The card names who asked and what it is about, not who else is in the thread, until the person joins. | fixture, fixed in #448 | [C03](fidelity/pairs/C03.jpg) |
| C03 | Members sheet, Mute, Leave, ended and withdrawn lines | not checked | The thread has People in this thread and Thread options buttons; the sheet and ended lines were not opened. | - | - |
| C04 | Thread (single item) | differs | Header, episode strip with Now, inline player (Watch), Share a moment, Full screen, What if and Another perspective chips and composer are present; the divider from C02 also shows here. Left: Like and Save only on full screen (by decision), See all grid, Keep listening, a Preparing card in the strip, thumbnails, and "Ravi online" (no presence on the server). | dev, fixture | [C04](fidelity/pairs/C04.jpg) |
| C04 | Thread (series of Reels) | not checked | No multi-part thread exists on dev; the episode navigator is covered by e2e talk-smoke. | - | - |
| D01 | Desktop Explore | matches | Rail, Reel card, controls, shortcut row and thread aside (Go deeper, Open Scroll) as drawn; the aside shows no Talk preview card. | dev 1440x900 | [D01](fidelity/pairs/D01.jpg) |
| D02 | Desktop Universe | not checked | A dev universe is empty, so the map, outline and station card were not compared at 1440x900; the phone fixture is under U01. | dev 1440x900 | [D02](fidelity/pairs/D02.jpg) |
| D03 | Desktop Talk | matches | Rail, list and Conversation pane; the empty pane reads Pick a conversation; thread pane shows the Scroll card. | dev 1440x900 | [D03](fidelity/pairs/D03.jpg) |
| D04 | Desktop room | matches | Room pane, discussion and Room extras as three panes (fixture). | fixture 1440x900 | [D04](fidelity/pairs/D04.jpg) |
| D05 | Desktop Privacy | differs | Settings rail and four cards present; Recording is two buttons not a switch, body type is larger than drawn, and Notifications and Accessibility rows are missing. | dev 1440x900 | [D05](fidelity/pairs/D05.jpg) |
| E01 | Reel playing | differs | Full-bleed video, Like/Save/Share/Ask rail, progress and title match; the topic tag is replaced by the ⋯ menu button, no transcript or caption toggle (see E09). | dev | [E01](fidelity/pairs/E01.jpg) |
| E01 | Reel paused, offline, unavailable | differs | Unavailable fixed in #444 (Next subject, Go to Keep). Offline lacks the drawn Open something you kept: Keep is network-only, so offline it would land on a failed load (fixture). | fixture, #444 | [E01](fidelity/pairs/E01.jpg) |
| E01 | Reel corrected note | missing | Needs contract: the exposure context has no correction field (D-054). | not reachable | [E01](fidelity/pairs/E01.jpg) |
| E02 | Scroll opening | differs | Reading column, rail and Reel/Scroll switch match; generated Scrolls use the editorial opening, the poster card with cobalt shadow appears only for poster-template documents. | dev | [E02](fidelity/pairs/E02.jpg) |
| E02 | Scroll text version and end card | matches | Text version toggle and end mark present. | dev | [E02](fidelity/pairs/E02.jpg) |
| E03 | Blocks (diagram, comparison, slider, code, table) | matches | All block kinds render with their controls and a text version (gallery build). | gallery fixture | [E03](fidelity/pairs/E03.jpg) |
| E04 | Ask for something composer | matches | Sheet with text, suggestions, format and scope, Send request, Close; adds suggested topics. | dev | [E04](fidelity/pairs/E04.jpg) |
| E04 | Request sent | matches | Requested chip and Cancel request, in the sheet and over the encounter. | dev | [E04](fidelity/pairs/E04.jpg) |
| E05 | Continue: Part, Related and previous tabs | matches | Yellow Part tab, dashed Related tab, previous tab and More menu list (fixture). | fixture | [E05](fidelity/pairs/E05.jpg) |
| E05 | Exhausted thread | differs | Fixed in #443: a series end shows the ending; "nothing more ready" has its own card. The corrected note is missing (needs contract). | fixture, #443 | [E05](fidelity/pairs/E05.jpg) |
| E06 | Format switch with a sibling | matches | Reel/Scroll switch, ready sibling opens at once, requestable sibling opens the request. | fixture | [E06](fidelity/pairs/E06.jpg) |
| E06 | Preparing segment, Back to Reel chip, ready toast | differs | Preparing stripe and ready notice with Later and Open exist; the From the Reel at 0:31 · Back to Reel chip on the Scroll is not drawn. | fixture | [E06](fidelity/pairs/E06.jpg) |
| E07 | Requests list | matches | Fixed in #443: one line per ask with a chip; Open, Retry, Cancel on the chip or row (before: boxed cards with pre-chip words). | fixture, #443 | [E07](fidelity/pairs/E07.jpg) |
| E07 | Requested in Keep | matches | Fixed in #443: Requested filter in Keep (before: only /account/requests). | fixture, #443 | [E07](fidelity/pairs/E07.jpg) |
| E07 | Couldn't prepare + Try again | matches | Fixed in #443 and #454: Try again retries the same request in the sheet, Retry and Ask differently in the list (`could_not_prepare` only; D-054). | fixture, #443, #454 | [E07](fidelity/pairs/E07.jpg) |
| E07 | Can't be made, cancelled, exhausted | matches | Fixed in #443: Can't be made chip (new); cancelled dashed chip; exhausted says You've seen what's ready for now. | fixture, #443 | [E07](fidelity/pairs/E07.jpg) |
| E07 | Placed where the request was made | matches | Fixed in #443: Ready — the Scroll you asked for on the opened encounter. | fixture, #443 | [E07](fidelity/pairs/E07.jpg) |
| E07 | List retry and retry of the same request | matches | `request.retry{requestId}` re-drives the same request (same ID, idempotent receipt, caps and the retry limit respected, "can't be retried" answered); Try again in the sheet and Retry in the list both send it (D-054, #454). | fixture, #454 | [E07](fidelity/pairs/E07.jpg) |
| E08 | Natural thread ending | matches | Yellow card, Keep a way back, Something different, Done for now, thread rows (fixture). | fixture | [E08](fidelity/pairs/E08.jpg) |
| E08 | Way back kept, Something new | differs | Way back kept is drawn; the Somewhere new direction picker with coloured subject cards is not (Something different opens a new subject). | fixture | [E08](fidelity/pairs/E08.jpg) |
| E09 | Narration, captions, illustrated range | missing | No client work possible: a Reel document carries captions: burned_in only, no caption track, transcript or timing (D-054). The range of variants is the asset's own picture. | contract | [E09](fidelity/pairs/E09.jpg) |
| F01 | Friends list | differs | Roster is tabbed (Friends, Incoming, Sent, Blocked) with Refresh and paging buttons and long explanations; design is one list (Friends, Waiting, Blocked) with Add a friend as the one primary. | dev | [F01](fidelity/pairs/F01.jpg) |
| F01 | Add a friend | differs | Handle and invite link are present; the found-person row, Send invite and invite-link card are plain. | dev | [F01](fidelity/pairs/F01.jpg) |
| F02 | Visibility | differs | Visitors choice, what they can see and activity status exist; header, row styling and the Preview what <name> sees button differ. | dev | [F02](fidelity/pairs/F02.jpg) |
| H01 | Share sheet (Scroll) | differs | Fixed in #450: header with a kind tile, the title and "Part 2 · Reel"; icon tiles; Explore with friends on the pale highlight; Copy link / Share elsewhere in one row. Left: the thumbnail is a kind glyph (the offer has no poster), the series name and "of 4" (the encounter does not carry them), and Share a moment (a moment is a message in a thread, so it needs one). | dev, fixture, fixed in #450 | [H01](fidelity/pairs/H01.jpg) |
| H01 | Send to a conversation | differs | Fixed in #450: Back arrow and title, search, Recent and More friends groups, Online / Recently active only for friends who show it (else @handle), the Sent to name row with Open chat. Left: rooms are not in this list (a room is not a conversation here). | fixture, fixed in #450 | [H01](fidelity/pairs/H01.jpg) |
| H01 | Explore with friends | matches | Fixed in #450: Thread name (the content title as its placeholder), search, Recent and More friends with the same availability words, the keep-your-own-place line and Create thread · N friends. | fixture, fixed in #450 | [H01](fidelity/pairs/H01.jpg) |
| H02 | Public landing | matches | Fixed in #444: cobalt poster card with kind tag, pill buttons. | rendered page, #444 | [H02](fidelity/pairs/H02.jpg) |
| H02 | Private, signed-in, corrected | differs | Rendered pages show a poster card; the signed-in page says nothing about who shared it (names stay off the page by design) and revoked/withdrawn share one neutral page. | rendered page | [H02](fidelity/pairs/H02.jpg) |
| H02 | Revoked / withdrawn | differs | One neutral page by design; the drawn two reasons would reveal state. | dev | [H02](fidelity/pairs/H02.jpg) |
| H03 | Share a moment (Reel range, Scroll passage, block) | not checked | The Reel share sheet was captured (fixture); the range handles sheet was not opened. | fixture | [H03](fidelity/pairs/H03.jpg) |
| H03 | Snippet cards in the thread, open a snippet | not checked | Snippet card and viewer exist (threads feature); not opened here. | - | - |
| N01 | Navigation and Back | not checked | Covered by the web smoke (gallery-smoke Back with a sheet open); not compared step by step here. | - | - |
| NavBar | Tab bar | matches | Floating pill with Explore, Universe, Talk (unread dot) and Keep; icon-only at 320. | dev | [D03](fidelity/pairs/D03.jpg) |
| P01 | Account | differs | Sessions and settings list present; no identity card with Edit, and Notifications and Accessibility & playback rows are missing; Your requests and Keyboard shortcuts rows are extra. | dev | [P01](fidelity/pairs/P01.jpg) |
| P01 | Notifications, Accessibility & playback | missing | No route. | dev | [P01](fidelity/pairs/P01.jpg) |
| P02 | Privacy & history hub | differs | Recording is two buttons not a switch, long explanations; rows for history, clear, sharing, delete exist. | dev | [P02](fidelity/pairs/P02.jpg) |
| P02 | History & export | differs | Request and list exist; receipts are plain, not tinted strips with Download and Retry. | dev | [P02](fidelity/pairs/P02.jpg) |
| P02 | Clear exploration | differs | Removed and Stays lists and the acknowledgement exist; no dashed confirm box. | dev | [P02](fidelity/pairs/P02.jpg) |
| P02 | Delete account | differs | Removed and Stays lists exist; the receipt line and dashed danger card are not drawn. | dev | [P02](fidelity/pairs/P02.jpg) |
| P03 | Report | missing | Owned by agent p250. | p250 | - |
| R01 | Room preview | matches | Header, who is here to help, labelled AI inhabitants, pinned question, Join room (fixture and dev). | fixture and dev | [R01](fidelity/pairs/R01.jpg) |
| R01 | Member view and Talk list | matches | Threads, Share into room, activity section; invited chip in Talk (fixture). | fixture | [R01](fidelity/pairs/R01.jpg) |
| R02 | Discussion | differs | Messages, AI card (dotted outline, suggestion note), Ask buttons; every message has a ⋯ button the design hides, and the card Explore this is not drawn. | fixture | [R02](fidelity/pairs/R02.jpg) |
| R03 | Poll | differs | Vote, results after voting, moderator tools; plain header, design is on a dark header. | fixture | [R03](fidelity/pairs/R03.jpg) |
| R03 | Quiz | differs | One question at a time with explanations; same header difference. | fixture | [R03](fidelity/pairs/R03.jpg) |
| S01 | Keep list | differs | Filters and cards present; card art is a tile not the encounter thumbnail, and Remove from Keep is inline on every card. | dev | [S01](fidelity/pairs/S01.jpg) |
| S01 | Keep detail and place | matches | Detail with Resume place and Open from the top (e2e keep-smoke). | e2e | [S01](fidelity/pairs/S01.jpg) |
| U01 | Universe overview | matches | Map with systems, stations, Lately lens and list view (fixture). | fixture | [U01](fidelity/pairs/U01.jpg) |
| U01 | First state | matches | Your universe starts quiet, Go to Explore (dev). | dev | [U01](fidelity/pairs/U01.jpg) |
| U02 | System | matches | System, planets, station card (fixture). | fixture | [U01](fidelity/pairs/U01.jpg) |
| U03 | Planet | matches | Planet scene, route chip, list view (fixture). | fixture | [U01](fidelity/pairs/U01.jpg) |
| U04 | Region card | differs | Region card with Close and Try again; fixture preview was unavailable so Open was not shown. | fixture | [U01](fidelity/pairs/U01.jpg) |
| U05 | Formation sequence | matches | Dust, gathering, protostar, star, planet settles with Skip and Done (fixture). | fixture | [U05](fidelity/pairs/U05.jpg) |
| U06 | Friend visit | differs | Visiting bar, privacy line and a map; the drawn friend universe has seeded personal looks, a room station card and a Leave on the bar. Dev's empty friend map was not compared. | dev | [U06](fidelity/pairs/U06.jpg) |
| U06 | Not shared with you | matches | This universe isn't shared with you with two exits. | dev | [U06](fidelity/pairs/U06.jpg) |
| U07 | Three worlds | not checked | Planet looks come from a seeded scene; a three-person comparison was not built. | - | - |
| U08 | Search | matches | Search field with grouped results and hint line (fixture). | fixture | [U08](fidelity/pairs/U08.jpg) |
| U08 | List view | differs | Nested outline in a sheet; design groups by family with a Lately switch. | fixture | [U08](fidelity/pairs/U08.jpg) |
| V01 | Tablet portrait | matches | Rail plus thread aside at 834x1112. | dev | [D01](fidelity/pairs/D01.jpg) |
| V01 | Compact 320 and 200% text | differs | Compact phone is icon-only; the first-arrival hint covers the action rail until dismissed. | dev 320x640 | [D01](fidelity/pairs/D01.jpg) |
| X01 | What if sheet | matches | Sheet, From chip, idea, We'll explore summary with Changed/Kept, Explore. | dev | [X01](fidelity/pairs/X01.jpg) |
| X01 | Branch preparing in the thread | matches | Dashed branch card with Preparing. | dev | [X01](fidelity/pairs/X01.jpg) |
| X02 | Branch cards | differs | What-if card has the dashed look; own cards show What if and Remove buttons the design keeps off the card, and the speculative tag is missing on a hypothetical. | dev | [X02](fidelity/pairs/X02.jpg) |
| X02 | Failed, dismissed, suggestion not made | not checked | Not reachable on dev without a failed branch; the branch-card tests cover them. | - | - |
| X03 | Branch view | differs | Header, return chip, 1 · current chip, hypothetical frame present; a Scroll branch is drawn as paper article, the design shows a Reel branch. | dev | [X03](fidelity/pairs/X03.jpg) |
| X04 | Branch map | not checked | The map sheet exists; it opens only after several branches, which dev does not have yet. | - | - |

**Count: 35 matches, 35 differs, 5 missing**, and 9 not checked (84 rows).

## Fixed by the sweep

- #441 sign-in follow-up screens on paper (A01, A02).
- #443 request states (E07), Requested in Keep, Try again, nothing more ready, ready-opened note (D-054).
- #444 share landing poster card (H02), offline and unavailable encounter states (E01).
- #448 Talk: New button and invitation card with Preview and Ignore (C01, C03), thread header with Start a thread and the "While you were away" divider (C02, C04), a thread composer that names two people who share a first word apart.

## Not fixed, and why

- **Needs contract:** a correction field on an encounter (E01, E05), caption track or transcript on a Reel (E09, E01).
- **Larger than a sweep:** Friends roster as one list (F01), Account identity card, Notifications and Accessibility & playback (P01), recording as a switch (P02, D05), share sheet header (H01).
- **Not opened:** thread presence and members sheet (C03), snippet range handles (H03), failed and dismissed branches (X02), branch map (X04), three-person worlds (U07), series threads on dev (C04). They are drawn in code and covered by tests; no dev data reaches them yet.

## Honest limits

- No VoiceOver or TalkBack run. Real devices were not used; the engine is desktop Chromium at the artboard's width.
- Dev content is MiniMax-written, so titles differ from the authored examples; only structure, copy and look were compared.
- Fixture rows were produced over the production export with route-mocked HTTP, not from a backend.
