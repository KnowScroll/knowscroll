# infrastructure/erasure

The erasure registry (blueprint §5): every module declares its personal tables (`universe_id`
owner column), its non-row personal stores (job payloads, media, caches, exports) and an eraser.
The complete list is `src/erasure-registry.ts`.

| Operation | Purpose |
|---|---|
| `erasureRegistry(modules)` | Builds the registry; refuses a table or store declared twice. |
| `eraseUniverse(scope, registry)` | Runs every eraser for the scope's universe, in registry order, inside the locked personal scope. Each reports `completed`, `pending` or `failed` and is safe to retry. |
| `checkErasureInventory(db, registry)` | Schema inventory: every base table with a `universe_id` column must be declared, and every declared table must have one. CI runs it against the migrated schema. |

Not in the registry because they hold no per-universe rows: `identity.accounts` and
`identity.universes` (the personal root; account deletion is its own lifecycle, S1.x privacy work)
and `content.assets` (shared content). The privacy operations that call `eraseUniverse` (clear
history, reset, delete account) and their epoch handling arrive with the privacy work; this
folder provides the registry and its checks.
