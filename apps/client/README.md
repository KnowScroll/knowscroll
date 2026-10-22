# @knowscroll/client

One Expo (SDK 58) application for Android, iOS and the web, with Expo Router. It loads the
bundled fonts from `packages/design-tokens/fonts/` (variable weight ranges via expo-font) and
draws everything from `@knowscroll/design-tokens` and `@knowscroll/ui`.

## Routes (coverage matrix, `docs/v2/discovery/design-screens.md`)

| Route | File | Shows | Page title (web) |
|---|---|---|---|
| `/` | `app/index.tsx` | Redirects to `/explore` | — |
| `/explore` | `app/(tabs)/explore.tsx` | Signed in: actual discover → offer activation → Scroll/Reel, current context, actions, real continuations and a private retained path. Signed out: first-arrival hint and the existing email sign-in route. | Explore |
| `/universe` | `app/(tabs)/universe.tsx` | U01 empty universe | Universe |
| `/conversations` | `app/(tabs)/conversations.tsx` | C01 empty Talk ("Talk" is the label) | Talk |
| `/friends` | `app/friends/index.tsx` | Real profile, exact handle lookup, bounded Friends/requests/blocked rosters, current pair actions and revocable invite links (#377); no fabricated presence or visibility | Friends |
| `/friends/invite` | `app/friends/invite.tsx` | Fragment-only invitation entry; pure Check, then explicit Request; signed-out links are discarded before sign-in | Friend invitation |
| `/saved` | `app/(tabs)/saved.tsx` | S01/S02 Keep: scoped bounded saved list, real metadata/status, filters, remove/retry and explicit immutable original/updated-version revisit choices. | Keep |
| `/account` | `app/(tabs)/account/` | The account stack, reached from the avatar on every tab (D-006 c): signed in, the address with "Sign out" and "Sign out on every device"; signed out, "Sign in"; API unreachable, "Try again". Back names where it goes ("Back to Keep") | Account |
| `/welcome` | `app/(auth)/welcome.tsx` | A01 sign in: "Continue with email", "I have a sign-in link" (S1.3 #226) | Welcome |
| `/signin` | `app/(auth)/signin/index.tsx` | The email form (labelled field; invalid · sending · too many links · can't reach) | Sign in |
| `/signin/link` | `app/(auth)/signin/link.tsx` | A01 link sent: the address from this session (never the URL), "Resend the link", "Use a different email" | Check your inbox |
| `/redeem` | `app/(auth)/redeem.tsx` | Where a link lands (`/redeem#token=…`): the token is read from the fragment and removed from the address bar; one tap POSTs it (opening the link consumes nothing); without a link, a paste field | Finish signing in · Use your sign-in link |
| `/recover` | `app/(auth)/recover.tsx` | A02: `?reason=link` "This link didn't work" (send a new link); otherwise "You were signed out" | This link didn't work · You were signed out |
| `/scroll/<assetId>` | `app/scroll/[assetId].tsx` | A Scroll opened by its address (D-006 d; `?anchor=<blockId>` restores a block): opens the exposure, reads the negotiated document, activates, renders and records what is read (client-core's recorder), and restores the position by block on return. Signed out: the sign-in prompt; every other state (loading, "isn't available", "needs an app update", offline, error) has a screen. The article uses the full `packages/ui` `ScrollArticle` renderer and AccountScope block-state store. In a world with operator tools (dev, stage, ci, local) a collapsed "Dev · evidence" panel shows the committed evidence watermark (`features/diagnostics/evidence-panel.tsx`; never consumer UI) | The Scroll's title |
| `/gallery` | `app/gallery.tsx` | Developer component gallery and API health, only when built with `EXPO_PUBLIC_KS_GALLERY=1` (stable marker `testID="ks-component-gallery"`); otherwise "This page isn't here" | Component gallery |
| `/gallery-scroll` | `app/gallery-scroll.tsx` | Developer Scroll gallery (fixture documents through `prepareScrollDocument` and `ScrollArticle`: `doc` = `bridges` (poster), `lighthouse` (editorial), `experiments` (every interactive and visual block), `fallback`; query `block`, `motion=reduce`, `scale=2`, `text=1` for the text version of diagrams), only when built with `EXPO_PUBLIC_KS_GALLERY=1` (marker `testID="ks-scroll-gallery"`); otherwise "This page isn't here" | Scroll gallery |
| `/s/<token>` | none (reserved) | Share links (D-006 d). On the web the edge sends `/s/*` to the API's public page (D-008); the client's `/s/[token]` screen arrives with sharing (H01–H02). No route, group or catch-all may claim `/s` before then (`features/shell/route-map.test.ts`) | — |
| anything else | `app/+not-found.tsx` | Not found, with "Go to Explore" | Page not found |

Every page title reads "<title> · KnowScroll" (`platform/document-title.web.ts`, set when the
screen gains focus; native screens have none).

Navigation by size (V01): floating tab bar on phones (icon-only ≤ 360 px), a 76 px rail on
tablets (600–1023 px), an 88 px rail with the K mark and the account avatar on desktops
(≥ 1024 px). The account route belongs to no tab; each tab keeps its own state and Back follows
the person's own history (`backBehavior="history"`).

Every navigation control is a link with its address (`/saved`, `/account`, `/explore`): on the
web a real `<a href>`, so Enter, middle-click and open-in-new-tab work. The bar always comes after
the screen in the document, so reading and Tab order is top bar → content → navigation (V01):
the phone pill floats over the bottom, and on tablets and desktops the rail is drawn over a left
margin the screens leave free (`sceneStyle`), with the desktop avatar last in the rail.

The encounter controller advertises both `scroll-document.v1` and `reel-document.v1` when
opening discovery or a Saved revisit. Its Scroll block/version declaration still comes from the
actual renderer registry. A Scroll-only capability declaration would correctly make the backend
exclude Reels, even though this controller has a working Reel player.

## Layout of the code

- `app/`: routes only (Expo Router). Tests never live here (every file would become a route).
- `features/`: screens and their tests (`*.test.tsx`, jest-expo + React Native Testing Library;
  `features/shell/navigation.test.tsx` renders the real route tree with `expo-router/testing-library`;
  `features/shell/route-map.test.ts` checks the route files against the route map).
- `platform/`: platform files (`document-title(.web).ts`) and their web tests
  (`*.web.test.tsx`, the `web` Jest project, jest-expo/web in jsdom).
- `e2e/`: the Playwright web smoke over the static exports (`web-smoke.spec.ts` against `dist/`:
  links, Tab + Enter, modified clicks, page titles, focus order at 834 and 1440, no gallery;
  `gallery-smoke.spec.ts` against `dist-gallery/`: the gallery marker, the sheet's Esc, focus
  return and browser Back, the format switch's arrow keys, pressed-toggle colour) and
  `serve-export.mjs`, a static server with the edge's single-page fallback.
- `features/scroll/`: the Scroll route's screen (`scroll-screen.tsx`), the open → document → activate session
  (`scroll-session.ts`, a pure controller with a hook), the resume anchor (`anchor-keeper.ts`: block ID by
  article revision, in the account scope's storage), the capabilities this build declares
  (`capabilities.ts`, exported directly by the renderer registry). The route uses `packages/ui` `ScrollArticle` with AccountScope block state and a recorder observer; the resume keeper freezes before unmount closes visibility intervals. `features/diagnostics/evidence-panel.tsx` is the dev-only
  evidence view: it renders only when `GET /health` names a world with operator tools, and the API answers
  its route with 404 elsewhere.
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

| Command | Does |
|---|---|
| `pnpm --filter @knowscroll/contracts build` | Needed once before bundling: the web and native bundles read `@knowscroll/contracts` from its `dist/` (D-012); tests and type-checking read its sources |
| `pnpm --filter @knowscroll/client build` | `expo export --platform web` into `dist/` (`web.output: "single"`: a static SPA served by Caddy at the site root, D-008) |
| `pnpm --filter @knowscroll/client build:gallery` | The same export with the gallery (`EXPO_PUBLIC_KS_GALLERY=1`) into `dist-gallery/`, for comparing with `Components.html`; never shipped |
| `pnpm --filter @knowscroll/client test` / `test:web` | The Jest projects / the Playwright smoke over `dist/` and `dist-gallery/`. Both run in GitHub Actions only (D-010); the `client` job installs Chromium there |
| `npx expo start` / `npx expo run:android` | Development server / development build. Native builds read `EXPO_PUBLIC_KS_API_ORIGIN` (the world origin; HTTPS, or plain HTTP to `localhost`/`127.0.0.1`/`10.0.2.2` in development builds only) |

The native identifiers are `com.knowscroll.client` (distinct from the v1 `com.knowscroll.mobile`
preview). `android/` and `ios/` are generated by `expo prebuild` and never committed. Native
builds are not part of CI (CF-31). Automated suites run in GitHub Actions only (D-010).


Native module host declarations: `expo-clipboard` is declared directly by this app for Friends' deliberate one-time invite copy and so Expo autolinking includes the module used by `packages/ui`'s code-copy control. TypeScript, the UI import, frozen lockfile and Android build remain checked.

`/reel/<assetId>` opens/activates an admitted immutable Reel, renders the shared format switch/action
rail, and records playback into the account-scoped durable outbox. Save uses the real command; actions
without a command are hidden and an absent Scroll sibling is unavailable. Fixture imports carry a
prominent fixture banner. Renewing a media grant reuses the existing exposure and never counts as a
new encounter. Browser cookies authenticate video GETs; native source headers come from AccountScope.

The interim direct Scroll session accepts only direct-open exposure lineage. A Composer
ready/pending/exhausted response produces the existing controlled error state; the new Explore
consumer will own those outcomes (#234). This compatibility guard adds no navigation UI.


## Encounter navigation (#234)

`features/encounter/encounter-session.ts` owns typed discover/revisit, semantic navigation,
offer activation and current authorized exposure context. Each intent keeps its command IDs
through unknown-outcome retries. Stale intent refreshes current context and requires a fresh
choice; ready offers activate only while Explore is foreground. The session belongs to the
AccountScope, survives tab/component detours and ends when the scope ends.

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
series position; Related uses a dashed treatment. The local trail says Visited. Real pending
work stays distinct from exhaustion; neither fabricates a future Part or changes format by
itself. Share, Ask, snippets and missing-variant requests remain unavailable until their own
issues; the complete J1 storyboard therefore remains incomplete.

Reel navigation wraps only the actual noninteractive video stage. Player seek/Play controls
remain outside that responder; article/slider/chart/code pointers stay with the child. Scrolls
also offer an explicit navigation surface below the article. Axis ownership locks until release; native starts inside the 24 px system-Back edge
stay with the platform. Vertical Scroll gestures never navigate, including end momentum. Every
move has a named button; normal keyboard activation works without claiming article reading keys.
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

## Private Ask and format requests (#239)

Ask opens a local E04 overlay over the exact parked encounter. The same host owns the path menu
and request composer. The composer uses a bounded bottom sheet with a grab, rounded top corners
and a visible backdrop; wider screens center the same sheet. A desktop Ask-anchor position is
not implemented. Exclusive format/context choices expose radio groups. Close, Esc and Back dismiss it first and preserve paused position and sound.
Missing siblings remain unavailable in the format switch; the menu offers explicit Request Reel
or Request Scroll actions. Existing ready siblings keep the normal navigation path.

`features/requests/request-session.ts` owns one memory-only draft/request per AccountScope. It sends
real `supply.create/read/cancel` HTTP commands with the existing encounter capabilities. Private text
is bounded to 500 characters; the current backend closes free-text requests as unsupported. Three
explicit catalogue suggestions send their selected canonical intent, without interpreting private
prose or claiming inventory. About-this/variant submissions freeze the exact exposure, immutable
asset revision and latest authorised matching session revision; changed sources require a new choice.

A deliberate send/cancel gets a fresh command ID. Unknown transport outcomes freeze the entire
command for exact retry; read refreshes never submit work. Immutable acceptance is separate from
current availability, fenced by scope/epoch/request revision. Polling runs at most twelve five-second
reads while the request panel is foreground, stops on terminal/close/scope end, and can be refreshed
explicitly. Reopening reads current status. Ready never interrupts playback: Open rechecks status,
then uses the existing exact-revision return/open/activation flow. Cancel affects only the caller's
waiter according to server authority; closing is not cancellation. Scope end clears all draft,
frozen command, source, receipt, status and timers. There is no durable request list or production
retry endpoint in this bounded consumer. CI fixtures cover these boundaries; actual connected web
and native request journeys remain coordinator-owned acceptance work.

## Mounted own Universe (#238)

`/universe` now mounts `createUniverseSceneSession` through one view controller per actual
AccountScope object. Focus/AppState starts and pauses its existing readonly QueryObserver; the
scope's existing socket supplies hints. No polling, second socket, observation, exposure, command,
provider, job or persistence is created by a map action. Same-scope camera/history (maximum32)
returns exactly; scope end synchronously clears the controller, geometry cache and view. A fresh
scope object with the same account/epoch never reuses that state. Capability replacement disposes
old reads before starting one replacement; abort-ignoring replies remain fenced by accepted core.

The layered SVG draws canonical scene-core numeric silhouettes and server anchors. Full/low and
reduced motion keep identical targets. Geometry cache≤128/full vertices≤8192; viewport output≤64
bodies/64 routes/32 labels. Crowded drawings explicitly offer the virtualised outline, where all
accepted≤1000 places remain reachable. Native background pan/pinch and named zoom/fit controls,
web map-only keys, ordinary44px targets and outline buttons provide the same navigation. Browser
Back uses one same-address transient marker with no private frame/IDs in history. Panels close
before a retained camera level; native/toolbar Back follows the same controller.

Only accepted empty reads use the empty screen. Loading never implies a new planet. Last complete
same-scope snapshots remain visibly stale on lag/network failure and retain their own labels;
authority refusals clear private state. Unsupported drawing can retain the independently validated
Geography outline. Canonical input/catch-up/8MiB accepted-data budgets remain unchanged; they do not
promise a raw pre-decode network allocation bound.

This first mounted slice covers overview/system/planet/region focus, place details, actual current
same-system planet-route travel, outline and exact local Back. It does not draw prototype ML worlds,
on-globe region positions, landmarks or cross-system routes absent from current descriptors. The
current persisted global lattice and x/y/scale camera remain authoritative. Region encounter Open,
Lately recency and once-only U05 presentation await their owning backend contracts/authority. The
place card explicitly states encounter unavailability and offers only general Explore. Actual
reading→formation, populated projection, visual/device performance and full U01–U08 parity are
not established or closed by this source change. CI scenes are labelled authored protocol fixtures,
not personal activity. Connected dev/native/physical acceptance remains coordinator work; the
separately frozen fb2/schema28 writer experiment is not automatically replaced by this source.

## Mounted Keep lifecycle (#234/#246/#344)

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
position choice and never bypasses the selected membership check. Full S01/S02 visual/interaction parity remains follow-up work. Source/component/protocol fixtures in Actions establish
client behavior only. Root owns real disposable-account endpoint/decoded media/device journeys
and deployment acceptance; this source makes no runtime or final privacy acceptance claim.

### Responsive media flow (#359)

Explore Reel and direct Reel pages scroll in normal flow: the shared player measures its actual
frame width and at most half the actual measured page height for a bounded video stage, then lays out wrapping playback controls, captions, actions
and subject navigation below. Stage resize preserves the mounted SDK player, exposure, grant and
private sound/place. Ready continuation edges are anchored to the video stage and remain outside
its gesture responder. The encounter header gives the complete format labels their own row;
unavailable/preparing words wrap and targets remain at least44px. Scroll retains its own bounded
article scroller and interactive gesture exclusions, without a Reel page scroller around it.
Cream component/Scroll galleries set dark system icons on focus, matching ScreenFrame's existing
per-route ownership. Spatial routes keep their own light tone.

Hosted browser cases measure actual355×767/320×568/390×844/landscape/tablet/desktop rectangles,
reachable hit targets, text enlargement and unchanged video/lineage across resize. These use labelled
HTTP/media fixtures, with no decoded playback claim. UI fixtures pin actual200% text/reduced motion;
router focus fixtures do not prove native status pixels. Connected real dev playback/Keep/resize and
hosted native gallery→space→back visual verification remain separate acceptance gates.

Native Reel page scrolling also fences visibility: the actual video stage is measured against
its current page viewport after safe/tab exclusions. Scroll/layout invalidation synchronously
pauses playback; only a current mounted-stage measurement with at least half the stage visible
can re-enable the existing active fence. Monotonic callbacks, route/background and scope-end
cleanup prevent late geometry from reviving an old encounter. Returning to view does not restore
play intent. Web retains its existing IntersectionObserver, anchored to the video stage. Native geometry tests use labelled
callbacks; real native visibility and status pixels remain a separate hosted runtime gate.

## Friends (#377)

Talk links to the real Friends interface outside the tab group. Mounted ephemeral client-core sessions
use current reads, bounded explicit paging, same-body unknown retries and one-time invite delivery.
No conversation, presence, visitor visibility or contacts upload is implied. See
[`features/friends/README.md`](features/friends/README.md) for lifecycle, fragment and evidence boundaries.
