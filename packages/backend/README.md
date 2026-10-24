# @knowscroll/backend

Framework-free backend code used by `apps/api` and `apps/worker` (blueprint §22):

```text
src/
  infrastructure/   Adapters for PostgreSQL, pg-boss, diagnostics, configuration and process lifecycle
  modules/          Business modules (onion layout: domain/ → application/ → adapters/)
  reasoning/        Shared model-execution engine (attempt ledger); owns no role
```

Each infrastructure folder and module has its own README. The package exposes explicit entry
points only (`package.json` `exports`); there is no barrel of everything.

| Entry point | Purpose |
|---|---|
| `@knowscroll/backend/infrastructure/config` | Validated process configuration (`readApiConfig`, `readWorkerConfig`, `readMigrateConfig`) |
| `@knowscroll/backend/infrastructure/postgres` | Pool + Kysely factory, Kysely migrator over the static registry |
| `@knowscroll/backend/infrastructure/jobs` | pg-boss: queue declarations, install/producer/consumer instances, consumers and drain |
| `@knowscroll/backend/infrastructure/observability` | `logEvent` catalogue → Pino, sanitisation, framework log adapter |
| `@knowscroll/backend/infrastructure/lifecycle` | `runProcess`: start once, stop once on SIGTERM/SIGINT, exit codes |

No file in this package imports `@nestjs/*`. Composition (which adapter implements which port)
happens only in the apps' composition roots.

The folder `src/modules/content/adapters/cutroom/wire-v1/` is a byte-for-byte vendored copy of
Cutroom's wire schema (CF-61). It is excluded from type-checking, linting, formatting, knip and
dependency-cruiser, and its hashes are verified by the `integrity` CI job. Do not edit it.

Tests: unit tests sit next to the code (`*.test.ts`, Vitest); real-PostgreSQL tests live in
`tests/integration/`.

Personal Planner (`modules/planner`, #236) owns backend-only coalesced role work and accepted future
opportunities. Its execution gate defaults off; see its README for bounded prepared context,
transactional triggers, explicit same-run resume, erasure and the separate paid-allowance requirement.

Supply (`modules/supply`, #239) owns private requests, immutable receipts, current status and
waiter cancellation plus an actual bounded IDs-only resolver. Canonical matching work contains
only admitted public catalogue/lineage facts. No HTTP route or paid production bridge is installed;
see its README for current Content fencing, erasure and remaining runtime acceptance.

Geography (`modules/geography`, #237) consumes current trusted PC coverage to validate bounded
Cartographer proposals and commit stable meaning/deltas. Its independent feature flag defaults off
and economic permit defaults false. Public own-universe/delta reads have no HTTP/scene consumer;
CI formation fixtures are distinct from actual reading/provider/dev acceptance.

Scenes (`modules/scenes`, #238) derives persisted bounded appearance from Geography's public
same-scope input. Required apply jobs are atomic with Geography; immutable chunk/manifest
versions and stable descriptor allocation back readonly backend ports. No HTTP, renderer,
bootstrap, model work or formation acknowledgement is installed by this prerequisite.

Social exposes backend-only explicit profile/handle and Friends pair operations through its public ports. The source slice mounts no HTTP or worker producer, lists, invitations, visibility, visitor publication or presence. See `src/modules/social/README.md` for per-caller public revisions, private pair serialization and erasure limits.

## Adding a personal store

1. Add its table to the module's migration, with a `universe_id` column that references `identity.universes` `ON DELETE RESTRICT`.
2. Declare it in the module's `adapters/erasure.ts`: table, owner column, and how full erasure and Clear treat it.
3. A new module adds one line to the list in `src/erasure-registry.ts`.
4. Nothing else: no digest, no witness migration. The schema inventory test fails until the declaration exists.
