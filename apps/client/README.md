# @knowscroll/client

One Expo (SDK 58) application for Android, iOS and the web, with Expo Router. It loads the
bundled fonts from `packages/design-tokens/fonts/` (variable weight ranges via expo-font) and
draws everything from `@knowscroll/design-tokens` and `@knowscroll/ui`.

## Routes (coverage matrix, `docs/v2/discovery/design-screens.md`)

| Route                                          | File                                          | Shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Page title (web)                                      |
| ---------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `/`                                            | `app/index.tsx`                               | Redirects to `/explore`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                     |
| `/explore` | `app/(tabs)/explore.tsx` | Signed in: the current encounter as E01 (a full-bleed Reel) or E02 (a Scroll), with its one action set, format switch, ⋯ menu, share sheet, request sheet, continuation (edge tabs on a Reel, the end-of-article card on a Scroll), E08 ending and the plain states between (opening, waiting, offline, a path that changed, a saved place that needs a choice). Signed out: the first-arrival hint and the existing email sign-in route. | Explore |
| `/universe`                                    | `app/(tabs)/universe.tsx`                     | U01 to U08 and D02: empty, dust, the map of systems, a system, a planet with its regions, the region card, list view, search, Lately, formation; `?focus=last` flies to the ship's place                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Universe                                              |
| `/conversations`                               | `app/(tabs)/conversations.tsx`                | C01 Talk: the person's conversations, newest first, with the last message, unread dot and a muted mark; "No conversations yet" with Share something and Invite a friend when there are none; signed out shows the empty state                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Talk                                                  |
| `/conversations/<id>`                          | `app/conversations/[conversationId].tsx`      | C02 one conversation (`?m=<membership>&r=<revision>` from the inbox, the share sheet or the landing; without them it is found through the inbox): messages and Reel/Scroll cards by day, live over the Talk hint, a composer, mute, leave and block in the menu, "Deleted account" when the other account is gone                                                                                                                                                                                                                                                                                                                                                                               | the friend's name                                     |
| `/friends`                                     | `app/friends/index.tsx`                       | Real profile, exact handle lookup, bounded Friends/requests/blocked rosters, current pair actions and revocable invite links (#377); availability words only while their lease holds, and a Visit button (#241) | Friends                                               |
| `/friends/invite`                              | `app/friends/invite.tsx`                      | Fragment-only invitation entry; pure Check, then explicit Request; signed-out links are discarded before sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Friend invitation                                     |
| `/visit/[handle]` | `app/visit/[handle].tsx` | U06: a friend's shared systems and planets, drawn with the Universe renderer under a visitor bar; one answer for every refusal; nothing kept after leaving (#241) | Visiting a friend |
| `/saved` | `app/(tabs)/saved.tsx` | S01/S02 Keep: filters, one card per kept item (tile, format, title, where you left off), corrected and withdrawn items, a plain empty state, and a detail with Resume and Start from the top. Scoped, bounded paging; a visible Remove with a five-second Undo. | Keep |
| `/account/requests`                            | `app/(tabs)/account/requests.tsx`             | E07 Your requests: the person's own asks with their state (requested, preparing, ready, couldn't prepare, cancelled), Open when ready, Cancel while preparing, "may be out of date" when a refresh fails (#239)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Requests                                              |
| `/account`                                     | `app/(tabs)/account/`                         | P01, the account stack, reached from the avatar on every tab (D-006 c): signed in, the identity card (name, handle, address, Edit: the Friends profile), the person's sessions (coarse device names and last use; Sign out of one asks once; "Sign out of other devices"), the settings that exist and "Sign out" of this device; signed out, "Sign in" and the receipt of an account deletion asked for here; API unreachable, "Try again". Back names where it goes ("Back to Keep")                                                                                                                                                                                                                                                                   | Account                                               |
| `/account/notifications`, `/account/accessibility` | `app/(tabs)/account/*.tsx` | P01 Notifications (the "Ready" notice over an encounter, on or off) and Accessibility & playback (motion, text size, Reels start with sound). Device preferences (D-057): applied at once, kept on this device in `platform/device-preferences-store`, above the account scope, so sign-out and a privacy clear leave them | Notifications · Accessibility & playback |
| `/account/privacy`                             | `app/(tabs)/account/privacy/index.tsx`        | P02 hub (phones, tablets): recording, History & export, Clear exploration, privacy controls other slices add (`features/privacy/privacy-extensions.ts`), Delete account. D05 (desktops): the settings list and one card per control on this one page                                                                                                                                                                                                                                                                                                                                                                                                                                            | Privacy & history                                     |
| `/account/privacy/shared-links`                | `app/(tabs)/account/privacy/shared-links.tsx` | P02 "Shared links" (phones, tablets): every live link with its title, audience and expiry, and Stop sharing; on desktops it is a card of the Privacy page and the address redirects there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Shared links                                          |
| `/account/privacy/visibility` | `app/(tabs)/account/privacy/visibility.tsx` | P02 / F02 "Sharing & visibility" (phones, tablets): who may visit, which systems visitors see, and whether friends see the person as online; on desktops it is a card of the Privacy page and the address redirects there (#241) | Sharing & visibility |
| `/account/privacy/export`, `/clear`, `/delete` | `app/(tabs)/account/privacy/*.tsx`            | The control of that name on a page of its own (phones, tablets); on desktops they redirect to `/account/privacy`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | History & export · Clear exploration · Delete account |
| `/welcome`                                     | `app/(auth)/welcome.tsx`                      | A01 sign in: "Continue with email", "I have a sign-in link" (S1.3 #226)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Welcome                                               |
| `/signin`                                      | `app/(auth)/signin/index.tsx`                 | The email form (labelled field; invalid · sending · too many links · can't reach)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Sign in                                               |
| `/signin/link`                                 | `app/(auth)/signin/link.tsx`                  | A01 link sent: the address from this session (never the URL), "Resend the link", "Use a different email"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Check your inbox                                      |
| `/redeem`                                      | `app/(auth)/redeem.tsx`                       | Where a link lands (`/redeem#token=…`): the token is read from the fragment and removed from the address bar; one tap POSTs it (opening the link consumes nothing); without a link, a paste field                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Finish signing in · Use your sign-in link             |
| `/recover`                                     | `app/(auth)/recover.tsx`                      | A02: `?reason=link` "This link didn't work" (send a new link); otherwise "You were signed out"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | This link didn't work · You were signed out           |
| `/scroll/<assetId>`                            | `app/scroll/[assetId].tsx`                    | A Scroll opened by its address (D-006 d; `?anchor=<blockId>` restores a block): opens the exposure, reads the negotiated document, activates, renders and records what is read (client-core's recorder), and restores the position by block on return. Signed out: the sign-in prompt; every other state (loading, "isn't available", "needs an app update", offline, error) has a screen. The article uses the full `packages/ui` `ScrollArticle` renderer and AccountScope block-state store. The dev evidence panel (`features/diagnostics/evidence-panel.tsx`) appears only when the build sets `EXPO_PUBLIC_KS_DEV_EVIDENCE=1` (D-040); it is never consumer UI | The Scroll's title                                    |
| `/operator` | `app/operator/index.tsx` | The Operator screen (D-044), for an operator account of the world only: six panels over the allowlisted `ops` views (system overview with queue backlog, model outcomes and recent errors; journey search by ID; content production with refused answers and Reel orders; universe change; realtime delivery; privacy and retention). Not linked from any screen. Everyone else, a signed-out visitor included, sees the unknown-page screen, and the server answers them 404. Pieces Tier 0 has no source for show as unavailable | Operator |
| `/gallery`                                     | `app/gallery.tsx`                             | Developer component gallery and API health, only when built with `EXPO_PUBLIC_KS_GALLERY=1` (stable marker `testID="ks-component-gallery"`); otherwise "This page isn't here"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Component gallery                                     |
| `/gallery-scroll`                              | `app/gallery-scroll.tsx`                      | Developer Scroll gallery (fixture documents through `prepareScrollDocument` and `ScrollArticle`: `doc` = `bridges` (poster), `lighthouse` (editorial), `experiments` (every interactive and visual block), `fallback`; query `block`, `motion=reduce`, `scale=2`, `text=1` for the text version of diagrams), only when built with `EXPO_PUBLIC_KS_GALLERY=1` (marker `testID="ks-scroll-gallery"`); otherwise "This page isn't here"                                                                                                                                                                                                                                                           | Scroll gallery                                        |
| `/s/<token>`                                   | none (served by the API)                      | H02 share landing. On the web the edge sends `/s/*` to the API, which renders an honest, script-free page (D-008, D-042). The client has no `/s/[token]` screen and no route, group or catch-all may claim `/s` (`features/shell/route-map.test.ts`). A native deep link is not built                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                     |
| anything else                                  | `app/+not-found.tsx`                          | Not found, with "Go to Explore"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Page not found                                        |

Every page title reads "<title> · KnowScroll" (`platform/document-title.web.ts`, set when the
screen gains focus; native screens have none).

Explore by size (D01, V01): below 768 px the encounter fills the screen. From 768 px "This thread" sits beside it
(`features/explore/thread-aside.tsx`, 212 px on tablets, 368 px on desktops): the part before, the open part, the next
part, another angle and the other format, from the exposure context only. From 1024 px a Reel is a card
(`features/explore/reel-frame.tsx`) with Previous subject, the Reel/Scroll switch and ⋯ above, the actions beside and
Next subject with the key hints below; the card and the phone column are one element tree, so a resize never remounts
the player. ↑ ↓ (subject), ← → (thread) and Space (play or pause) act while the Reel stage has focus. Not built: the
whole list of a thread's parts, the thread's name and a "Talk" card (none is in the exposure context).

Navigation by size (V01): floating tab bar on phones (icon-only ≤ 360 px), a 76 px rail on
tablets (600–1023 px), an 88 px rail with the K mark and the account avatar on desktops
(≥ 1024 px). The account route belongs to no tab; each tab keeps its own state and Back follows
the person's own history (`backBehavior="history"`).

Every navigation control is a link with its address (`/saved`, `/account`, `/explore`): on the
web a real `<a href>`, so Enter, middle-click and open-in-new-tab work. The bar always comes after
the screen in the document, so reading and Tab order is top bar → content → navigation (V01):
the phone pill floats over the bottom, and on tablets and desktops the rail is drawn over a left
margin the screens leave free (`sceneStyle`), with the desktop avatar last in the rail.

The encounter controller advertises `scroll-document.v1`, `scroll-document.v2` and `reel-document.v1` when
opening discovery or a Saved revisit. Its Scroll block/version declaration still comes from the
actual renderer registry. A Scroll-only capability declaration would correctly make the backend
exclude Reels, even though this controller has a working Reel player.

## Layout of the code

- `app/`: routes only (Expo Router). Tests never live here (every file would become a route).
- `features/`: screens and their tests (`*.test.tsx`, jest-expo + React Native Testing Library;
  `features/shell/navigation.test.tsx` renders the real route tree with `expo-router/testing-library`;
  `features/shell/route-map.test.ts` checks the route files against the route map).
- `platform/`: platform files (`document-title(.web).ts`, `scope-storage(.web).ts`, `session-tokens(.web).ts`) and their web tests
  (`*.web.test.tsx`, the `web` Jest project, jest-expo/web in jsdom).
- `features/shell/`: also `talk-frame.tsx` (the one `main` and, on tablets and desktops, the navigation rail with
  Talk current, around a conversation or a thread, which are not tabs) and `keyboard-map.tsx` (every key the app
  listens to, as a sheet from Account and from the desktop Explore footer; add a row there with any new key).
- Talk by size (D03, T3, D-140 to D-144): below 1024 px a conversation or a thread is one column. A thread there is a 72 px header
  strip (Back, "A THREAD · n PARTS", the title, Series, options), the docked player (a 56 px bar) and the conversation,
  which keeps over 60 % of a 390 x 844 screen. "Series" pulls the parts and the people down from the header as a sheet
  that Back, Esc and Close close first. From 1024 px a thread has the conversation with a 400 px series panel on its
  right (parts, the player, the people); a direct conversation has the inbox beside it, with its row current; the Talk
  tab itself shows the list beside a pane that says "Pick a conversation". The rail is drawn from 768 px, also on a
  thread or a conversation. Presence ("Online") is not drawn: no availability is read here.
- Accessibility: `@axe-core/playwright` runs in the web smoke (`a11y-smoke.spec.ts`) over the main routes at 390, 834 and
  1440 px; serious and critical violations fail it, and every route has one `main`. `keyboard-smoke.spec.ts` tabs
  through screens and requires every stop to draw focus, and walks Explore, a sheet, the Universe, Talk and Privacy
  by keys; `reflow-smoke.spec.ts` checks a 320 px phone, a landscape phone, doubled text and reduced motion. React Native
  Web does not write `accessibilityState` to the DOM and reserves Space for button roles: set `aria-*` and use
  `spaceActivates` on a checkbox, radio or switch.
- `e2e/`: the Playwright web smoke over the static exports (`web-smoke.spec.ts` against `dist/`:
  links, Tab + Enter, modified clicks, page titles, focus order at 834 and 1440, no gallery;
  `gallery-smoke.spec.ts` against `dist-gallery/`: the gallery marker, the sheet's Esc, focus
  return and browser Back, the format switch's arrow keys, pressed-toggle colour) and
  `serve-export.mjs`, a static server with the edge's single-page fallback.
- `features/scroll/`: the Scroll route's screen (`scroll-screen.tsx`), the open → document → activate session
  (`scroll-session.ts`, a pure controller with a hook), the resume anchor (`anchor-keeper.ts`: block ID by
  article revision, in the account scope's storage), the capabilities this build declares
  (`capabilities.ts`, exported directly by the renderer registry). The route uses `packages/ui` `ScrollArticle` with AccountScope block state and a recorder observer; the resume keeper freezes before unmount closes visibility intervals. `features/diagnostics/evidence-panel.tsx` is the dev-only
  evidence view, off unless `EXPO_PUBLIC_KS_DEV_EVIDENCE=1`, and then only where `GET /health` names a world with operator tools.
- `features/scroll/stage-reader-surface.tsx` and `features/encounter/encounter-stage.tsx`: the Stage + Spine reader of a v2 Scroll (D-133 to D-135; status: **implemented**, web smoke-tested; native by unit tests only, not run on a device). `scroll-session.ts` opens a v2 document as `ready_stage` only for a caller that passes `stage: true` and declares `STAGE_CAPABILITIES`; `isStageScroll` picks the reader (Explore, `/scroll/<id>`), and a v1 document keeps the article. The reader's Part moves are the encounter session's series intents, Next ↑ is the vertical move, and ••• holds Save and Share. A position is a stop id. `e2e/stage-reader-smoke.spec.ts` runs it over the labelled `seasons-stage-ci` fixture: the picture follows the stops, a dot jumps, Part 2 and Next by button, key and swipe, reduced motion, axe at 390 and 1440, and the reading facts a full read and a tap through the dots report.
- `features/operator/`: the Operator screen. It has its own flat grey look on purpose (`operator-theme.ts`), takes its state from client-core's `createOperatorSession`, and shows the unknown-page screen when the server says the account is not an operator.
- `features/shell/`: the tab bar / rail adapter and the screen frame (safe areas, header with
  the account avatar, room for the floating tab bar).
- `platform/api.ts`: the API origin for this build and the typed client (`@knowscroll/client-core`).
- `providers/account-scope.tsx`: the AccountScope provider (#226). It reads the session once
  (nothing renders before), gives the tree the QueryClient of the signed-in scope (one per account
  and privacy epoch) or of the signed-out period, and is keyed by the scope, so sign-out, an account
  switch or a new epoch ends the old scope (socket closed, requests cancelled and fenced, cache
  cleared, storage purged) and remounts the screens. `useAccountScope()` gives screens the state
  and the manager. Its test (`providers/account-scope.test.tsx`) proves that an answer the old
  account asked for, arriving after a switch, never reaches the new scope.
- `platform/session-tokens(.web).ts` (native: the bearer token in `expo-secure-store`; web: none,
  the HttpOnly cookie), `platform/scope-storage(.web).ts` (web: `localStorage`; native: memory),
  `platform/command-id(.web).ts` (UUIDs for command IDs), `platform/sign-in-link(.web).ts` (the
  token of the link that opened the page or app).
  Production native builds refuse plain HTTP; development builds (`__DEV__`) may use it to
  localhost, 127.0.0.1 and the emulator's 10.0.2.2. The root layout imports only
  `@knowscroll/client-core/query-client`, so the first chunk carries no API client, contracts,
  Zod or OpenAPI link (the `_layout` chunk went from 754 KB / 147 KB gzip to 169 KB / 40 KB).
- `theme/fonts.ts`: the expo-font family definitions.
- `plugins/font-scale-config-changes.js`: an Expo config plugin that lets the Android activity
  handle text-size and display-size changes instead of being recreated (recreation left a blank
  screen with two navigation containers on the emulator); the new text size applies when the app
  resumes.

## Commands

| Command                                              | Does                                                                                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @knowscroll/contracts build`          | Needed once before bundling: the web and native bundles read `@knowscroll/contracts` from its `dist/` (D-012); tests and type-checking read its sources                                          |
| `pnpm --filter @knowscroll/client build`             | `expo export --platform web` into `dist/` (`web.output: "single"`: a static SPA served by Caddy at the site root, D-008)                                                                         |
| `pnpm --filter @knowscroll/client build:gallery`     | The same export with the gallery (`EXPO_PUBLIC_KS_GALLERY=1`, and `EXPO_PUBLIC_KS_DEV_EVIDENCE=1` so CI can prove the evidence panel is absent from `dist/`) into `dist-gallery/`, for comparing with `Components.html`; never shipped                                                          |
| `pnpm --filter @knowscroll/client test` / `test:web` | The Jest projects / the Playwright smoke over `dist/` and `dist-gallery/`. Both run in GitHub Actions only (D-010); the `client` job installs Chromium there                                     |
| `npx expo start` / `npx expo run:android`            | Development server / development build. Native builds read `EXPO_PUBLIC_KS_API_ORIGIN` (the world origin; HTTPS, or plain HTTP to `localhost`/`127.0.0.1`/`10.0.2.2` in development builds only) |

The native identifiers are `com.knowscroll.client` (distinct from the v1 `com.knowscroll.mobile`
preview). `android/` and `ios/` are generated by `expo prebuild` and never committed. Native
builds are not part of CI (CF-31). Automated suites run in GitHub Actions only (D-010).

Native module host declarations: `expo-clipboard` is declared directly by this app for Friends' deliberate one-time invite copy and so Expo autolinking includes the module used by `packages/ui`'s code-copy control. TypeScript, the UI import, frozen lockfile and Android build remain checked.

`/reel/<assetId>` opens/activates an admitted immutable Reel and draws it as E01: the same full-bleed stage, progress row and rail as Explore, with Save as its only action (the others have no command on this route). Save uses the real command; an absent Scroll sibling is unavailable. Fixture imports carry a "Fixture video" tag. Renewing a media grant reuses the existing exposure and never counts as a new encounter. Browser cookies authenticate video GETs; native source headers come from AccountScope.

The interim direct Scroll session accepts only direct-open exposure lineage. A Composer
ready/pending/exhausted response produces the existing controlled error state; the new Explore
consumer will own those outcomes (#234). This compatibility guard adds no navigation UI.

## Encounter navigation

Related: #234.

`features/encounter/encounter-session.ts` owns typed discover/revisit, semantic navigation,
offer activation and current authorized exposure context. Each intent keeps its command IDs
through unknown-outcome retries. Stale intent refreshes current context and requires a fresh
choice; ready offers activate only while Explore is foreground. The session belongs to the
AccountScope, survives tab/component detours and ends when the scope ends.

Presentation is split by what the person sees: `encounter-reel.tsx` (E01: stage, chrome, edge tabs),
`encounter-scroll.tsx` and `scroll-end.tsx` (E02 and the end-of-article card), `encounter-top-bar.tsx`
(Back, format switch, ⋯), `encounter-actions.tsx` (the one action set), `encounter-sheets.tsx` (⋯,
share and request sheets), `encounter-notices.tsx` (request status and Save/Keep outcomes),
`encounter-ending.tsx` (E08) and `encounter-states.tsx` (opening, waiting, offline and the rest).
They read the session; none of them owns navigation.

Two small additions read what the session already knows. `encounter-origin.ts` and
`encounter-origin-chip.tsx` draw the chip under a Scroll's top bar when it was opened by the format
switch ("From the Reel at 0:31 · Back to Reel", E06): the offer's relation is `format_variant`, the
entry before it is the other format of the same explanation, and the playhead is the one the Reel
was parked at. The chip is Back. "Something different" on an ending calls `session.chooseDirection()`:
when the discovery returns more than one offer the session stops with `state.choices` and
`direction-picker.tsx` ("Somewhere new", E08) lists their titles and formats; nothing is activated, so
nothing is recorded, until `pickDirection(offerId)`; Back, Esc or "Not now" returns to the ending.
With one offer it opens at once.

`encounter-history.ts` retains at most 20 entries in memory, including the same recorder and
monotonic timebase. Park synchronously captures the actual article block/offset or SDK playhead,
then pauses and suspends. Local Back restores a retained entry, paused, with no open/navigation/
activation command. The latest server intent is independent of a parked entry. Eviction and
scope end terminate retained handles. Only exact asset/revision private resume records go to
scoped storage; grants, URLs, tokens and the navigation tree never do. A returning surface
remounts for fresh visibility/layout/playback; parent layout setup re-arms its retained recorder
before child passive activity setup, including StrictMode.

`activated-scroll-view.tsx` and `activated-reel-view.tsx` are shared by the direct routes and
Explore. Supplied activated exposures never direct-open or activate again. Live media grants
are retained only in memory, fenced and cleared with their entry; expiry renews authorization
for the same exposure. Local restoration itself contributes no new H/R bonus. The player's Mute/Unmute choice and full local playback
snapshot remain on that exact retained entry/exposure/revision across parking and Back. Explicit
sound intent is retained even during pending source replacement when position capture is unavailable.
Only the playhead is serialized for a future visit; a new encounter starts paused with default sound,
and disposal clears retained audio intent. Sound controls never create playback or consumption.

Only admitted ready variants/continuations become navigation controls. A Part is a declared
series position (the yellow tab); Related uses a dashed treatment. The local trail says Visited.
Real pending work stays distinct from exhaustion; neither fabricates a future Part or changes
format by itself. Share is Copy link and the system sheet only; snippets, conversations and
friends in the share sheet wait for the social slice. D-040 records what the artboards leave open.

Reel navigation wraps only the actual video stage; on the web a swipe captures the pointer only
once it is recognised, so a plain tap still reaches the play/pause surface. The chrome (switch,
⋯, rail, edge tabs, progress) is a sibling of that responder; article/slider/chart/code pointers
stay with the child. Axis ownership locks until release; native starts inside the 24 px
system-Back edge stay with the platform. Vertical Scroll gestures never navigate, including end
momentum, and a Scroll has no sideways swipe (blocks own horizontal drags). Every move has a named
button; normal keyboard activation works without claiming article reading keys.
A Reel down-swipe or ArrowUp requests a previous subject; it is distinct from local Back.
Android Back, browser Back and the toolbar use the same local path, overlay first. Browser state
holds one transient same-address sentinel rather than an encounter navigation tree.

Saved uses the explicit `saved-page.v1` GET `/v1/saved` contract with a server filter and limit
of twenty. Only the current page payload is retained. Opaque Previous history is bounded to twenty
cursors; Next can continue arbitrarily far, including an empty page with `more`. Only `end` ends a
traversal; there is no library count. The oldest retained back boundary and expired/unavailable
cursors offer Refresh, which clears selection/history and starts a new live traversal. Each admitted
page must echo the actual scope, filter, numeric limit and exact request cursor, and cannot regress
the traversal's personal revision watermark. Withdrawn metadata is not supplied or invented;
corrected items keep their saved revision and offer a separate updated-version choice. Remove
checks the displayed Saved UUID before minting its exact removal command, rechecks it after the
five-second Undo grace, and retains the same body after an unknown outcome. No optimistic list
removal occurs. Revisit opens the chosen immutable revision, activates, and restores only the
selected authoritative membership's matching private place after another check.

CI fixtures cover typed command retry/fencing, retained history, recorder identity/timebase,
park/capture ordering, action rollback, Saved correction/withdrawal and platform Back/gesture
arbitration. The production-export browser fixture lane exercises actual Explore → navigation →
browser Back and withdrawn Saved removal. These are CI fixture evidence; real dev J1/J5 and
native encounter gestures still require the coordinator's connected runtime acceptance.

The two encounter `.web.tsx` platform adapters are explicit app entries in `knip.json`: Expo
selects them by platform suffix. They remain fully scanned; production-export browser fixtures
exercise the actual stage and path dialog.

## Private Ask and format requests

Related: #239.

Ask opens a local E04 overlay over the exact parked encounter. The same host owns the path menu
and request composer. The composer uses a bounded bottom sheet with a grab, rounded top corners
and a visible backdrop; wider screens center the same sheet. A desktop Ask-anchor position is
not implemented. Exclusive format/context choices expose radio groups. Close, Esc and Back dismiss it first and preserve paused position and sound.
Missing siblings remain unavailable in the format switch; the menu offers explicit Request Reel
or Request Scroll actions. Existing ready siblings keep the normal navigation path.

`features/requests/request-session.ts` owns one memory-only draft/request per AccountScope. It sends
real `supply.create/read/cancel/retry` HTTP commands with the existing encounter capabilities. Private text
is bounded to 500 characters and is sent as a free-text ask: the server matches it to an exact
catalogue topic or closes it as unsupported. Three explicit catalogue suggestions send their selected
canonical intent, without interpreting private prose or claiming inventory. About-this/variant submissions freeze the exact exposure, immutable
asset revision and latest authorised matching session revision; changed sources require a new choice.

A deliberate send/cancel gets a fresh command ID. Unknown transport outcomes freeze the entire
command for exact retry; read refreshes never submit work. Immutable acceptance is separate from
current availability, fenced by scope/epoch/request revision. Polling runs at most twelve five-second
reads while the request panel is foreground, stops on terminal/close/scope end, and can be refreshed
explicitly. Reopening reads current status. Ready never interrupts playback: Open rechecks status,
then uses the existing exact-revision return/open/activation flow. Cancel affects only the caller's
waiter according to server authority; closing is not cancellation. Try again after "Couldn't prepare" is
`supply.retry{requestId}`: the same request goes back to preparing (a refusal to retry leaves it closed and says
so), and an unconfirmed retry is sent again with its exact command. Scope end clears all draft,
frozen command, source, receipt, status and timers. CI fixtures cover these boundaries; actual connected web
and native request journeys remain coordinator-owned acceptance work.

`features/requests/requests-list-session.ts` is the memory-only session behind "Your requests"
(`/account/requests`, E07). It reads `supply.list`, keeps the highest request revision it has seen of each
ask, looks again every ten seconds while the list is visible and something is preparing, and keeps the last
list marked out of date when a refresh fails. Cancel is the same command as in the request sheet, and an
unconfirmed cancel is retried with its exact command ID. A closed "Couldn't prepare" row has Retry
(`supply.retry`, the same request, same exact-command rule) and Ask differently. `RequestsList` and `useRequestsList` can be
mounted anywhere; Keep's Requested view is meant to mount them. Closed-request copy lives in
`request-copy.ts`: it says the request is closed and never names models, budgets or machinery.

## Universe

Related: #238.

Each capability is marked **planned**, **implemented** (in source, covered by CI) or **runtime-verified**
(driven in a browser against a local PostgreSQL, API and worker with worlds formed through the real
Geography and Scenes path and the CI fixture model; not on dev).

| Capability                                                                                   | Status                           |
| -------------------------------------------------------------------------------------------- | -------------------------------- |
| Overview and Far levels and a system, drawn in 3D (v3 U-2, D-106, D-107)                     | runtime-verified (web); Android: lane |
| Planet globe (U03), landed map (U04), region card and Open/return, from the world generator (v3 U-4, D-108 to D-110) | runtime-verified (web); native: not driven |
| Land not reached yet: grey outlines on the map only, never named, counted or chosen (D-109)  | runtime-verified (web, accessibility snapshot) |
| Dust cues and their note                                                                     | runtime-verified                 |
| Lately lens, search, list view, simple drawing                                               | runtime-verified                 |
| Camera, lens and ship memory; after-absence framing; `?focus=last`                           | runtime-verified (web)           |
| Formation story (U05), all five beats                                                        | runtime-verified                 |
| Routes between planets: a "Route to ..." chip on a planet, never a line (D-074)               | implemented                      |
| Desktop outline panel (D02)                                                                  | runtime-verified                 |
| Native persistence of the camera (memory only today)                                         | planned                          |
| Room stations in 3D beside their systems, a "Rooms" section in the list view (D-051)         | runtime-verified (web: target and list; the 3D drawing is the gallery sample) |
| The ship parked at the planet of the last place (unit-tested), "Return to <planet>" (D-080)   | implemented (the chip is runtime-verified, web) |
| Sky regions that merge quiet systems (U08)                                                   | planned (no backend or data yet) |

`/universe` follows artboards U01 to U08 and D02. The map fills the screen; the header and chips
float over it.

- **Overview, Far and a system (U01, U08, U02) are 3D** (`space/space-stage.tsx`, D-106, D-107). One scene holds every
  system: an orange sun, haze in the system's family, planets that revolve and no line of any kind. The camera is the
  level: the whole universe nearer (Overview) or farther (Far, past 68 units: a first tap picks a system and shows its
  card, Open enters), or close over one system. A tap flies in (2.4 s; reduced motion jumps); stepping up takes 0.3 s.
  Type, rings, moon, hue and haze are the server's look (`looks` on the manifest read, asked for with
  `scene-look.v1` and `worldmap.v1`); the client never makes its own. A place with no look (a friend's visit, a world
  not backfilled yet) is drawn plainly: a colour set from its palette, teal haze, no rings or moon.
  Positions come from the persisted anchors and the seed; size never from reading.
- **Labels and targets stay views.** `space-overlay.tsx` places a 48 px button and a label (`placeLabels`) at each
  projected point (a target shrinks, never below 24 px, only where bodies crowd each other: D-107); the canvas is hidden from assistive technology. Where 3D cannot run (no WebGL, a lost context, a
  failed frame, low memory) `SpaceSimpleLists` shows the same names in the same order and every place still opens.
- **Planet globe (U03) and landed map (U04)** (`planet/`, D-108 to D-110). A planet opens as a globe: every continent in
  full colour under clouds, turning once in 70 s, with the ring and the moon its look gives it, and the names of the
  regions that have formed written on it. A drag turns it (the camera's pan, in reduced motion the only thing that does);
  "Drag to rotate · tap to land" and one "Land on <planet>" button take the person to the map at planet level. The map is
  the same planet flat, with irregular region borders: formed regions in colour with their names in screen space (never
  scaled with the camera), land not reached yet in flat grey under cloud (D-109). Choosing a region drops the camera
  about twice as close, dims the rest and opens a dark-glass card with one encounter. Everything is drawn from
  `scene-core`'s `worldmap.v1` generator (`buildGlobe`, `buildMap`, `chartWorld`) by `use-planet-world.ts`, built after
  the first frame and kept by the session. The look (type, hue, rings, moon, sites) is the server's; a planet without
  one is drawn plainly, regions on sites in the order they were made. A press within 350 ms of the camera moving is
  ignored, so a drag that ends over a region or the globe does not choose or land. Back from an encounter lands on
  the planet's map at planet level, with the region marked "<region> · you were here" and an orange dot
  (`universe-here-marker.ts`: a private marker kept in the account scope's storage, purged with the scope, dropped after
  14 days, cleared when the person chooses that region again). The card offers Open and Close only: there is no read
  yet for more encounters from a region. Open goes through the real encounter engine; the encounter carries a
  "From <region> · <planet>" chip that is Back (`encounterOrigin`).
- **Accessibility of the planet views.** The drawing is hidden from assistive technology. The globe has one control, and a
  formed region on the map is one 48 px target named "Name, a region", in site order; the plain list (Simple drawing) names
  the same regions in the same order. Grey land has no target, no text and no press handler. A friend's planet turns
  but does not land.
- **Routes.** Only the Cartographer's routes (between planets of one system) exist, and they are a "Route to B"
  chip on a planet (D-074). No line is drawn on any screen.
- **Dust (U01 "Emerging").** `POST /v1/universe/emerging/read` gives opaque cues. They are drawn as toon nebulae
  (one large at the centre when nothing else exists, small ones past the systems), never labelled, never a
  destination; a tap explains them in one sentence. U01 "Empty", loading and Offline draw the quiet sky only
  (`space/sky-backdrop.tsx`; the old still stars are its fallback).
- **Lately, search, list.** Lately dims quiet places and sorts recent ones first (activity, never
  existence). Search runs on the device over the person's own places and the query is not kept.
  The list view is the full outline (the screen-reader primary); from 1024 px it is a permanent
  panel (D02).
- **Return.** The camera, lens and ship's place persist per device in the account scope's storage
  (purged on logout, account switch and privacy reset). The ship is parked on the planet of the last place
  (hidden under Lately). After three days away the camera starts framed on everything and a "Return to <planet>" chip
  flies back. `/universe?focus=last`
  flies there.
- **Formation (U05).** Plays once per committed transition (the server decides): dust, gathering,
  protostar, star and orbit (new systems only), planet. Reduced motion shows the last frame.
- **Never evidence.** Looking, panning, searching and choosing a pin create no observation, exposure
  or command. Only the Reel or Scroll that Open starts is an encounter.

Accessibility: every place is a 48 px button named "Name, a planet"; keyboard on the web pans with
arrows (on a globe they turn it), zooms with + and - (or the wheel), Home refits, "/" searches; focus rings use the dark-surface
token; reduced motion stops drift and plays the formation as one still.

### Space renderer (v3 U-0 gate, U-2 in use; D-073, D-100, D-106, D-107)

`features/universe/space/` draws the space views with three.js. The Universe tab uses it for the Overview, Far, a
system and the Empty, loading and Offline sky; a planet's globe and map are SVG (D-108). It is also reached through the
developer gallery page `/gallery-space` (builds made with `EXPO_PUBLIC_KS_GALLERY=1`; `?scene=universe` draws the
tab's own layout of a labelled sample universe, for the frame numbers).

| Capability | Status |
| --- | --- |
| One three.js scene (orange sun with haze, painted planets that revolve, no lines, nebula dust, stars) | runtime-verified (web, browser) |
| Systems, stations, dust and quiet (Lately) places from the real Universe data, as buttons over the canvas | runtime-verified (web, browser; `e2e/universe-space-smoke.spec.ts`) |
| The parked ship, and the grey drawing of quiet places under Lately | implemented (unit-tested; the gallery's sample universe draws the ship) |
| Camera rig: Overview, Far and System as distances of one camera; pan, zoom, fly in (2.4 s) and out (0.3 s) | runtime-verified (web); unit-tested maths (`camera-rig.ts`) |
| Web canvas host: a DOM canvas, WebGL 2 context made by three.js | runtime-verified (web, browser) |
| Native canvas host: `expo-gl` `GLView`, `gl.endFrameEXP()` each frame | runtime-verified (Android emulator lane; no phone or iOS yet) |
| 30 fps cap (a frame at most every 33 ms), time step clamped to 0.1 s, pixel ratio capped at 1.5 | runtime-verified (web: 33.3 ms mean on the real tab; Android emulator) |
| Loop stops when the route is unfocused, the app is not active or the tab is hidden | runtime-verified (web); native: implemented (unit tests, not driven on a device) |
| Loop stops when the canvas is scrolled off screen | runtime-verified (web only; native does not report it, see D-100) |
| Reduced motion: one frame, no loop, a fly is a jump | runtime-verified (web, Android emulator) |
| No WebGL, context creation failure, context loss or a failed frame: the plain lists (`SpaceSimpleLists`) | runtime-verified (web; on the emulator a failed context creation showed the lists) |
| A new native surface after resume replaces the renderer and loop; unmount releases them | implemented (unit tests, not driven on a device) |
| Low memory (`AppState` `memoryWarning`) shows the plain lists | implemented (unit test; raised by iOS, not known on Android; device-memory check deferred to the Simple drawing slice) |
| Labels and tap targets are RN views at projected points; no raycasting | runtime-verified (web, Android emulator) |
| Landmark markers, constellations, the entering animations, a friend's own look | planned (later slices) |

How it fits together. A platform canvas host (`space-canvas.web.tsx`, `space-canvas.tsx`) hands `SpaceView` a
`SpaceSurface`. `SpaceView` loads `space-renderer.ts` (three.js) on first use, builds the scene from a
`SpaceDefinition` and runs one loop (`render-loop.ts` over the pure clock in `frame-clock.ts`). A scene is a pure
function of the time `t`, so one frame is a valid picture. `space-model.ts` lays the projected places out as a
definition and `camera-rig.ts` aims the camera; both are pure. When the definition changes (Lately, a new place,
the ship) the scene is rebuilt in place and the camera, glow and any fly in flight are kept. Textures are plain pixel
arrays (`texture-data.ts`), because Hermes has no canvas. Tests stand in for the GPU with `fake-space-gpu.ts`. The web
smokes are `e2e/space-gallery.spec.ts` and `e2e/universe-space-smoke.spec.ts`; the emulator flows are
`maestro/space.yaml` and `maestro/universe.yaml`.

Files (`features/universe/`): `universe-session.ts` (state, history, memory, dust), `universe-layout.ts`
(pure placement of regions and labels), `space/` (the 3D views, above), `planet-scene.tsx` (the SVG planet),
`universe-bodies.tsx` (the SVG kit), `universe-surface.tsx` (phone and desktop layout),
`universe-header.tsx`, `universe-cards.tsx`, `universe-outline.tsx`, `universe-search-panel.tsx`,
`formation-presentation.tsx`. Choices are in D-039.

## Mounted Keep lifecycle

Related: #234, #246, #344.

The selected inline detail reads the real scope-object KeepPlaceSession. Resume checks current
membership/ref/place before canonical return admission and again before mounting. Changed or
unavailable state blocks restoration with explicit top/return choices. Updated revisions inherit
no membership or position. Detail and restoration alone create no consumption observations.

An actual saved Explore surface warms its exact membership on mount. Save captures its actual
local position synchronously; after acknowledgement and a fresh membership read, a still-current
surface supplies its actual position to the strict server CAS. Every history park, overlay, tab
background, Back and trail restore captures actual measured Reel playhead or canonical Scroll
block/fractional offset before pause. Incoming resume values alone are never uploaded. Interactive
block state remains in the existing account/epoch/revision/block store, never in the place request.
Reel restoration remains paused. Scope end purges and fences late replies.

A parked write may finish after its surface leaves. At most twenty retiring Explore writes, twenty retiring direct-surface writes, twenty visible
card reads and current/detail work share a sixty-four-lease app budget; the core separately caps one hundred entries
and four reads. Unknown writes retain the identical command/body; CAS conflicts need explicit
resolution. Returning to that target adopts its retained pending state, without resending it.
An immutable ACK requires a new read. There is no new persistence, socket, polling or observation.
If the first exact membership read hasn't completed before departure, no old capture is guessed
onto a newly discovered membership. A Save whose surface leaves before its acknowledgement keeps
its actual local resume capture; automatic server capture requires a live actual surface. These
races remain unconfirmed rather than claiming that a place was saved.

All client Unsave paths now use the exact membership Remove endpoint. One removal per scope is
prepared by a real Keep read, offers a five-second grace period, then rechecks the same UUID/ref
before dispatch. Undo only cancels that unsent grace period. It closes synchronously before the
request and never restores a removed membership. An unknown response exposes explicit same-body
Retry, blocks replacement commands and offers no Undo. Late receipts never delete list cache
items: current list/context reads decide present status, so replacement memberships survive ABA.
A scope switch cancels the grace timer and synchronously erases the pending private selection.

Direct Reel and Scroll share an actual-surface controller for focus/background/unmount capture,
post-Save fresh reads and explicit unknown/conflict UI. A direct Scroll now offers real Save with
stable same-body retry. Actual SDK/renderer geometry is required; incoming local values alone never
upload. Direct Reel keeps only its private playhead for a future paused visit. Keep cards display
current scoped server places on the current twenty-item page, with at most four simultaneous
readers. Saved cards, selected detail and restore bind the displayed Saved UUID plus immutable ref.
A replacement membership for the same asset cannot supply its place or authorize Remove/restore;
Refresh lets the person choose it explicitly. Explore and direct Reel Remove pass the authoritative
UUID currently displayed. Initial stale A→B preparation mints no removal command, while a previously
unknown A command retains its exact original body for explicit retry. Starting at the top changes
position choice and never bypasses the selected membership check. Keep now draws S01/S02 (D-040); the Requested filter and a real thumbnail await their data. Source/component/protocol fixtures in Actions establish
client behavior only. Root owns real disposable-account endpoint/decoded media/device journeys
and deployment acceptance; this source makes no runtime or final privacy acceptance claim.

### Full-bleed Reel (#234, #359)

The Reel fills the screen (E01); on tablets and desktops it is a column of at most 480 px beside the
rail. The player measures nothing for its height: the stage is the column. Chrome offsets come from
`useEncounterMetrics` (below the status bar, above the tab bar or rail); short screens use the
compact rail. The measured `ReelPage` stays around the stage on native so visibility fencing is
unchanged.

Native Reel page scrolling also fences visibility: the actual video stage is measured against
its current page viewport. Scroll/layout invalidation synchronously pauses playback; only a
current mounted-stage measurement with at least half the stage visible can re-enable the existing
active fence. Monotonic callbacks, route/background and scope-end cleanup prevent late geometry
from reviving an old encounter. Returning to view does not restore play intent. Web retains its
IntersectionObserver, anchored to the video stage. Native geometry tests use labelled callbacks;
real native visibility and status pixels remain a separate hosted runtime gate.

Hosted browser cases measure actual 320×568 to 1440×900 rectangles, reachable hit targets, text
enlargement and unchanged video/lineage across resize, over labelled HTTP/media fixtures (no
decoded playback claim).

## Friends

Related: #377.

Talk links to the real Friends interface outside the tab group. Mounted ephemeral client-core sessions
use current reads, bounded explicit paging, same-body unknown retries and one-time invite delivery.
Presence, visitor visibility and contacts upload are not implied. See
[`features/friends/README.md`](features/friends/README.md) for lifecycle, fragment and evidence boundaries.

## Talk and sharing (D-042)

Related: #242.

- `features/conversations/`: C01 (`conversations-screen.tsx`, `use-talk-inbox.ts`) and C02: `conversation-screen.tsx`
  finds the conversation to open, `thread-view.tsx` is the open thread (notices, composer, options menu) around
  `thread-header.tsx` and `message-list.tsx` (messages by day; it follows the end only for a reader who is there),
  with `use-conversation-thread.ts`, `message-views.tsx`, `composer.tsx` and `conversation-menu.tsx`. The logic is
  `createConversationThread` in client-core: first a snapshot, then catch-up reads from a cursor. A message the
  person sends shows as sending, sent, "not confirmed" or "not sent", and a retry reuses the same command ID. The
  draft is kept in the account scope's storage.
- `features/sharing/`: `share-sheet-body.tsx` is what a sheet container renders for H01: it needs only the exact
  asset revision, the title and a close callback. It reads the account scope and the API origin itself, and wraps
  `share-sheet-content.tsx`, which switches between `share-menu.tsx` (Send to a conversation, Copy link, Share
  elsewhere, Stop sharing this link) and `send-to-friend.tsx` (`friend-picker.tsx`, a note, Send, Retry). The container, the encounter's sheet, owns the header, pauses playback while the sheet is
  open, restores it in `onClose` and keeps the sheet out of Back history (D-006 k). After "Open chat" the body
  closes the sheet, then navigates through `platform/after-pending-back`: on the web the encounter removes its
  history marker with an asynchronous Back, and an address pushed before it lands would be popped again.
  `shared-links-section.tsx` is the P02 card and `shared-links-screen.tsx` its page, mounted through
  `features/privacy/privacy-extensions.ts`.
- A hint on the `inbox` scope invalidates the Talk queries (`TALK_QUERY_KEY`); a missed hint is recovered by the
  30 second poll, focus and reconnect. The Talk tab shows an unread dot.
- Not built: a new-message button, starting a conversation from a
  friend's row, Report, a typing indicator and a native `/s` deep link.

## Pause and Resume personal recording

Related: #381.

Privacy & history now mounts recording controls independently of Clear. The AccountScope's policy
session fails collection closed while checking, offline, backgrounded or awaiting an ambiguous
choice. Global AppState and browser focus/storage signals reread current authority; toggles retain
the same scope and privacy epoch. Browser storage signals are disposable hints, never authority.
The native platform UUID source is installed before policy requests. Native scoped storage is
encrypted platform storage (see "Native storage" below), durable a moment after each write.

Discovery/revisit/navigation, region Open, offer/direct activation, explicit actions and Keep Remove
capture their original known recording generation once. Transport retries preserve the entire body,
including generation. Direct open and saved-place writes keep their existing protocols. Necessary
actions remain usable under a known paused policy. Unknown policy cannot invent a generation.

A recorder uses the actual accepted activation command UUID as its server session ID and requires
matching current on policy plus original eligible producer/activation generation. Pause and unknown
status discard buffered intervals and reset visibility/playback baselines. Resume cannot revive old
offers, ACKs or retained recorders; open a fresh encounter to obtain a supported eligible activation.
The versioned outbox preserves immutable original-generation batches, validates correlated terminal
ACKs, and counts/discloses old v1 batch loss rather than guessing provenance. Intake is not growth.

Authored protocol/component/browser fixtures cover these fences, unknown retries, paused Save and
fresh activation. Execute suites only in Actions. Actual API/database evidence qualification,
connected web/native/device journeys and final source composition/deployment remain Root-owned
acceptance requirements. This source does not close full privacy, export or account deletion.

## Native storage (D-045)

Related: #249.

On Android and iOS the account scope's storage is `createSecureKeyValueStore` over `expo-secure-store`
(`platform/secure-key-value-store.ts`, wired in `platform/scope-storage.ts`; _implemented, emulator-verified in
the native lane's journey_). The session token and the sign-in verifier use the same secure store
(`session-tokens.ts`, `sign-in-binding.ts`).

- The store is synchronous, like `localStorage`: memory is the working copy and changes reach the platform through one
  ordered queue. A change is durable a moment after the call. A failing backend (locked device, lost key) loses
  persistence only: after a failed index read or write it stops writing values (the persisted index is never overwritten blind) and retries the index later.
- It is bounded (256 keys, 1 MiB; the oldest written go first), so callers treat it as a cache that can miss.
- Scope keys are purged when the scope ends (sign-out, account switch, Clear, account deletion). Mounting a scope also
  removes what a killed run left under another account or epoch. The deletion receipt id is outside any scope.
- The `expo-secure-store` config plugin keeps the data out of Android backups.
- Test builds: `EXPO_PUBLIC_KS_TEST_API=1` (the native lane's test API, `docs/v2/engineering/native-lane.md`) lets the
  client use plain HTTP to localhost and makes the Android manifest allow cleartext. Never set it for a build that ships.

## Content threads and snippets (#243, D-046)

Routes: `/threads/<id>` (C04, `?m=<membership>&r=<revision>` from Talk or the share sheet), `/threads/<id>/snippet/<messageId>`
(the snippet viewer) and `/threads/<id>/read/<assetId>` (a Scroll read inside the thread). Talk (`/conversations`) lists
direct conversations and threads together; a thread row shows its people, the last message and an invitation badge.

- `features/threads/thread-screen.tsx` is C04 (T3, D-140 to D-144): `thread-chrome.tsx` (the 72 px `ThreadStrip`, people, options,
  invitation; `ThreadHeader` stays for rooms), `series-sections.tsx` and `episode-list.tsx` (the parts as rows, in the
  Series sheet on a phone and in the panel on a desktop; the arrow keys step between rows), `episode-navigator.tsx` (the
  horizontal strip rooms still use, and the shared labels and keys), `thread-encounter.tsx` (the docked bar, or the open
  encounter area), `thread-messages.tsx` (day capsules and a time under each run: another author, five minutes or a new
  day starts one) and the composer. Which episode is selected, and whether the player is docked, are kept in the account
  scope's storage on this device only; nothing about them is sent. A phone starts docked until the person unfolds the
  player themselves; watching unfolds it for good, so a resize never docks a playing Reel. Not built here: painted worlds
  and faces on the header (art, and a coarse place is T-D), the dark New Universe look, replies and reactions (T-B).
- `reel-encounter.tsx` plays a Reel inside the thread. It starts with a poster and an explicit Watch; only that opens and
  activates an exposure and mounts the ordinary `ReelPlayer`. The full-screen `snippet-viewer.tsx` does the same for a
  moment ("Watch from here") and always has a Back to thread button that returns to the same message.
- `share-moment-sheet.tsx` (H03 for a Reel) picks a range in whole seconds with steps and "Here". `share-from-scroll-sheet.tsx`
  (H03 for a Scroll) picks sentences or a block, and says "Include how I set it" and, if the block holds the person's own
  value, "Include my own value" separately (default off). `use-snippet-send.ts` sends one snippet once.
- `snippet-card.tsx` shows a moment as its range with Play, a passage as its quote with Read in context, a block as its
  title and settings in words with Open or Open as set. It marks a corrected source "Updated" and a withdrawn one with a
  quiet note and nothing to open.
- `thread-scroll-reader.tsx` and `scroll-open.tsx` read a Scroll in the thread; "Open as set" applies the sender's settings
  through an in-memory overlay (`overlayBlockState`), never to the reader's own saved block state.
- For the screens owned by the Explore, Reel and Scroll work: a Reel screen mounts `ShareSheetBody`, which now offers
  "Explore with friends" (`features/sharing/explore-with-friends.tsx`: pick friends, name, "Create thread · N friends").
  The Reel and Scroll encounter screens can reuse `ShareMomentSheet` and `ShareFromScrollSheet` through the hooks in
  `features/threads/`. `ReelEncounter` gives the player's parent its height (`stageMaxHeight` is that screen's own prop) and draws the compact controls through `controls={{ tapToToggle: false, controlsRef }}`; if the player's props change, adapt there.
- `thread-messages.tsx` merges the thread's branch cards into the timeline by the time they were made (`timeline`), shows a
  visible ⋯ on each message and a **What if…** on each snippet card, and `thread-screen.tsx` adds What if… and Another
  perspective above the message box. See the next section.
- Not built: keep listening, a thread's own Like and Save (they stay on the full-screen
  encounter), thumbnails on episode cards, native text selection for passages.

## Idea rooms (#245, D-051)

Routes: `/rooms/<id>` (R01 preview before joining; for a member, the campfire: General under the room's band, v3 R-1) and `/rooms/<id>/t/<discussionId>` (R02 discussion).
Talk (`/conversations`) lists the person's rooms and invitations under the conversations (D-006 o); a room has no tab.

- `features/rooms/room-screen.tsx`: for an outsider, the dark room header and `PreviewBody` (who is here to help, the labelled
  AI inhabitants, the pinned question, guidelines and Join, or the plain reason the person cannot join); no member, activity
  or online count is drawn there. For a member on a phone it is `campfire.tsx` (v3 R-1, D-062, D-069, D-160, D-161): the dark
  band (`CampfireHeader`: Back, the room's name that opens the room menu, "A room · 4 here" only from three people, the
  faces of who has the room open in `here-strip.tsx`, and an honest "Quiet right now · last message 3 h ago" worked out on
  the device), the AI notice (`ai-notice.tsx`) until the member taps "Got it", and General (`OpenDiscussion` of
  `discussion-screen.tsx` with the band as its header). Everything else is behind the name in `room-menu.tsx`: About,
  Guidelines, AI here (`ai-here.tsx`: Lively / Quieter / Off and "Keep my messages out of what AI reads"), Members with the
  total, Pins, Topics, share into the room, polls and quizzes, a moderator's tools and Leave. `MemberBody` (topics list in
  `topics-list.tsx`, with "Share into room" in `share-into-room-sheet.tsx`; moderator Pause and Resume in `room-parts.tsx`;
  Leave) is D04's left rail, with General first, the member's AI settings and the member total. `useRoom` keeps the lease
  (`setPresence` every 25 s while the room is open and visible, `away` when it closes) and listens for the room's hints
  (`AccountScope.watchRoom`). The T3 paper, ink and glass tokens are not in `design-tokens` yet, so the band uses the
  existing space tokens.
- `features/rooms/discussion-screen.tsx`: the same thread as a friend's. It reuses `EpisodeNavigator`,
  `ThreadEncounter` (given a `readHref`, so a Scroll opens in the ordinary reader), `ShareMomentSheet`, `SnippetCard` and the
  composer. `room-messages.tsx` draws a person's bubble, an AI inhabitant's (its label above, a dotted outline and a square
  corner, "A suggestion. Nothing is made unless someone chooses it."), a card, and the markers for a removed message, a deleted account and a message from someone the reader blocked (a moderator who blocked the author gets it collapsed with "Show for moderation", and the options to remove it). An open discussion reads afresh when the person comes back to it, and when the Friends session announces an accepted block or unblock (`announceBlocksChanged`, a counter in the scope's query cache). `inhabitant-bar.tsx` is the only way an inhabitant speaks: a button to ask each one, with the reason when it
  cannot be asked. `message-options-sheet.tsx` holds "Start a thread from this" and the moderator's remove and restore;
  `room-snippet-sheet.tsx` opens a shared moment ("Watch from here").
- `packages/client-core` holds the state: `createRoom` (preview or member view, join, leave, pause, start, invite) and
  `createRoomDiscussion` (messages with sending bubbles, catch-up, asks, pin, hide). Each command keeps its command ID until the
  server answers. A discussion catches up on focus, on reconnect and every 20 seconds.
- Which episode is selected, and whether the player is folded, stay on the device, as in a friend thread.
- Room stations (U01, U02): `useRoomStationsOnMap` reads `rooms.stations` each time the Universe regains focus and passes
  the stations to `UniverseSurface`, which draws a 3D station beside the system it names (angle from the room's ID, just
  outside the outermost orbit), adds a target "Name, a room station" and a "Rooms" section to the list view, and opens the
  room on a tap. A read that fails leaves the map as it was. A visit to a friend's map passes none.
- R03 (`activities-section.tsx`, `activity-screen.tsx`, `poll-card.tsx`, `quiz-flow.tsx`, `start-activity-sheet.tsx`): the
  room's page lists its polls and quizzes as "Optional" (nothing at all when there are none and the person is not a
  moderator; no count or badge). A poll is a radio group; results (with the voters' names) show once the person has voted or
  the poll is closed; an unsent vote says "Not sent yet" and retries as the same command. A quiz is read one question at a
  time and its answers stay in the component, so leaving drops the position without a nag. A moderator starts either from a
  sheet and closes or removes it from the poll's own screen. Routes: `/rooms/<id>/activity` and `/rooms/<id>/activity/<id>`.
- D04 (`app/rooms/[roomId]/_layout.tsx`, `room-workspace.tsx`): from 1024 px a member sees the room and its threads on the
  left, the open discussion, poll or quiz in the centre (the same screens, rendered by a nested `Stack`) and the room extras
  (the newest open poll in place, the activity list, a moderator's start buttons) on the right. The layout shares one room
  controller with the centre through `RoomWorkspaceContext`, so a join or leave changes the panes at once; an outsider sees the
  preview alone. The navigation rail is not drawn beside rooms (they are outside the tab stack, like Talk's threads).
- Not built: What-if, a focused snippet viewer, sharing a Scroll passage back from a room, reports.

## What if and Another perspective (#244, D-049)

`features/scenarios/`. A member asks from the whole thread (the two buttons above the message box), from a message (its ⋯
menu, `message-step.tsx`) or from a shared moment or passage (the **What if…** on its card). All three open one sheet, an overlay
rather than a route, so closing it returns to the same place in the thread. *Implemented; exercised in tests and a browser
locally, not on dev.*

Runtime-verified for the branch view and the map (X03, X04: web, 430 px and 1280 px, a local PostgreSQL, API and worker with
the real model, two people in one thread): a what-if, a perspective from a message, a what-if from the end of a branch
("Try another assumption"), a speculative branch and one under it (it inherits), a removed branch, a branch still
preparing, an offer the member did not make (shown to its owner only, never to the other member), the map from the
thread and from inside a branch, search and the filters remembered per thread, and Back after choosing from a branch.
Runtime-verified earlier (X01, X02): asking from the whole thread and
from a message's ⋯ menu, a speculative idea asking to be confirmed, the branch card preparing and then ready without a
reload, a second member opening the same Scroll, and a what-if continued from a branch. Not driven on native. The own-request
form with earlier premises (add or replace) and the removed-branch note are covered by component tests, not yet driven in a browser.

- `scenario-sheet.tsx` is the one sheet (X01) and its first step. `message-step.tsx` is a message's menu (the quote and
  What if… / Another perspective): a step of the same sheet, not an overlay of its own, because closing one overlay as
  another opens breaks the web's history handling. `scenario-start.ts` says where a request starts and what it
  continues, including the premises that already hold.
- `sheet-body.tsx` chooses the step by what the composer controller says: `compose-step.tsx` (the kind switch, a "From:"
  chip, "Your idea"), thinking with "Write my own version", `direction-steps.tsx` (one clear idea as a summary with Edit and
  **Explore**, a few suggested directions each with **Explore this**, and the confirm step "Speculative scenario · not
  established science" with **Create branch**), `own-request-form.tsx` and `outcome-steps.tsx` (no suggestions, started,
  and a plain message when blocked: no more branches for now, nothing to look up, offline). The words are kept on the
  device until a branch exists. Asking never makes anything; only Explore, Explore this or Create branch does.
- `own-request-form.tsx` is the member's own complete request: what changes, what stays, or the lens. Where the branch
  continues others, it lists the premises that already hold, and a changed line is either a new premise or **Replaces:
  <subject>** one of them; an edited suggestion keeps its subjects. Nothing silently stands beside the premise it contradicts.
- `branch-card.tsx` (X02): a dashed cobalt card for a what-if and anything below it, a solid raised card for a perspective on the
  real subject; "Hypothetical" and the Changed and Kept chips (which wrap); Preparing with a stripe, Ready with **Explore this**,
  **What if…** (continue from this branch), and Remove for whoever asked; "Couldn't prepare this branch"; a removed branch
  stays in the chat as a quiet note. It shows nobody's position and no part number.
- `use-scenarios.ts`: `useScenarioBoard` polls the branches every 20 seconds (5 while one is preparing) and on focus or
  reconnect; `useScenarioComposer` looks at its draft every 1.5 seconds while the directions are being thought of.
  `use-thread-scenarios.ts` holds where a request starts in one open thread, and `asks-bar.tsx` is the two buttons above the
  message box. The controllers are `createScenarioBoard` and `createScenarioComposer` in client-core.
- Exploring a ready branch opens `/threads/<id>/b/<node>` (X03, `branch-screen.tsx`): the thread's title, "What if ·
  <idea>" (a title that already starts "What if" is not prefixed twice), a yellow way back that names the part the member
  had selected (or the thread), the branch's one item ("1 · current", "1 · preparing" until its Scroll exists),
  "Speculative scenario · not established science" in words when it is, the Scroll, and at its end "Try another
  assumption" (the words go to the same sheet, which asks for directions). A removed or unknown branch and a branch
  still being prepared say so and keep only the way back. What the address shows is chosen by `branch-view.ts` from what was
  read, and only a card that is there and `removed` says "removed": a thread that is not the member's shows the thread's
  "This thread isn't available", a failed read shows "Can't open this branch" with Try again, and a branch missing among
  those read shows "This branch isn't available" without saying why. `use-mark-here.ts` remembers on the device where the
  member is. The **Map** button is here too once the thread has several
  branches, so a member can move between branches without going back; "You" marks the branch they have open. The Scroll is the member's own encounter without
  the thread's share control (`ThreadScrollArticle chrome="own"`). Where the member is stays on the device
  (`thread.here.<id>`).
- The **Map** button in the thread's header, and in a branch's (X04, `map-sheet.tsx`, `map-rows.tsx`, `use-thread-map.ts`) appears once the
  thread has two or more branches. It is an overlay with a nested list: the original sequence, its branches nested, "You"
  on the member's own place, removed branches as "Removed", suggestions dashed and unnumbered ("SUGGESTION · NOT MADE",
  press to see its directions), a group of five or more folded after three ("More from Part 1 · Show"; a fold never hides a
  single line). Opening a branch or a suggestion waits for the map's own browser-history entry to go (`afterPendingBack`),
  as every sheet that navigates does. Search and Mine / Everyone / Suggestions
  appear for a larger map; the filter and opened groups are remembered per thread on the device. `use-thread-branches.ts`
  gathers what a thread does with its branches (asking, the map, opening one); `branch-sheets.tsx` holds its two overlays.
- Not built: a discussion scoped to one branch, a position time in the way back, Resume on branch cards, a retry for a
  failed branch, the map's "opened" observation.

## Feedback and report (#250, D-055)

P03 is an overlay with no route of its own (`features/feedback/`, its README). The encounter's ⋯ and a long-press on a Reel
open it as the `feedback` overlay owner (`session.openFeedback`); the conversation, a room's message options and the friend
visit open it in a bottom sheet (`FeedbackSheet`). The state lives in client-core (`feedback-store.ts` per account scope:
the timed Undo of "Not interested" and the reports kept for a connection; `feedback-flow.ts` per sheet: the forms). The
Operator screen shows the newest reports as card 7 (ids and kinds only), and a room's moderators see the reported
messages of their room under Moderator tools.

