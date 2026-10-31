# Design fidelity: v2.1 artboards against the app

Audit of 24 Oct 2026 by agent f250 (F5, #250). Every consumer artboard in `docs/v2/design/KnowScroll-design-v2.1/html/` was compared with the app at the artboard's width: dev (`app.dev.knowscroll.space`, commit `6dfb2d06`) with disposable accounts for what dev can reach, and labelled route-mocked fixtures over the production export for states dev cannot reach yet (a full universe, rooms with people, series, request outcomes). Nothing was written to dev beyond those accounts' own actions. Provider calls: none by this audit.

Status words: **matches** (same structure, copy and look at the drawn width, small spacing aside), **differs** (works, but visibly not as drawn), **missing** (no screen, or no data to draw it), **not checked** (the state exists in code but was not opened in this audit). "Needs contract" says a fix needs a backend or contract change; those are not fixed here. Rows marked "fixed in #nnn" are counted as matches: they were measured on dev before the fixes and match on the fix branch.

Pairs: `fidelity/pairs/<id>.jpg`, design on top, the app below, left to right in the order of the states in that artboard. "Before/after" for the fixes are `fidelity/auth-before-after.jpg`, `fidelity/supply-before-after.jpg` and `fidelity/states-before-after.jpg`.

| Artboard | State | Status | What differs | Evidence | Pair |
|---|---|---|---|---|---|
| A01 | Welcome | matches | Dark ground, one calm star, three entry rows (the drawn third row is a designer's "to decide" note). | dev | [A01](fidelity/pairs/A01.jpg) |
| A01 | Email form | matches | Label, field, Send sign-in link; error and offline lines present. | dev | [A01](fidelity/pairs/A01.jpg) |
| A01 | Link sent | matches | Fixed in #441: cream ground, yellow envelope, paper buttons (before: dark). | dev, fixed in #441 | [A01](fidelity/pairs/A01.jpg) |
| A02 | Signed out (/recover) | differs | Cream ground and buttons fixed in #441. The "You'll return to" card stays out: no surface writes a resume record, and a card that guesses where you were would not be honest. Recorded as intended. | dev, #441 | [A01](fidelity/pairs/A01.jpg) |
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
| D05 | Desktop Privacy | matches | Settings rail lists Notifications and Accessibility & playback; Recording is a switch in its own card; body type and the dashed danger card follow the design (fixture). | fixture, #449 | [D05](fidelity/pairs/D05.jpg) |
| E01 | Reel playing | differs | Full-bleed video, Like/Save/Share/Ask rail, progress and title match; the topic tag is replaced by the ⋯ menu button, no transcript or caption toggle (see E09). | dev | [E01](fidelity/pairs/E01.jpg) |
| E01 | Reel paused, offline, unavailable | differs | Unavailable fixed in #444 (Next subject, Go to Keep). Offline lacks the drawn Open something you kept: Keep is network-only, so offline it would land on a failed load (fixture). | fixture, #444 | [E01](fidelity/pairs/E01.jpg) |
| E01 | Reel corrected note | missing | Not built: the content model has revisions (Keep shows "Updated") but no authored correction note or date to show, and the exposure context has no field for one. Inventing text would break D-006 (a). | not reachable | [E01](fidelity/pairs/E01.jpg) |
| E02 | Scroll opening | differs | Reading column, rail and Reel/Scroll switch match; generated Scrolls use the editorial opening, the poster card with cobalt shadow appears only for poster-template documents. | dev | [E02](fidelity/pairs/E02.jpg) |
| E02 | Scroll text version and end card | matches | Text version toggle and end mark present. | dev | [E02](fidelity/pairs/E02.jpg) |
| E03 | Blocks (diagram, comparison, slider, code, table) | matches | All block kinds render with their controls and a text version (gallery build). | gallery fixture | [E03](fidelity/pairs/E03.jpg) |
| E04 | Ask for something composer | matches | Sheet with text, suggestions, format and scope, Send request, Close; adds suggested topics. | dev | [E04](fidelity/pairs/E04.jpg) |
| E04 | Request sent | matches | Requested chip and Cancel request, in the sheet and over the encounter. | dev | [E04](fidelity/pairs/E04.jpg) |
| E05 | Continue: Part, Related and previous tabs | matches | Yellow Part tab, dashed Related tab, previous tab and More menu list (fixture). | fixture | [E05](fidelity/pairs/E05.jpg) |
| E05 | Exhausted thread | differs | Fixed in #443: a series end shows the ending; "nothing more ready" has its own card. The corrected note is missing for the same reason as E01 (no authored note in the content model). | fixture, #443 | [E05](fidelity/pairs/E05.jpg) |
| E06 | Format switch with a sibling | matches | Reel/Scroll switch, ready sibling opens at once, requestable sibling opens the request. | fixture | [E06](fidelity/pairs/E06.jpg) |
| E06 | Preparing segment, Back to Reel chip, ready toast | matches | The Scroll opened from a Reel's switch shows "From the Reel at 0:31 · Back to Reel" (the playhead the Reel was parked at; "From the Reel" if it never played); the chip is Back. Preparing stripe and ready notice were already drawn. | fixture, #451 | [E06 after](fidelity/pairs/E06-after.jpg) |
| E07 | Requests list | matches | Fixed in #443: one line per ask with a chip; Open, Retry, Cancel on the chip or row (before: boxed cards with pre-chip words). | fixture, #443 | [E07](fidelity/pairs/E07.jpg) |
| E07 | Requested in Keep | matches | Fixed in #443: Requested filter in Keep (before: only /account/requests). | fixture, #443 | [E07](fidelity/pairs/E07.jpg) |
| E07 | Couldn't prepare + Try again | matches | Fixed in #443 and #454: Try again retries the same request in the sheet, Retry and Ask differently in the list (`could_not_prepare` only; D-054). | fixture, #443, #454 | [E07](fidelity/pairs/E07.jpg) |
| E07 | Can't be made, cancelled, exhausted | matches | Fixed in #443: Can't be made chip (new); cancelled dashed chip; exhausted says You've seen what's ready for now. | fixture, #443 | [E07](fidelity/pairs/E07.jpg) |
| E07 | Placed where the request was made | matches | Fixed in #443: Ready — the Scroll you asked for on the opened encounter. | fixture, #443 | [E07](fidelity/pairs/E07.jpg) |
| E07 | List retry and retry of the same request | matches | `request.retry{requestId}` re-drives the same request (same ID, idempotent receipt, caps and the retry limit respected, "can't be retried" answered); Try again in the sheet and Retry in the list both send it (D-054, #454). | fixture, #454 | [E07](fidelity/pairs/E07.jpg) |
| E08 | Natural thread ending | matches | Yellow card, Keep a way back, Something different, Done for now, thread rows (fixture). | fixture | [E08](fidelity/pairs/E08.jpg) |
| E08 | Way back kept, Something new | differs | "Something different" now stops at the offers the discovery returned and lists them as cards (title and format) before anything opens; Back, Esc or Not now returns. Differs: card colour follows the format (Reel cobalt, Scroll sunken paper) because offers carry no subject or colour; the subject tag ("Football") is not in the data; "Ask for something" is not on the picker. | fixture, #451 | [E08](fidelity/pairs/E08.jpg) |
| E09 | Narration, captions, illustrated range | missing | No client work possible: a Reel document carries captions: burned_in only, no caption track, transcript or timing (D-054). The range of variants is the asset's own picture. | contract | [E09](fidelity/pairs/E09.jpg) |
| F01 | Friends list | differs | Fixed in #453: one list (Friends, Waiting, Blocked folded) with Add a friend as the one primary; rows are avatar, name and a line (Online or Recently active only when the friend shows it), with ⋯ for Visit, Remove and Block; requests are cards with Accept and Decline; sent requests carry a Pending tag; no tabs, no Refresh or paging buttons on a short list. Left: "can visit what you share" (it depends on a separate read of your own visibility), and the invite card on an empty list is a line of text. | dev, fixture, fixed in #453 | [F01](fidelity/pairs/F01.jpg) |
| F01 | Add a friend | differs | Fixed in #453: Their handle, the found person with Send invite, "or", the Share your invite link card, the turned-off link card with Make a new link, and the contacts promise. Left: "More apps…" (the link can be shown once and a second hand-off would lose it), and the drawn header with an X above the field (the screen keeps the Friends title and Back). | fixture, fixed in #453 | [F01](fidelity/pairs/F01.jpg) |
| F02 | Visibility | differs | Fixed in #453: the page is titled Who can visit your universe; the chosen visitor row is cobalt-tinted; systems are plain rows with a switch; Activity status is one pill. Left: Preview what <name> sees (needs contract: a server read that answers with the visitor view of the owner's own published copy; building it from the client would copy the server's audience rules). | dev, fixture, fixed in #453 | [F02](fidelity/pairs/F02.jpg) |
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
| P01 | Account | matches | Identity card with name, handle, email and Edit (the same profile as Friends & visibility); Notifications and Accessibility & playback rows. Your requests and Keyboard shortcuts rows stay as intended extras. | fixture, #449 | [P01 after](fidelity/pairs/P01-after.jpg) |
| P01 | Notifications, Accessibility & playback | differs | Both routes exist with only settings that have behaviour: Ready requests notice, motion (follow the device or always reduce), text size, Reels start with sound, kept on this device (D-057). Not drawn because nothing in the app uses them: Messages, Exploration activity, Room mentions, quiet hours, Captions, Haptics, list view, high-contrast labels. The text size control is three rows, not an A-A stepper. | fixture, #449 | [P01 after](fidelity/pairs/P01-after.jpg) |
| P02 | Privacy & history hub | matches | Recording is a switch with one-line copy; rows for history, clear, sharing, shared links and delete. Shared links is an extra row. | fixture, #449 | [P02 after](fidelity/pairs/P02-after.jpg) |
| P02 | History & export | matches | Receipts are tinted strips: striped Preparing, green Ready with Download, danger Failed with Retry (unit tests; the fixture server had no exports). | fixture, #449 | [P02 after](fidelity/pairs/P02-after.jpg) |
| P02 | Clear exploration | matches | Removed and Stays lists, then the acknowledgement and the button inside a dashed box. | fixture, #449 | [P02 after](fidelity/pairs/P02-after.jpg) |
| P02 | Delete account | matches | Removed and Stays lists; dashed danger box with the acknowledgement; receipt line as a tinted strip. | fixture, #449 | [P02 after](fidelity/pairs/P02-after.jpg) |
| P03 | Report | differs | Built in #446: Not interested with Undo, content-error and abuse forms with receipts, offline queue, from every drawn entry point. Departures (D-055): the acknowledgement says "we won't show this for a while", and Hide subject for a while and Copy link are not built. | #446 | - |
| R01 | Room preview | matches | Header, who is here to help, labelled AI inhabitants, pinned question, Join room (fixture and dev). | fixture and dev | [R01](fidelity/pairs/R01.jpg) |
| R01 | Member view and Talk list | matches | Threads, Share into room, activity section; invited chip in Talk (fixture). | fixture | [R01](fidelity/pairs/R01.jpg) |
| R02 | Discussion | differs | Fixed in #455: a message's ⋯ is drawn only while the pointer is over it or it has focus, and a long press on the message opens the same sheet (it stays in the page for keyboards and screen readers). Left: the AI card's Explore this, because What if is not built in rooms (a room discussion has no scenario branches yet), so there is nothing for it to open. | fixture, fixed in #455 | [R02](fidelity/pairs/R02.jpg) |
| R03 | Poll | matches | Fixed in #455: the dark header with a cream Back and "Room poll", reaching up under the status bar. The vote card keeps a border where the design draws it flat. | fixture, fixed in #455 | [R03](fidelity/pairs/R03.jpg) |
| R03 | Quiz | matches | Fixed in #455: the same dark header ("Room quiz"). | fixture, fixed in #455 | [R03](fidelity/pairs/R03.jpg) |
| S01 | Keep list | differs | Remove from Keep moved into the ⋯ menu on every card (a withdrawn card keeps a visible Remove; a failed removal shows Retry removal on the card). The art is still a drawn tile: saved items, offers and documents carry no thumbnail or poster field, so there is none to show. | fixture, #451 | [S01 after](fidelity/pairs/S01-after.jpg) |
| S01 | Keep detail and place | matches | Detail with Resume place and Open from the top (e2e keep-smoke). | e2e | [S01](fidelity/pairs/S01.jpg) |
| U01 | Universe overview | matches | Map with systems, stations, Lately lens and list view (fixture). | fixture | [U01](fidelity/pairs/U01.jpg) |
| U01 | First state | matches | Your universe starts quiet, Go to Explore (dev). | dev | [U01](fidelity/pairs/U01.jpg) |
| U02 | System | matches | System, planets, station card (fixture). | fixture | [U01](fidelity/pairs/U01.jpg) |
| U03 | Planet | matches | Planet scene, route chip, list view (fixture). | fixture | [U01](fidelity/pairs/U01.jpg) |
| U04 | Region card | matches | Region card with Open and Close (Try again when the preview fails). An encounter opened from it shows "From <region> · <planet>", which is Back; on return the pin shows "you were here" with a ring until it is chosen again (private, device-local, purged with the scope). "More in <region>" is not offered: there is no read for more encounters from a region. | fixture, #456 | [U04 after](fidelity/pairs/U04-after.jpg) |
| U05 | Formation sequence | matches | Dust, gathering, protostar, star, planet settles with Skip and Done (fixture). | fixture | [U05](fidelity/pairs/U05.jpg) |
| U06 | Friend visit | differs | Leave is on the visiting bar (first in tab order) beside "Visiting <name> · Only what <name> shares". Not drawn: the room station card (the visitor snapshot carries shared systems and planets only, no rooms) and the seeded personal looks (no data). Recorded, not built. | fixture, #456 | [U06](fidelity/pairs/U06.jpg) |
| U06 | Not shared with you | matches | This universe isn't shared with you with two exits. | dev | [U06](fidelity/pairs/U06.jpg) |
| U07 | Three worlds | not checked | Planet looks come from a seeded scene; a three-person comparison was not built. | - | - |
| U08 | Search | matches | Search field with grouped results and hint line (fixture). | fixture | [U08](fidelity/pairs/U08.jpg) |
| U08 | List view | differs | Outline by system with a Lately toggle on top. Not grouped by family: places carry no thematic family (the scene "family" is only the land style), and sky regions that merge quiet systems have no backend yet. Lately is a toggle button, not a switch. | fixture, #456 | [U08](fidelity/pairs/U08.jpg) |
| V01 | Tablet portrait | matches | Rail plus thread aside at 834x1112. | dev | [D01](fidelity/pairs/D01.jpg) |
| V01 | Compact 320 and 200% text | matches | At 320x640 the first-arrival hint keeps clear of the action rail (it stops short of it); the icon-only compact bar is as drawn. | fixture, #456 | [V01 after](fidelity/pairs/V01-320-after.jpg) |
| X01 | What if sheet | matches | Sheet, From chip, idea, We'll explore summary with Changed/Kept, Explore. | dev | [X01](fidelity/pairs/X01.jpg) |
| X01 | Branch preparing in the thread | matches | Dashed branch card with Preparing. | dev | [X01](fidelity/pairs/X01.jpg) |
| X02 | Branch cards | matches | Fixed in #455: Explore this is the card's one action; What if… and Remove are in ⋯ (Remove stays on a card that is preparing or could not be prepared, as drawn); a speculative what-if carries a Speculative tag (D-056); and the card says "Opened by you" only to the member who opened its Scroll (the server tells each member their own list, never another's). | dev, fixture, fixed in #455 | [X02](fidelity/pairs/X02.jpg) |
| X02 | Failed, dismissed, suggestion not made | not checked | Not reachable on dev without a failed branch; the branch-card tests cover them. | - | - |
| X03 | Branch view | differs | Header, return chip, 1 · current chip, hypothetical frame present; a Scroll branch is drawn as paper article, the design shows a Reel branch. | dev | [X03](fidelity/pairs/X03.jpg) |
| X04 | Branch map | not checked | The map sheet exists; it opens only after several branches, which dev does not have yet. | - | - |

**Count: 51 matches, 22 differs, 2 missing**, and 9 not checked (84 rows), after the sweep and fidelity round 2 (#448–#456) and P03 (#446).

## Fixed by the sweep

- #441 sign-in follow-up screens on paper (A01, A02).
- #443 request states (E07), Requested in Keep, Try again, nothing more ready, ready-opened note (D-054).
- #444 share landing poster card (H02), offline and unavailable encounter states (E01).
- #448 Talk: New button and invitation card with Preview and Ignore (C01, C03), thread header with Start a thread and the "While you were away" divider (C02, C04), a thread composer that names two people who share a first word apart.

## Not fixed, and why

- **Needs contract:** a correction field on an encounter (E01, E05), caption track or transcript on a Reel (E09, E01).
- **Larger than a sweep:** Friends roster as one list (F01), Account identity card, Notifications and Accessibility & playback (P01), recording as a switch (P02, D05), share sheet header (H01).
- **Not opened:** thread presence and members sheet (C03), snippet range handles (H03), failed and dismissed branches (X02), branch map (X04), three-person worlds (U07), series threads on dev (C04). They are drawn in code and covered by tests; no dev data reaches them yet.

## v3 dev check, round 1 (#548)

Where a fix and the v3 design disagree, or the design is silent. 390 × 844 and 1440 × 900, production export, labelled fixtures.

| Screen | What | Status | Why |
|---|---|---|---|
| Scroll reader, ••• on `/scroll/<id>` | Save and Share. Like and Ask are not there. | differs | No encounter on this address, so no like or ask to send. G5 also lists Challenge, Text, Simpler, Small print and Report; none is built yet. |
| Scroll reader, ••• in Explore | Like, Save, Share and the path; Ask is in the dock only | differs | G5 draws Save, Share and the rest, not Like or Ask. Kept as built; Share, Ask and the path now open from it. |
| Room, AI residents | One line naming the residents on a phone; a tap opens Ask and the note. Open on desktop. | differs | R3 has no standing panel (Ask is in a message's ••• and by @name). The panel stays because the person needs a way to ask without a message; a phone keeps 60 % of its height for messages (T-A). |
| Talk list | On the dark sky under the Talk theme, cream rows. A thread invitation stays a paper card. | matches | T3 draws the list on the sky. Paper theme keeps the paper list. D-154. |
| Universe, Back pill | A long name ends in an ellipsis; the whole name stays in the accessible name. | differs | The design draws short names only. |
| Universe, landed map | Opens on the formed regions, centred, shrinking the map by at most 40 % to fit their names. | differs | The design shows the whole map; with four regions on one side that left names at the edge. D-113. |
| Universe, desktop key hints | Bottom right of the map, above the clouds. | differs | The design draws them bottom left, where the chips sit when a place has a "Route to" chip. |
| Universe, list view with no planets | "No planets in <system> yet." under the system row. | differs | The design draws systems with planets only. |

## v3 T-F, the what-if answer card (#486)

T3 "Threads" frames 6 to 9 and the desktop panel, at 390 × 844 and 1440 × 900, production export, labelled two-person fixtures (`thread-whatif-smoke.spec.ts`). Not yet seen with the real model.

| Frame | What | Status | Why |
|---|---|---|---|
| 6 What if… | The sheet's note: "We make a short what-if, check it, then post it here as a branch. About 30 s. Keep chatting meanwhile." | matches | The sheet is the existing X01 sheet; only the line is new, for a what-if. |
| 7 Making it | A paper card labelled "What-if · made by KnowScroll", the title, "Making a short what-if · about 30 s · keep chatting", a bar, "We check it before it posts.", Cancel for the one who asked. | differs | No step list ("Read Part 2 / Set the assumption / Checking the numbers"): no step is tracked, so none is drawn (D-213). After 90 seconds the line says it is taking longer than usual. |
| 8 The branch, posted | "WHAT-IF READY · MADE IN 26 S · 12:46", ASSUMED, CHANGED (cobalt edge), KEPT, the answer, Open, Branch again. | differs | No Reply, Call it first or "2 replies in this branch" (D-213). The label is a pill inside the card, not floating over the card's top edge beside a planet. A figure row appears only when a source states a figure. |
| 9 Branches tab | Every what-if under the part it came from. | missing | A branch continues the thread's root or another branch, never a part, so there is nothing to group by (D-213). The branch map (X04) stays the list. |
| Desktop | The card sits in the conversation column beside the Series panel. | differs | The panel has no Branches section (frame 9). |

## v3 R-5: Today and the sky (#491)

R3 pages p-04 (end to end), p-07 (Today channel), p-09 (on the Universe map) and p-10 (E, game feel). 390 × 844 and 1440 × 900, production export, labelled fixtures (`rooms-sky-smoke.spec.ts`). Screenshots in the PR.

| Frame | What | Status | Why |
|---|---|---|---|
| R3 B, Today channel | The question card (yellow), a resident's label, Answer, then the day's conversation | matches | The resident is Nova (T3 residents), not Echo, who is not built. |
| R3 B, Today channel | "Tonight: the Launch" card and "Remind me" | missing | The Launch is R-6. Nothing stands in for it. |
| R3 B, Today channel | "Past days" | differs | A short list of earlier questions under the cards, not its own screen. |
| R3 B, Today channel | "Nothing for today yet" when no item is approved | differs | The design draws only a full day. Items wait for an operator's approval (D-070), so a room can have none, and it says so. |
| R3 E, Spot the flaw | One sentence below is wrong, tap it, then "Found it!" and the key | differs | One 44 px button per sentence instead of a paragraph with tappable parts, so every target is 44 px and has its own name. The result is one line in a live region ("Found it. Sentence 3 was altered."). |
| R3 E, Spot the flaw | "2 found it" and flair progress ("FIRST FINDER EARNS FLAW FINDER PROGRESS") | differs | The count shows after your tap only. Flair is not built (D-064: no totals), so there is no progress line. |
| R3 E, Spot the flaw | While recording is paused | differs | Not drawn. A tap is a play result the server keeps, so it is refused with a plain banner and nothing is stored (D-176). |
| R3 E, Debate and vote | Two sides, a close date, bars, "Your vote: …" | differs | Bars and counts show after you vote or at the close, never before (the poll rule). Close times are four choices (6 hours to a week). The best argument of each side is not pinned. |
| R3 E, Room sky | The constellation card with "5 of 7" and a star's moment | differs | A bottom sheet from the Now strip's sky chip, not a card in the room. One fixed seven-point arch for every room, not per-room art. A moment names the act and the day, never a person. |
| R3 E, Room sky | "Echo offers three names" and the room votes | differs | The three names come from code lists (no Echo, no model) and the vote is three buttons, open for a day. |
| R3 E, Flair and podium | Flair card, Launch podium | missing | Flair is later; the podium is the Launch (R-6). |
| R3 p-04 step 7 and p-09, the station | A card under the map with "Enter room" and "Remind me"; the constellation named on the map ("THE PRESS"); a Launch pulse | differs | The station shows its constellation and a steadier ring once finished, with "Name · n of 7" in the label (a name is kept while the next constellation forms). No card, no reminder and no Launch pulse (R-6). The sky is for members: an outsider's station is drawn as before. |
| R3 B, Now strip | Today and Launch chips on top of General | differs | Today and the sky chips; no Launch chip. The strip is the first thing in the conversation list, not pinned: it scrolls away with the messages so they keep over 60 % of a phone (68 % with the strip and 64.5 % in a quiet room, measured at 390 × 844 in `rooms-sky-smoke.spec.ts`; with the strip pinned they were 60.9 % and 57.3 %; D-140). Today and Room sky are also rows in the room menu. |

## Honest limits

- No VoiceOver or TalkBack run. Real devices were not used; the engine is desktop Chromium at the artboard's width.
- Dev content is MiniMax-written, so titles differ from the authored examples; only structure, copy and look were compared.
- Fixture rows were produced over the production export with route-mocked HTTP, not from a backend.
- Room faces (R-4) were built after this audit and are not rows above. R3's emblem set has fourteen glyphs; the app draws sixteen (D-172 adds a globe and a cell, drawn in the same flat style), since Earth and the human body had no fitting glyph.

## v3 Talk (T3): Call it together (v3 T-E, #485)

The card, the bar and the chip are built from T3 page 4 (frames 2, 4 and 5 and the desktop panel); `apps/client/e2e/thread-calls-smoke.spec.ts` draws them at 390 x 844 and 1440 x 900 over fixtures, not on dev yet. Differences left on purpose:

| T3 frame | Difference | Why |
|---|---|---|
| 5, the reveal | No common guess from other threads. T3 and R3 question 16 lean towards one past 30 calls; the card shows only the Scroll's own reviewed note ("The common guess. Source: …") to a member whose pick was that guess, and nothing otherwise. | A live count of picks can be differenced by one account or a small group to read a hidden pick, and a count threshold cannot stop that (D-157). Taken for the owner. |
| 5, the footer | "WATCHED BY ALL 4 · REVEALED 12:41" is "n of m have called · revealed together". | A pick and a place carry a day, never a clock time or "watched" (D-065, D-152, D-155). |
| 4, Lock it in | The library's ink button, grey while no option is chosen; T3 draws it dark green and always on. | The Components button set has no green variant. |
| 4, where it sits | The card sits above the "What if" bar and the composer and opens from a yellow bar or a part's chip; it does not open by itself. | The conversation keeps over 60 % of a phone (D-140). |
| 2, the chip | "★ Call it first · 2 of 4 in" on a part's row; the desktop panel's "Call it together for Part 3 · 0 of 4" reads the same way. | One chip for both widths. |
| 5, the party | "ALL 4 FINISHED PART 2 · 12:40" in the stream is not built. | The server keeps no history of places (D-153). |

## v3 R-6: the Launch (#492)

R3 pages p-04 (end to end, steps 4 and 7), p-10 (E, game feel: the Launch and the podium) and p-09 (the station on the map). 390 × 844 and 1440 × 900, production export, labelled fixtures (`rooms-launch-smoke.spec.ts`). Screenshots in the PR.

| Frame | What | Status | Why |
|---|---|---|---|
| R3 E 1, the Launch | The host card with a question, a timer ring, options, "Called it!", who called it, with General's conversation below as the crowd | matches | Pixel (T3 residents) hosts, not T-minus (R3); the card sits above General and the conversation keeps going below it. |
| R3 E 1, the options | A 2 × 2 grid of four options with keys 1 to 4 | differs | A Scroll's call has two or three options, so a vertical list of 52 px buttons with a letter; keys 1 to 3. Every option names itself ("Option B: 8 minutes, Right answer"). |
| R3 E 1, "Called it! +1" | A spark on a right answer, and "Ravi said 8 hours" | differs | No spark: a Launch keeps no spark ledger (D-064). The reveal says "n of m called it" with the faces of those who got it right, and never who was wrong (the host never shames, R3 C). |
| R3 E 1, the timer | A ring with "8 s" | matches | The ring steps with the seconds and the words are the reading, so reduced motion needs no change. The ring counts the server's milliseconds, not the device's date. |
| R3 E 2, the podium | Three steps, "+1 star for the room", the share card of squares, Share, Copy and Back to chat | matches | Share goes into General and posts the squares only. The line under the steps says "N others played too" with no names. A person with no right answer is not on it. |
| R3 E 2, the podium | "Lena and Ravi played too" | differs | A count only: nobody below third is named. |
| R3 E 2, the share card | "Copies as text: ■■■□■. No answers in it, so it can't spoil the replay." | differs | "so it can't spoil anything": there is no replay yet (R-7). |
| R3 p-04 step 7 and p-09, the station | A red pulse and "LAUNCH LIVE" on the room's station | matches | The light turns red and pulses while a Launch is on (steady under reduced motion), and the caption says "Launch live". Members see it on their own map; an outsider's station says nothing. |
| R3 p-04 step 4, the band | "LIVE · LAUNCH" in the room's band | matches | A small red tag beside the room's line; the faces of who is here are as before. |
| R3 B, Now strip | A Launch chip ("Launch 9:30 pm" or "Launch now · 3 playing") | differs | The chip says what can be done now (Start a quiz, Starting now, Live now, Podium) with no clock time and no number: a Launch has no schedule yet. |
| R3 E 1, the stage | General turns into a stage and the chat becomes the crowd | differs | The stage card sits above the conversation, so while a Launch runs the messages have 18 % of a 390 × 844 phone, against 68 % the rest of the time (D-224). |
| R3 F, "Replay" | Last night's Launch against the real answers | missing | R-7. |
