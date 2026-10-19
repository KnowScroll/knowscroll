# The v2 workspace

How the monorepo is laid out, built, checked and packaged. Architecture: blueprint §22–23.

## Packages

| Path | Package | Built by | Output |
|---|---|---|---|
| `apps/api` | `@knowscroll/api` | `nest build` (tsc) | `dist/main.js` (HTTP), `dist/migrate.js` (migrations + pg-boss install) |
| `apps/worker` | `@knowscroll/worker` | `nest build` (tsc) | `dist/main.js` (pg-boss consumers, no listener) |
| `apps/client` | `@knowscroll/client` | `expo export --platform web` | `dist/` static SPA (`web.output: "single"`) |
| `packages/contracts` | `@knowscroll/contracts` | tsc | `dist/` |
| `packages/backend` | `@knowscroll/backend` | tsc | `dist/` |
| `migrations` | `@knowscroll/migrations` | tsc | `dist/` + the reviewed `*.sql` files |
| `tests/integration` | `@knowscroll/integration-tests` | (not built) | real-PostgreSQL and release tests |

Packages are created only when code needs them; the blueprint's other packages (`client-core`,
`ui`, `scroll-model`, `scene-core`, `design-tokens` as a package) arrive with their first code.

## Sources inside the workspace, `dist/` outside it

Every library package's `exports` map has three conditions:

```json
"./infrastructure/config": {
  "@knowscroll/source": "./src/infrastructure/config/index.ts",
  "types": "./dist/infrastructure/config/index.d.ts",
  "default": "./dist/infrastructure/config/index.js"
}
```

- Type-checking (`tsconfig.base.json` and the client's tsconfig set `customConditions:
  ["@knowscroll/source"]`), Vitest (the `vitest.workspace-sources.ts` plugin, which applies in
  every Vite environment including global setup) and dependency-cruiser read the TypeScript
  sources, so editing a package never needs a rebuild before checking or testing a consumer.
- Builds (`tsconfig.build.json` clears `customConditions`) and Node at runtime read `types` /
  `default`, i.e. each package's own `dist/`. `pnpm -r build` builds in dependency order.

## Release trees (contract with the release tooling)

After `pnpm --filter '!@knowscroll/client' --filter '!@knowscroll/integration-tests' build`:

```sh
pnpm --config.inject-workspace-packages=true --filter @knowscroll/api deploy --prod <release>/api       # package.json, dist/main.js, dist/migrate.js, node_modules
pnpm --config.inject-workspace-packages=true --filter @knowscroll/worker deploy --prod <release>/worker # package.json, dist/main.js, node_modules
pnpm --filter @knowscroll/client build && cp -R apps/client/dist <release>/web
```

`pnpm deploy` copies each workspace dependency as it would be packed (its `files`: `dist`, and
for migrations the `*.sql` files) into `node_modules`, with production dependencies only and
relative symlinks, so the tree runs from any directory with `node dist/main.js`. With
`inject-workspace-packages=true` (passed on the command line only, so ordinary installs keep
linked workspace packages) it installs **from the shared lockfile** instead of re-resolving, as
`--legacy` does. Its `.pnpm` folder names for workspace packages embed a hash of the build
directory, so trees built in different checkouts differ in those names (never in versions). The
`build` CI job builds these trees, checks every installed version against `pnpm-lock.yaml`
(`release/lockfile.test.ts`) and boots them against PostgreSQL. `scripts/release/build.mjs`
uses the same command. Runtime variables:
`runtime-configuration.md`.

## Root scripts

| Script | Runs |
|---|---|
| `pnpm format` / `pnpm format:check` | Prettier over workspace code and config (`.prettierignore` limits it to what the workspace owns) |
| `pnpm lint` | ESLint with typescript-eslint type information, zero warnings |
| `pnpm typecheck` | `tsc` per package |
| `pnpm boundaries` | dependency-cruiser rules (`.dependency-cruiser.cjs`) |
| `pnpm boundaries:probe` | writes deliberately forbidden imports, checks each is rejected by the expected rule, removes them |
| `pnpm boundaries:manifests` | every `@knowscroll/*` import in production code is a declared `dependencies` entry |
| `pnpm knip` | unused files, exports, dependencies and catalog entries |
| `pnpm build` | every package's build |
| `pnpm test` | every package's tests; the integration package needs `KS_TEST_DATABASE_URL` |

Automated suites run in GitHub Actions, not locally (owner rule, D-010). Local runs are for
building and using the product by hand.

## Import boundaries (dependency-cruiser)

| Rule | Meaning |
|---|---|
| `domain-is-pure` | `domain/` imports its own domain, Zod and public ID types only |
| `application-allowlist` | `application/` imports only its own domain/application code and `events.ts`, any module's (or the reasoning engine's) `public.ts`, the observability types, wire contracts and Zod |
| `public-surface-is-framework-free` | `public.ts` and `events.ts` import no adapters, no Nest/Kysely/pg/pg-boss and no infrastructure except the pure queue declarations |
| `nest-providers-only-in-composition-roots` | only `apps/api/src/app.module.ts`, `apps/api/src/modules/*.ts`, `apps/worker/src/worker.module.ts`, `apps/worker/src/jobs.ts` (anchored) and integration tests import a module's `adapters/nest-providers.ts` |
| `apps-reach-modules-through-public-or-wiring` | apps use a module only through `public.ts` or (from a composition root) `nest-providers.ts` |
| `cross-module-through-public` | a module imports another module only through its `public.ts` |
| `infrastructure-below-modules` | infrastructure never imports modules (identity's public types excepted) or apps |
| `contracts-are-wire-only` | contracts import Zod, `@orpc/contract` and the `scroll-model`/`scene-core` sources they re-export |
| `clients-never-import-backend` | `apps/client` and the client packages (`client-core`, `ui`, `design-tokens`, `scroll-model`, `scene-core`) never import backend code, apps or migrations |
| `apps-never-import-each-other`, `packages-never-import-apps` | as named |
| `no-circular` | no import cycles |
| `no-generic-folders*` | no `shared/`, `utils/`, `lib/`, `common/`, `helpers/` package or folder, at the top level or below |
| `not-to-unresolvable`, `not-to-undeclared-dependency`, `production-code-not-to-dev-dependencies` | every import resolves to a declared dependency of the right kind |

The vendored Cutroom wire schema stays in the graph as a leaf (`doNotFollow`), so imports into it
are checked while its own imports are not.

## Typed lint

`eslint.config.js`: `typescript-eslint` `recommendedTypeChecked` plus `no-floating-promises`,
`no-misused-promises`, `await-thenable`, `consistent-type-imports`,
`switch-exhaustiveness-check` (a `default:` branch does not count as handling a union
member), `no-explicit-any`; every `eslint-disable` needs a `-- reason`
(`@eslint-community/eslint-comments/require-description`). With `experimentalDecorators` and
`emitDecoratorMetadata`, `consistent-type-imports` leaves decorated signatures alone, which keeps
Nest's metadata correct.
