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

## Follow a request

The apps choose concrete dependencies; modules expose framework-free operations through
`public.ts`. For example, the API accepts an account deletion, Identity locks and fences the
account and queues work, and the worker calls the registry's erasers. Follow the
[Account walkthrough](src/modules/identity/README.md#account-deletion-d-043) for the complete path.

| Module | Owns | Start here |
| --- | --- | --- |
| Identity | Sign-in, sessions, personal authority, recording, Clear, deletion and export | [README](src/modules/identity/README.md) |
| Content | Admitted revisions, catalogue, library, media and production | [README](src/modules/content/README.md) |
| Experience | Offers, activated exposures, navigation, Keep and explicit actions including Not interested | [README](src/modules/experience/README.md) |
| Evidence | Intake and qualification of actual encounters | [README](src/modules/evidence/README.md) |
| Personal Context | Revisioned personal projections read by other modules | [README](src/modules/personal-context/README.md) |
| Composer | Ranking and prepared next-subject buffers | [README](src/modules/composer/README.md) |
| Planner | Background personal opportunities | [README](src/modules/planner/README.md) |
| Supply | Private requests, matching, production demand and answers | [README](src/modules/supply/README.md) |
| Geography | Established places and changes from qualified evidence | [README](src/modules/geography/README.md) |
| Scenes | Deterministic appearance and formation delivery | [README](src/modules/scenes/README.md) |
| Social | Friends, conversations, threads, sharing and visits | [README](src/modules/social/README.md) |
| Scenarios | What-if branches and alternative perspectives | [README](src/modules/scenarios/README.md) |
| Rooms | Membership, discussions, AI residents and room activities | [README](src/modules/rooms/README.md) |
| Play | Private call results, sparks and landmarks | [README](src/modules/play/README.md) |
| Feedback | Abuse reports and content-error reports | [README](src/modules/feedback/README.md) |
| Operator | Allowlisted diagnostic reads | [README](src/modules/operator/README.md) |

This is an ownership map of the current source, not a list of enabled features in a world.
Check [API wiring](../../apps/api/src/app.module.ts), [worker wiring](../../apps/worker/src/jobs.ts)
and [runtime configuration](../../docs/v2/engineering/runtime-configuration.md) for registration and
feature gates. Check [deployment evidence](../../docs/STATUS.md) before making a runtime claim.

## Focused checks

From the root, `pnpm --filter @knowscroll/backend exec vitest run src/modules/identity`
runs Identity's colocated unit tests. Replace the final directory to focus on another module.
`pnpm --filter @knowscroll/backend test` runs the whole package. Database and installed-release
checks belong to [integration tests](../../tests/integration/README.md) on disposable PostgreSQL.
Run `pnpm boundaries` after changing imports: another module's private adapter is not a shortcut
around its public port.

## Adding a personal store

1. Add its table to the module's migration, with a `universe_id` column that references `identity.universes` `ON DELETE RESTRICT`.
2. Declare it in the module's `adapters/erasure.ts`: table, owner column, and how full erasure and Clear treat it.
3. Say what the person's export does with it: add it to the `covers` of the module's `export` (and read it in `export.read`, own records only, readable fields, bounded), or to its `omits` with the reason. A store the export does not account for stops every process at start-up (`accountLifecycleRegistry`).
4. A table keyed by account (or linking to one) outside the module's own universe tables also needs the module's `eraseAccount`; account deletion removes it before the account.
5. A new module adds one line to the list in `src/erasure-registry.ts`.
6. Nothing else: no digest, no witness migration. The schema inventory test fails until the declaration exists, and the account-deletion test fails when no test fills the store.
