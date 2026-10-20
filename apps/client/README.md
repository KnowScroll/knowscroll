# @knowscroll/client

One Expo (SDK 58) application for Android, iOS and the web, with Expo Router. It loads the
bundled fonts from `packages/design-tokens/fonts/` (variable weight ranges via expo-font) and
draws everything from `@knowscroll/design-tokens` and `@knowscroll/ui`.

## Routes (coverage matrix, `docs/v2/discovery/design-screens.md`)

| Route | File | Shows | Page title (web) |
|---|---|---|---|
| `/` | `app/index.tsx` | Redirects to `/explore` | — |
| `/explore` | `app/(tabs)/explore.tsx` | A03 first arrival: the "How to move around" hint (for once a Reel plays) and an honest "Nothing is ready to play yet" (no starter content exists before the thin journey) | Explore |
| `/universe` | `app/(tabs)/universe.tsx` | U01 empty universe | Universe |
| `/conversations` | `app/(tabs)/conversations.tsx` | C01 empty Talk ("Talk" is the label) | Talk |
| `/saved` | `app/(tabs)/saved.tsx` | S01 empty Keep ("Keep" is the label) | Keep |
| `/account` | `app/(tabs)/account/` | The account stack, reached from the avatar on every tab (D-006 c): signed in, the address with "Sign out" and "Sign out on every device"; signed out, "Sign in"; API unreachable, "Try again". Back names where it goes ("Back to Keep") | Account |
| `/welcome` | `app/(auth)/welcome.tsx` | A01 sign in: "Continue with email", "I have a sign-in link" (S1.3 #226) | Welcome |
| `/signin` | `app/(auth)/signin/index.tsx` | The email form (labelled field; invalid · sending · too many links · can't reach) | Sign in |
| `/signin/link` | `app/(auth)/signin/link.tsx` | A01 link sent: the address from this session (never the URL), "Resend the link", "Use a different email" | Check your inbox |
| `/redeem` | `app/(auth)/redeem.tsx` | Where a link lands (`/redeem#token=…`): the token is read from the fragment and removed from the address bar; one tap POSTs it (opening the link consumes nothing); without a link, a paste field | Finish signing in · Use your sign-in link |
| `/recover` | `app/(auth)/recover.tsx` | A02: `?reason=link` "This link didn't work" (send a new link); otherwise "You were signed out" | This link didn't work · You were signed out |
| `/gallery` | `app/gallery.tsx` | Developer component gallery and API health, only when built with `EXPO_PUBLIC_KS_GALLERY=1` (stable marker `testID="ks-component-gallery"`); otherwise "This page isn't here" | Component gallery |
| `/gallery-scroll` | `app/gallery-scroll.tsx` | Developer Scroll gallery (fixture documents through `prepareScrollDocument` and `ScrollArticle`; query `doc`, `block`, `motion=reduce`, `scale=2`), only when built with `EXPO_PUBLIC_KS_GALLERY=1` (marker `testID="ks-scroll-gallery"`); otherwise "This page isn't here" | Scroll gallery |
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
