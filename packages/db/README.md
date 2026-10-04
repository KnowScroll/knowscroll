# @knowscroll/db

Persistence for the whole backend: the migrations, the connection pool, and every SQL statement.
Domain functions here are transaction scripts. A function either takes the caller's `client`
(and its JSDoc says which transaction and which locks it expects) or owns its transaction through
the pool. Ledger rows are source events; Accounts and Trace are rebuildable projections.

## Entry points

- `src/index.ts` is the package root (`@knowscroll/db`): `connection.ts` (the pool, `transaction`,
  `lockUniverse`, `OWNER_ID`), `identity.ts` (device sessions, `authenticateAndLock`) and
  `privacy.ts` (Clear, pause, export, Reset, account deletion).
- Everything else is imported by subpath with no extension, for example
  `@knowscroll/db/feed`, `@knowscroll/db/reasoning/admission`, `@knowscroll/db/projection/keep`.
- `migrations/` holds the numbered SQL migrations (`0001_bootstrap.sql` onward);
  `src/migrations.ts` applies them.
- Folders: `atlas/`, `composer/`, `generation/`, `inventory/`, `projection/`, `publication/`,
  `reasoning/` (admission, answers, fairness, inquiries, storage, `worker-reads.ts`), `semantic/`,
  `shared/`, `sql/` (`queryable.ts`, `transactions.ts`, `recording-paused.ts`).

## Rules a contributor must not break

- SQL lives only here. API routes and worker loops call db functions; `pnpm lint` runs
  `scripts/check-architecture.mjs`, which fails on any `.query(` under `apps/`
  ([ADR-0048](../../docs/decisions/0048-backend-module-boundaries.md)).
- SQL text is observable behavior: tests match live statements in `pg_stat_activity`. Those
  statements are pinned in `TEXT_OBSERVED_BY_TESTS` in `scripts/format-query-sql.mjs`; never
  reformat or reword them.
- Lock order is universe first, then session, Job, children, fairness, bucket. A reader's
  authenticated transaction already holds the universe lock (`authenticateAndLock`).
- Append numbered migrations; never rewrite an applied one ([AGENTS.md](AGENTS.md)).
- Stored hashes depend on exact bytes: the insertion-order `JSON.stringify` in
  `reasoning/storage.ts` and `reasoning/runtime-policy.ts`, token hashing in `shared/token-hash.ts`.
  Do not switch them to the sorted-key serializer in `@knowscroll/core/shared/canonical-json`.
- Refusals: throw a domain error carrying `statusCode` when the refusal is HTTP-visible, or return a
  `{ kind }` union where callers branch. The API maps both in one place.
- Imports no `fastify` or provider SDK. Conventions: "Code conventions" in
  [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Where to start reading

1. [AGENTS.md](AGENTS.md) and ADR-0048.
2. `src/connection.ts`: the pool, `.env` loading and the two locks every transaction starts from.
3. `src/identity.ts`: sessions and `authenticateAndLock`.
4. `src/feed.ts`, then `src/projection/keep.ts`: a read and a projection transaction.
5. `src/privacy.ts`: statement order and lock order that are load-bearing.
6. `src/reasoning/admission.ts`: the largest transaction script; its helpers are in `admission/`.

Dependency graph: [docs/architecture/module-map.md](../../docs/architecture/module-map.md).
Moved files, including the SQL that left the apps: [docs/architecture/moved-paths.md](../../docs/architecture/moved-paths.md).
