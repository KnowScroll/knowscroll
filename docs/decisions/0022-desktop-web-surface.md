# ADR-0022 — Desktop is a TypeScript web surface

Date: 2026-09-20. Status: accepted — **owner decision** ("web"), recorded by the coordinator for
[#92](https://github.com/KnowScroll/knowscroll/issues/92) under #3/#72. Complements
[ADR-0002](0002-native-android-compose.md), which remains the Android decision.

## Context

The [v1 release contract](../product/v1-release.md) requires polished mobile **and desktop** UI
with one coherent experience and the §9.5 desktop interaction contract: pointer and keyboard universe
navigation, a centered stage with origin context around it, optional branch/source rails, split view
only for comparison, arrow keys and accessible buttons mirroring gestures, and no permanent dashboard
chrome. No desktop client exists. The Android app is one `:app` module whose data layer is bound to
Android APIs (`SharedPreferences`, `HttpURLConnection`/`org.json`, `AndroidViewModel`). The API is
bearer-authenticated JSON over HTTP, and `packages/contracts` already holds strict TypeScript/zod shapes.

## Decision

1. Build desktop as a web app in `apps/web` (existing `apps/*` workspace): **React + TypeScript +
   Vite**, importing `packages/contracts` for request/response shapes. Exact dependency versions are
   pinned from the registry at install time and recorded in the lockfile; none are invented here.
2. Tests: unit/component tests with Vitest; real browser journeys with Playwright Chromium against
   disposable API/worker/PostgreSQL. Browser binaries and caches live under `KS_DEV_ROOT` on the SSD.
3. **Development authentication only.** The Vite dev/preview server binds 127.0.0.1 and proxies
   `/v1/*` to a configured loopback API, adding the operator-issued device-session bearer token
   server-side. The token never enters browser JavaScript, storage or the bundle. Production builds
   and non-loopback serving are refused until production identity (#2) exists, mirroring Android's
   disabled release variant. The API contract is unchanged (same-origin through the proxy; no CORS).
4. Product rules carry over exactly: exposure only for an encounter actually visible in a visible
   document (never prefetch); stable retry identities for exposure/Keep; "Kept" only after acceptance;
   scoped browser storage bound to universe and privacy epoch and purged on 401/epoch change; no
   controls for unavailable capabilities (Ask per ADR-0016, Reel, Friends, branches); truth state and
   sources always visible where needed; reduced motion honoured.
5. Desktop is designed for desktop, not a stretched phone column: centered reading stage, origin
   context around it, source rail, full keyboard operation with visible focus.

## Alternatives and why

- *Compose Multiplatform desktop:* best eventual Kotlin reuse, but first requires extracting the
  Android data/view-model layer into a KMP module plus new JVM desktop packaging. That is a separate
  restructuring project; it can be revisited if shared Kotlin UI becomes valuable.
- *Electron/Tauri shell:* adds packaging without a v1 requirement for a native installer.
- *React Native/Flutter rewrite:* discards the verified native Android work.

## Consequences

Two UI codebases (Kotlin, TypeScript) share the HTTP contract and product rules, not UI code; parity
is verified by journeys on both. CI gains web typecheck/unit tests; Playwright journeys need a browser
and run locally first (CI inclusion decided in the implementing issue). Reel playback on web will need
an authenticated media transport that a `<video>` element can use (the header-injecting proxy covers
development only); that belongs to the media-serving contract, not this ADR. Owner visual acceptance
remains separate from automated checks.
