# Dependency matrix

The exact versions the v2 workspace runs on, why each was chosen, and what CI proves about them.
Versions are pinned **exactly** in the `catalog:` of `pnpm-workspace.yaml` (`catalogMode:
strict`, `savePrefix: ''`, `strictPeerDependencies: true`) and in `pnpm-lock.yaml`. Change a
version only together with this file.

Recorded 2026-10-19 (S1.1, #224; extended by S1.2, #225). Registry facts (versions, dates, licences, peers) were read from
registry.npmjs.org and the installed packages on that date. Research notes:
`/Volumes/Mrigesh SSD/knowscroll-dev/v2/discovery/compat-matrix.md`.

Licences: every direct dependency below is MIT, Apache-2.0, ISC or (squawk) Apache-2.0 OR MIT.
Transitive production dependencies also include BSD-2-Clause/BSD-3-Clause (for example `qs`,
`ieee754`, `json-schema-typed`), 0BSD (`tslib`) and MIT OR CC0-1.0 (`type-fest`); all are
permissive. Review the licence list again when a dependency is added.

## Runtime and package manager

| Item | Pinned | Where | Reason |
|---|---|---|---|
| Node | 22.23.0 (CI, `.nvmrc`); engines `>=22.23.0 <23` | `.nvmrc`, `package.json` `engines`, `checks.yml` | VPS runs 22.23.3; Node 22 LTS until 2027-04-30; Expo SDK 58 / RN 0.88 need ≥22.13, pg-boss ≥22.12. Moving to Node 24 is a separate change. |
| pnpm | 10.34.7 | `package.json` `packageManager`, `engines` | Stable maintenance line. pnpm 11 replaces `onlyBuiltDependencies` with `allowBuilds` and adds release-age gates; pnpm 12 shipped 14 minors in 7 weeks and now errors on unknown workspace keys. Neither offers something this workspace needs yet. |
| PostgreSQL | 16 (CI `postgres:16` service; production major) | `checks.yml` | Production major on the VPS. pg-boss needs ≥13. The CI log prints the exact server version: 16.15 on 2026-10-19. |

## Toolchain

| Package | Version | Published | Licence | Peer notes |
|---|---|---|---|---|
| typescript | 6.0.3 | 2026-04-16 | Apache-2.0 | TS 7.0 has no JS compiler API; typescript-eslint supports `<6.1.0`; Nest CLI and the Expo template use 6.0. |
| @types/node | 22.20.5 | 2026-10-01 | MIT | Matches the Node 22 runtime. |
| eslint | 10.13.0 | 2026-10-16 | MIT | |
| @eslint/js | 10.0.1 | 2026-02-06 | MIT | eslint ^10 |
| typescript-eslint | 8.71.2 | 2026-10-12 | MIT | eslint ^8.57‖^9‖^10; typescript >=4.8.4 <6.1.0 |
| @eslint-community/eslint-plugin-eslint-comments | 4.8.1 | 2026-09-12 | MIT | eslint ≤10; enforces a reason on every disable comment |
| eslint-config-prettier | 10.1.8 | 2025-07-18 | MIT | |
| eslint-plugin-react-hooks | 7.1.1 | 2026-04-17 | MIT | eslint ≤10 |
| globals | 17.13.0 | 2026-10-01 | MIT | |
| prettier | 3.9.10 | 2026-10-10 | MIT | The one formatter. |
| dependency-cruiser | 18.6.0 | 2026-10-11 | MIT | Loads the workspace `typescript`. |
| knip | 6.42.0 | 2026-10-18 | ISC | No TypeScript dependency. |
| squawk-cli | 2.70.0 | 2026-10-15 | Apache-2.0 OR MIT | Migration hazard lint (PostgreSQL 16 rules). |

## Backend

| Package | Version | Published | Licence | Peer notes |
|---|---|---|---|---|
| @nestjs/common, @nestjs/core, @nestjs/platform-express | 12.1.3 | 2026-10-12 | MIT | **Not 12.2.0** (released 2026-10-19 with behaviour changes: IoAdapter message cap, Express parser limits, express 5.3.0). platform-express 12.1.3 pins express 5.2.1. |
| @nestjs/cli | 12.0.8 | 2026-09-28 | MIT | Builds with `builder: tsc` (no webpack/SWC/Rspack peers installed). |
| @nestjs/websockets, @nestjs/platform-socket.io | 12.1.3 | 2026-10-12 | MIT | platform-socket.io 12.1.3 depends on socket.io 4.8.4 exactly. |
| socket.io | 4.8.4 | 2026-09-25 | MIT | The version platform-socket.io pins (one copy); imported for `Server`/`Socket` types. |
| express | 5.2.1 | 2025-12-01 | MIT | The exact version platform-express 12.1.3 depends on (one copy in the tree). |
| @types/express | 5.0.6 | 2025-12-01 | MIT | Types for the Express request/response objects used by the API's middleware. |
| reflect-metadata | 0.2.2 | 2024-03-29 | Apache-2.0 | |
| rxjs | 7.8.2 | 2025-02-22 | Apache-2.0 | |
| @orpc/contract, @orpc/server, @orpc/nest, @orpc/openapi, @orpc/zod, @orpc/client, @orpc/openapi-client | 1.15.7 (lockstep) | 2026-10-14 | MIT | @orpc/nest peers `@nestjs/* >=11`, `express >=5`. oRPC's 1.x CI tests Nest 11 only; Nest 12.1.3 compatibility is proven by this workspace's CI (S1.2 spike, below). |
| zod | 4.6.7 | 2026-10-12 | MIT | @orpc/zod needs >=3.25. |
| kysely | 0.29.7 | 2026-10-17 | MIT | `Migrator` moved to `kysely/migration` in 0.29. |
| pg | 8.23.1 | 2026-09-30 | MIT | pg-boss depends on ^8.23.1 (one copy). |
| @types/pg | 8.23.1 | 2026-08-17 | MIT | |
| pg-boss | 12.38.0 | 2026-10-13 | MIT | ESM; `fromKysely` from the package root; Node ≥22.12; PostgreSQL ≥13. |
| pino | 10.4.0 | 2026-10-02 | MIT | Written to only through `logEvent`. |

## Backend verification

| Package | Version | Published | Licence | Notes |
|---|---|---|---|---|
| vitest | 4.1.12 | 2026-10-15 | MIT | Nest 12's template line (vitest 5 is newer but not needed). Resolves workspace sources through `vitest.workspace-sources.ts` (the `@knowscroll/source` export condition). |
| @fast-check/vitest | 0.5.0 | 2026-09-11 | MIT | peers vitest ^4.1‖^5; brings fast-check 4.x for property tests. |
| kysely-codegen | 0.20.0 | 2026-02-16 | MIT | peers kysely >=0.27 <1, pg >=8.8 <9. Weakest maintenance signal in the DB layer (last release Feb 2026); only used to generate and verify types, never at runtime. |
| socket.io-client | 4.8.4 | 2026-09-25 | MIT | Release tests' Socket.IO client; since S1.3 also the AccountScope's hint socket in `@knowscroll/client-core`. |
| fast-check | 4.10.2 | 2026-09-19 | MIT | Property-based tests (`@knowscroll/scroll-model`, S2.1 #230). Depends on pure-rand ^8; no peers. The same version `@fast-check/vitest` brings. |

## Client (Expo SDK 58)

Versions are exactly those listed in `expo@58.0.14`'s `bundledNativeModules.json` (expo 58.0.15 was
published on 2026-10-19 and is not adopted the same day).

| Package | Version | Published | Licence |
|---|---|---|---|
| expo | 58.0.14 | 2026-10-16 | MIT |
| expo-router | 58.0.23 | 2026-10-16 | MIT |
| expo-font | 58.0.8 | 2026-10-13 | MIT |
| expo-clipboard | 58.0.3 | 2026-10-01 | MIT (S2.1 part 2, #230: the Scroll code block's Copy through `setStringAsync`, the async clipboard API on the web; the version in `bundledNativeModules.json`; peers `expo`, `react`, `react-native`; mocked in the UI package's tests) |
| react-native-gesture-handler | 3.3.0 | 2026-09-11 | MIT | S2.1 part 2b (#230): the Scroll slider and diagram token on native (`usePanGesture` with `runOnJS`, so callbacks run on the JS thread and need no Babel plugin or worklets; `GestureHandlerRootView` inside the article). The version in `bundledNativeModules.json` (`~3.3.0`); peers `react`, `react-native` only. The web uses pointer events instead (`.web` files). `react-native-reanimated` (4.7.1) and `react-native-worklets` (0.13.0) are the bundled versions but are **not** added: nothing in v1 animates on the UI thread, and Reanimated would bring a Babel plugin and the peers `@babel/core` and `@react-native/metro-config` under `strictPeerDependencies`. Jest resolves the library to a recording stand-in (`ui/src/test-support/gesture-handler.mock.tsx`) |
| expo-constants | 58.0.12 | 2026-10-14 | MIT |
| expo-linking | 58.0.13 | 2026-10-14 | MIT |
| expo-status-bar | 58.0.3 | 2026-10-01 | MIT |
| expo-secure-store | 58.0.2 | 2026-10-01 | MIT (S1.3, #226: the native bearer session in the platform keychain/keystore) |
| expo-crypto | 58.0.7 | 2026-10-16 | MIT (S1.3, #226: `randomUUID` for command IDs on native; the web uses `crypto.randomUUID`) |
| @expo/metro-runtime | 58.0.14 | 2026-10-09 | MIT |
| react, react-dom | 19.3.0 | 2026-09-09 | MIT (RN 0.88 bundles React 19.3.0; npm `latest` 19.3.1 is not used) |
| react-native | 0.88.0 | 2026-10-15 | MIT |
| react-native-web | 0.21.4 | 2026-10-08 | MIT |
| react-native-safe-area-context | 5.10.1 | 2026-09-29 | MIT |
| react-native-screens | 4.30.0 | 2026-10-13 | MIT |
| react-native-svg | 15.16.0 | 2026-10-15 | MIT (S1.4: icons, illustrations, pending stripe; the version in `bundledNativeModules.json`) |
| @types/react | 19.3.0 | 2026-09-09 | MIT |

Client data (S1.4, #227; not part of Expo's bundled modules):

| Package | Version | Published | Licence | Peer notes |
|---|---|---|---|---|
| @orpc/client, @orpc/openapi-client | 1.15.7 (lockstep with the server's oRPC) | 2026-10-14 | MIT | ES modules only: the client's Jest config sends `.mjs` through jest-expo's Babel transform |
| @tanstack/react-query | 5.104.4 | 2026-10-17 | MIT | react ^18‖^19, @types/react ^18‖^19; brings @tanstack/query-core 5.104.4 |

Client build (Babel for Metro; added by the native lane, #249; both already in the lockfile as transitive dependencies of `expo`):

| Package | Version | Published | Licence | Notes |
|---|---|---|---|---|
| babel-preset-expo | 58.0.18 | 2026-10-19 | MIT | The preset Expo uses without a config file; the exact version `expo@58.0.14` depends on. Named in `apps/client/babel.config.js` |
| @babel/plugin-transform-parameters | 7.29.7 | 2026-05-25 | MIT | Lowers rest parameters that are patterns. Hermes' compiler rejects `async (...[input, options = {}]) =>` (in `@orpc/client`), which Expo's Hermes profile leaves untouched, so the Android release build failed at `hermesc` |

| Client verification | Version | Published | Licence | Peer notes |
|---|---|---|---|---|
| jest | 30.5.2 | 2026-09-18 | MIT | jest-expo accepts ^29‖^30 |
| jest-expo | 58.0.11 | 2026-10-15 | MIT | needs @react-native/jest-preset ^0.88 |
| @react-native/jest-preset | 0.88.0 | 2026-10-15 | MIT | |
| @testing-library/react-native | 14.1.0 | 2026-10-08 | MIT | needs test-renderer ^1 (replaces react-test-renderer) |
| test-renderer | 1.3.0 | 2026-09-17 | MIT | the version jest-expo 58.0.11 depends on |
| @types/jest | 30.0.0 | 2025-06-16 | MIT | |
| @playwright/test | 1.64.1 | 2026-10-14 | Apache-2.0 | brings playwright and playwright-core 1.64.1; no install script runs (browsers are fetched only by `playwright install --with-deps chromium` in the `client` CI job, never on a developer machine) |
| @axe-core/playwright | 4.13.0 | 2026-08-11 | MPL-2.0 | peer playwright-core >= 1.0.0 (the 1.64.1 `@playwright/test` brings it); brings axe-core ~4.13; runs inside the Playwright web smoke only, nothing ships |

The client also takes `@types/node` (the root's 22.20.5) for its one Node-side test,
`features/shell/route-map.test.ts`, which references the types itself; the app's own
`tsconfig.json` keeps `types: ["jest"]`. `@knowscroll/ui` takes it for the same reason, one test
(`src/scroll/prepare.test.ts`, which scans the renderer's sources for the admission path).

Expo specifics: `web.output: "single"` (static SPA; SDK 58 defaults to `server`), `updates.enabled:
false` (no OTA updates yet). pnpm's default isolated `node_modules` works with SDK 58; no
`node-linker=hoisted` is needed.

## Native lane (`native.yml`, opt-in; D-019)

Related: #249.

The Android build and emulator lane (`engineering/native-lane.md`). It runs on a manual dispatch or on a pull request
labelled `run-native`, never as one of the six required `checks` jobs. Nothing here is a workspace dependency (no
`package.json` or catalog entry changes): these are CI tools, pinned in the workflow. Actions are pinned by commit SHA
with a version comment, as in `checks.yml`; Maestro and the Gradle distribution by SHA-256.

| Tool | Version | Pinned by | Published | Licence | Notes |
|---|---|---|---|---|---|
| actions/setup-java | v6.0.1 | commit `de7274f0` | 2026-09-09 | MIT | Temurin 17 (JDK 17 for AGP 9 and Maestro; the patch release floats) |
| android-actions/setup-android | v4.0.4 | commit `be39fa83` | 2026-09-17 | MIT | Command-line tools and SDK licences; the SDK itself is the runner image's |
| gradle/actions (setup-gradle) | v6.4.0 | commit `3f5f9ada` | 2026-09-28 | MIT (the action) | Gradle home cache and wrapper validation. **Its default "enhanced caching" is proprietary (Gradle Technologies Terms of Use); the workflow sets `cache-provider: basic`, the MIT implementation over actions/cache.** |
| reactivecircus/android-emulator-runner | v2.38.0 | commit `a421e438` | 2026-07-05 | Apache-2.0 | Installs the system image and emulator, boots the AVD, runs the script |
| actions/download-artifact | v8.0.1 | commit `3e5f45b2` | 2026-03-11 | MIT | Pairs with upload-artifact v7.0.1 (already pinned in `checks.yml`) |
| Maestro CLI | 2.11.0 | SHA-256 `5384593c…283a` of `maestro.zip` | 2026-09-29 | Apache-2.0 | The flows in `apps/client/maestro/`; analytics off (`MAESTRO_CLI_NO_ANALYTICS`) |
| Gradle (generated wrapper) | 9.4.1 | `distributionSha256Sum` `2ab2958f…c6cb`, added after prebuild | 2026-03-19 | Apache-2.0 | The version in the Expo SDK 58 template (`expo-template-bare-minimum` 58.0.23, inside `expo@58.0.14`); a different version fails the pin step |
| Android Gradle Plugin / compile SDK / build tools / NDK | 9.2.1 / 37 / 37.0.0 / 27.1.12297006 | React Native 0.88.0 `gradle/libs.versions.toml` | | Apache-2.0 | Not chosen here: they come with the pinned React Native; Gradle downloads the SDK components |
| Emulator image | API 35, `google_apis`, x86_64, `pixel_6` | the workflow's inputs to the runner action | | Android SDK terms | Image revision and emulator binary are sdkmanager's stable channel (not pinned) |

## What CI proves (checks.yml, every push and pull request)

| Job | Proves | Evidence label |
|---|---|---|
| `static` | `pnpm install --frozen-lockfile` resolves the whole matrix with `strictPeerDependencies`; Prettier, typed ESLint (no-floating-promises, no-misused-promises, await-thenable, consistent-type-imports, switch-exhaustiveness-check, no-explicit-any), `tsc` per package, dependency-cruiser boundaries plus the probe that every forbidden probe import is rejected, the workspace-dependency manifest check, knip, the squawk binary (`squawk --version`; S1.1 has no migrations to lint yet) | CI fixture (source) |
| `backend` | Vitest unit and property tests (canonical request hash, Save/Unsave rule, attempt state machine, UUIDv7, secret canary); real-PostgreSQL 16 integration tests, one template-derived database per file: migrator, pg-boss queues and drain, `withPersonalScope` refusals and the two-connection lock race, receipts (replay, key reuse, shared binding, rollback), relay (commit-only delivery, restart → resync), transaction network guard, erasure registry + schema inventory, applyAction (replay, 422, refusals, rollback removes the job), evidence consumer (crash after commit + pg-boss redelivery → one event), reasoning attempt ledger (crash after dispatch → `unknown`, never re-sent) | real database; fixture model |
| `build` | `nest build` (tsc) of API and worker; `pnpm deploy --prod` with injected workspace packages produces runnable `api/` and `worker/` trees whose installed versions match `pnpm-lock.yaml`; `kysely-codegen --verify` against the migrated schema; those trees run `dist/migrate.js` on an empty database (twice), serve `GET /health` in production mode through oRPC on Nest 12 + Express 5, answer RFC 9457 problems, refuse to start without release identity or with the test-only caller adapter in production, and stop with exit 0 on SIGTERM (worker drains). The S1.2 spike journey runs through them: `POST /v1/actions` (oRPC + `@orpc/nest` with a JSON body and request-derived caller) → personal-scope lock + receipt + saved item + pg-boss job in one Kysely transaction (`fromKysely`) → worker consumer → evidence + revision + `pg_notify` → LISTEN relay → Socket.IO `scope_changed` (Nest gateway on the Express server) → typed oRPC OpenAPI client `GET /v1/saved` | real database; accounts, universes, assets and caller tokens are CI fixtures |
| `client` | Vitest unit tests of `design-tokens` (contrast, spacing, breakpoints, type scaling, motion) and `client-core` (API origin, oRPC client and RFC 9457 problems over a labelled `fetch` double, query retry rules, `/health` query); jest-expo + React Native Testing Library tests of `ui` and of the app's route tree (`expo-router/testing-library`), and jest-expo/web (jsdom) tests of the `.web.ts` modules (links, ARIA semantics, focus ring, overlay history, page titles); `expo export --platform web` produces `apps/client/dist/index.html` with the bundled fonts, after `@knowscroll/contracts` is built; a gallery export (`EXPO_PUBLIC_KS_GALLERY=1`) carries the gallery marker and the production export does not; a Playwright smoke in Chromium over both exports (anchors with `href`, Tab + Enter between tabs, Ctrl/Cmd-click opens a new tab, per-route page titles, focus order at 834 and 1440 px, axe-core (`@axe-core/playwright`) over the main routes at 390, 834 and 1440 px failing on serious or critical violations, the desktop Reel card and thread aside, `/gallery` absent in production; the sheet closes on Esc and on browser Back with focus returned, the format switch's arrow keys, pressed toggles never yellow; the Scroll gallery `/gallery-scroll`: real headings, a disclosure and the code block by keyboard, Copy through the real clipboard, the readable fallback, the anchor restore, the reading events the article reports); jest-expo component tests of the Scroll renderer (`ui/src/scroll`) | CI fixture; static exports served locally, no API (`/health` answers 502) |

## Not proved by CI

- iOS builds of the Expo app. Android builds and the emulator run only in the opt-in native lane above (D-019 retired
  the "no CI mobile builds" rule, CF-31, for Android); `checks` itself still builds nothing native.
- Behaviour on the VPS (Node 22.23.3 there; CI uses 22.23.0): proved by dev deployment (S1.5).
- Long-running pg-boss maintenance, real traffic, and Socket.IO behaviour behind Caddy.
- Real authentication (S1.3), a real model provider (S2.2), Socket.IO revocation of existing
  subscriptions, and client-side catch-up (the client app does not call the API yet).

## Media dependencies

Related: S2.4, #233.

`expo-video` is pinned to **58.0.11** in the catalog and both client/UI manifests, from the installed
`expo@58.0.14/bundledNativeModules.json` range `~58.0.11` (MIT; Expo native peer SDK 58).
The web export compiles the real web adapter; native playback requires the opt-in Android lane.
Backend/build CI use the hosted runner's ffmpeg/ffprobe when present, otherwise install Ubuntu's
ffmpeg package without recommended extras within a ten-minute setup deadline. When the hosted
runner provides `/etc/apt/apt-mirrors.txt`, setup selects Ubuntu's official HTTPS archive, retaining
APT signature verification. Downloads have bounded retries/timeouts; any index failure is fatal.
Both executables report their versions before
the unchanged generated-MP4/import suites run; any setup failure fails the lane. Deployed import
requires `/usr/bin/ffprobe`. This binary is an OS tool, not a Node dependency. Vendored Cutroom schemas
are compiled by TypeScript at build, with `.ts` relative imports rewritten to `.js`, and exercised in
the installed release tree; their source SHA-256 pins remain unchanged.
