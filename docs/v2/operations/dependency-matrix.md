# Dependency matrix

The exact versions the v2 workspace runs on, why each was chosen, and what CI proves about them.
Versions are pinned **exactly** in the `catalog:` of `pnpm-workspace.yaml` (`catalogMode:
strict`, `savePrefix: ''`, `strictPeerDependencies: true`) and in `pnpm-lock.yaml`. Change a
version only together with this file.

Recorded 2026-10-19 (S1.1, #224). Registry facts (versions, dates, licences, peers) were read from
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
| PostgreSQL | 16 (CI `postgres:16` service; production major) | `checks.yml` | Production major on the VPS. pg-boss needs ≥13. The CI log prints the exact server version. |

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
| express | 5.2.1 | 2025-12-01 | MIT | The exact version platform-express 12.1.3 depends on (one copy in the tree). |
| @types/express | 5.0.6 | 2025-12-01 | MIT | Types for the Express request/response objects used by the API's middleware. |
| reflect-metadata | 0.2.2 | 2024-03-29 | Apache-2.0 | |
| rxjs | 7.8.2 | 2025-02-22 | Apache-2.0 | |
| @orpc/contract, @orpc/server, @orpc/nest, @orpc/openapi, @orpc/zod | 1.15.7 (lockstep) | 2026-10-14 | MIT | @orpc/nest peers `@nestjs/* >=11`, `express >=5`. oRPC's 1.x CI tests Nest 11 only; Nest 12 compatibility is proven by this workspace's CI (below). |
| zod | 4.6.7 | 2026-10-12 | MIT | @orpc/zod needs >=3.25. |
| kysely | 0.29.7 | 2026-10-17 | MIT | `Migrator` moved to `kysely/migration` in 0.29. |
| pg | 8.23.1 | 2026-09-30 | MIT | pg-boss depends on ^8.23.1 (one copy). |
| @types/pg | 8.23.1 | 2026-08-17 | MIT | |
| pg-boss | 12.38.0 | 2026-10-13 | MIT | ESM; `fromKysely` from the package root; Node ≥22.12; PostgreSQL ≥13. |
| pino | 10.4.0 | 2026-10-02 | MIT | Written to only through `logEvent`. |

## Backend verification

| Package | Version | Published | Licence | Notes |
|---|---|---|---|---|
| vitest | 4.1.12 | 2026-10-15 | MIT | Nest 12's template line (vitest 5 is newer but not needed). Resolves workspace sources through the `@knowscroll/source` condition. |

## Client (Expo SDK 58)

Versions are exactly those listed in `expo@58.0.14`'s `bundledNativeModules.json` (expo 58.0.15 was
published on 2026-10-19 and is not adopted the same day).

| Package | Version | Published | Licence |
|---|---|---|---|
| expo | 58.0.14 | 2026-10-16 | MIT |
| expo-router | 58.0.23 | 2026-10-16 | MIT |
| expo-font | 58.0.8 | 2026-10-13 | MIT |
| expo-constants | 58.0.12 | 2026-10-14 | MIT |
| expo-linking | 58.0.13 | 2026-10-14 | MIT |
| expo-status-bar | 58.0.3 | 2026-10-01 | MIT |
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

| Client verification | Version | Published | Licence | Peer notes |
|---|---|---|---|---|
| jest | 30.5.2 | 2026-09-18 | MIT | jest-expo accepts ^29‖^30 |
| jest-expo | 58.0.11 | 2026-10-15 | MIT | needs @react-native/jest-preset ^0.88 |
| @react-native/jest-preset | 0.88.0 | 2026-10-15 | MIT | |
| @testing-library/react-native | 14.1.0 | 2026-10-08 | MIT | needs test-renderer ^1 (replaces react-test-renderer) |
| test-renderer | 1.3.0 | 2026-09-17 | MIT | the version jest-expo 58.0.11 depends on |
| @types/jest | 30.0.0 | 2025-06-16 | MIT | |

Expo specifics: `web.output: "single"` (static SPA; SDK 58 defaults to `server`), `updates.enabled:
false` (no OTA updates yet). pnpm's default isolated `node_modules` works with SDK 58; no
`node-linker=hoisted` is needed.

## What CI proves (checks.yml, every push and pull request)

| Job | Proves | Evidence label |
|---|---|---|
| `static` | `pnpm install --frozen-lockfile` resolves the whole matrix with `strictPeerDependencies`; Prettier, typed ESLint (no-floating-promises, no-misused-promises, await-thenable, consistent-type-imports, switch-exhaustiveness-check, no-explicit-any), `tsc` per package, dependency-cruiser boundaries plus the probe that every forbidden probe import is rejected, the workspace-dependency manifest check, knip, the squawk binary (`squawk --version`; S1.1 has no migrations to lint yet) | CI fixture (source) |
| `backend` | Vitest unit tests; real-PostgreSQL 16 integration tests (migrator, pg-boss queue declarations, consumer drain), one template-derived database per file | real database |
| `build` | `nest build` (tsc) of API and worker; `pnpm deploy --prod` with injected workspace packages produces runnable `api/` and `worker/` trees whose installed versions match `pnpm-lock.yaml`; those trees run `dist/migrate.js` on an empty database (twice), serve `GET /health` in production mode through oRPC on Nest 12 + Express 5, answer RFC 9457 problems, refuse to start without release identity, and stop with exit 0 on SIGTERM (worker drains) | real database, CI fixture (commit/artifact values) |
| `client` | Vitest unit tests of `design-tokens` (contrast, spacing, breakpoints, type scaling, motion) and `client-core` (API origin, oRPC client and RFC 9457 problems over a labelled `fetch` double, query retry rules, `/health` query); jest-expo + React Native Testing Library tests of `ui` and of the app's route tree (`expo-router/testing-library`); `expo export --platform web` produces `apps/client/dist/index.html` with the bundled fonts, after `@knowscroll/contracts` is built; the production export contains no developer gallery | CI fixture |

## Not proved by CI

- Native Android/iOS builds of the Expo app (no CI mobile builds; owner decision CF-31).
- Behaviour on the VPS (Node 22.23.3 there; CI uses 22.23.0): proved by dev deployment (S1.5).
- Long-running pg-boss maintenance, real traffic, and Socket.IO behaviour behind Caddy.
