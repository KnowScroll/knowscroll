# infrastructure/postgres

Owns: the `migrator` schema (`kysely_migration`, `kysely_migration_lock`).

| Operation | Purpose |
|---|---|
| `createDatabase(settings, options)` | One process's pool and Kysely instance. Sets `application_name`, `statement_timeout` and `idle_in_transaction_session_timeout` on every connection. `close()` ends the pool once. |
| `migrateToLatest(db, registry)` | Applies pending migrations from the static registry (`migrations/`) inside Kysely's migration lock. Forward-only; a failure rolls back and names the failed migration; an applied migration missing from the registry fails the run. |
| `readLatestMigration(db)` | Newest applied migration name, or `none`. Used by `GET /health`. |

Conventions (blueprint §5): one PostgreSQL schema per backend module; explicit names (no
camel-case plugin); personal records keyed `(universe_id, id)` and referencing the personal root
with `ON DELETE RESTRICT`; bounded JSONB with `payload_version`.
