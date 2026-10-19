# infrastructure/postgres

Owns: the `migrator` schema (`kysely_migration`, `kysely_migration_lock`, `migration_checksum`).

| Operation | Purpose |
|---|---|
| `createDatabase(settings, options)` | One process's pool and Kysely instance. Sets `application_name`, `statement_timeout` and `idle_in_transaction_session_timeout` on every connection. `close()` ends the pool once. |
| `migrateToLatest(db, registry)` | Applies pending migrations from the static registry (`migrations/`) inside Kysely's migration lock, as **one** transaction: a failure rolls back the whole batch (`failed`, nothing applied), so no migration may use non-transactional statements such as `CREATE INDEX CONCURRENTLY`. Forward-only. Refuses text that does not match its recorded SHA-256, an applied migration whose recorded checksum (`migrator.migration_checksum`) differs from the registry, and an applied migration missing from the registry. |
| `readLatestMigration(db)` | Newest applied migration name, or `none`. Used by `GET /health`. |

Conventions (blueprint §5): one PostgreSQL schema per backend module; explicit names (no
camel-case plugin); personal records keyed `(universe_id, id)` and referencing the personal root
with `ON DELETE RESTRICT`; bounded JSONB with `payload_version`.
