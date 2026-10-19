# infrastructure/erasure

The erasure registry (blueprint §5): every module declares its personal tables (`universe_id`
owner column), its non-row personal stores (job payloads, media, caches, exports) and an eraser.
The complete list is `src/erasure-registry.ts`.

| Operation | Purpose |
|---|---|
| `erasureRegistry(modules)` | Builds the registry; refuses a table or store declared twice. |
| `eraseUniverse(scope, registry)` | Runs every eraser for the scope's universe, in registry order, inside the locked personal scope. Each reports `completed`, `pending` or `failed` and is safe to retry. |
| `checkErasureInventory(db, registry)` | Schema inventory: every base table with a `universe_id` column is declared and every declared table has one; every declared table references `identity.universes` from `universe_id` with `ON DELETE RESTRICT`; every account-linked column (`account_id`, `*_account_id`) outside identity is declared by its module; every identity table other than the roots is declared as an account table (`accountTables`) and every declared one exists. CI runs it against the migrated schema. |
| `checkQueuePayloadStores(queues, registry)` | Every declared queue whose payload carries `universeId` is declared as the non-row store `pgboss/<queue>` with an eraser. CI runs it against `releaseQueues`. |

Account-keyed personal tables (identity's addresses, sign-in links and sessions, S1.3) are declared
as `accountTables`: clearing or resetting a universe leaves them (sign-in must keep working);
account deletion erases them. Not in the registry because they hold no personal rows of their own:
`identity.accounts` and `identity.universes` (the personal root; account deletion is its own
lifecycle, S1.x privacy work) and `content.assets` (shared content). The privacy operations that call `eraseUniverse` (clear
history, reset, delete account) and their epoch handling arrive with the privacy work; this
folder provides the registry and its checks.
