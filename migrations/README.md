# @knowscroll/migrations

Reviewed raw-SQL migrations and their static registry (blueprint §5).

- One file per migration: `NNNN_purpose.sql` in this folder.
- `src/registry.ts` lists every file once, in apply order, with the SHA-256 of its reviewed text.
  `src/registry.test.ts` fails when the folder and registry disagree or a reviewed file changed.
- Applied by `node dist/migrate.js` in the API release tree (`@knowscroll/backend`'s
  `migrateToLatest`), forward-only, inside Kysely's migration lock. Never edit or delete a migration
  that reached a shared database; write a new one.
- `pnpm --filter @knowscroll/migrations lint:sql` runs squawk (PostgreSQL 16 rules) in CI.

Each migration's header comment states: owner module, authoritative/derived role, main query
shapes, indexes/constraints, expected growth, retention, correction/erasure, and rollout
behaviour for older processes (blueprint §23 pattern 5).
