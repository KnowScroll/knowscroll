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
lifecycle, S1.x privacy work) and the shared content tables `content.assets`, `content.asset_revisions` and `content.asset_provenance`. The privacy operations that call `eraseUniverse` (clear
history, reset, delete account) and their epoch handling arrive with the privacy work; this
folder provides the registry and its checks.

Account-keyed lifetime tables may be declared by modules outside Identity. The inventory checks their actual base-table existence separately while retaining compulsory coverage of every Identity account table, personal universe FK and account-linked column. These declarations do not execute account deletion.

Cutroom's closed shared-public store manifests live with the Content and Reasoning adapters.
They are separate from personal eraser declarations because their actual ownership closure is
world/business/attempt/snapshot/shared asset, with no direct or transitive account/universe FK.
The real-schema fixture compares all19 actual Cutroom tables to both manifests, rejects personal
dependencies, and the populated full/selective fixture asserts unchanged new publication,
financial report, settlement, receipt and maintenance rows plus the existing world records and
pool history. Selective Saved preservation and unchanged full eraser semantics remain asserted.
These manifests are not a naming exemption: any future actual personal dependency requires a
matching ordinary registry/owner eraser entry. The public media and fixed IDs-only queue retention
is explicit in the non-row inventories. No new personal queue payload or provider data is retained.

CF62 adds the actual Content receiving root and immutable handoff/admission receipt to that
closed shared-public inventory (now19 Cutroom tables), plus target public media/staging and fixed
IDs-only queue retention. Both tables have genuine world/publication ownership and no direct or
transitive personal FK. The populated receiving fixture asserts byte-identical shared rows/media
through full erasure and selective Clear while preserving exact Saved UUID/ref/fractional places.
The schema inventory still discovers actual tables, so omitting a declaration fails rather than
creating an exemption by name. No new personal payload, provider output or erasure waiver is added.

## Current recording lifecycle closure

The fixed backend eraseCurrentExploration runner closes over the actual imported frozen owner
callbacks and current canonical literal registry/writer protocol v1 (SHA256 ebbec3bda043ab47c5566ebb29e80322e841f4dc15ef7940fc2ee4c053176dc1).
Generic clearExplorationRegistry/eraseExploration retains basic verification but cannot issue the
separate live current-registry proof required for lifecycle READY. No caller supplies a digest,
version flag, replacement registry or successful callback to that runner. The lifetime proof is
removed with its ClearCoreTx. Actual core completion installs READY before barrier release,
independently of subsequent financial settlement.

Experience deletes channel certificates before actions/segments; Identity, last, removes the
prior lifecycle witness before installing the current one. Full erasure removes it permanently
until a separately authorized actual lifecycle transition. The witness is declared for both
universe and account ownership. Registry deduplication permits that same-owner cross-kind
declaration while still rejecting same-kind duplicates, duplicate owners and cross-owner stores.
This is not an account-deletion executor or a mixed-version aggregate-write sandbox.

Planner and Geography each declare runs.recording_account_id as an actual account-linked column. Their selective disposition erases the owning run row, including that link; no financial identity is nulled or reset. The pending0044 fixed protocol digest changes because the previous unaccepted c21 literal omitted these schema links. Old failed source/evidence is retained, with no generic hash compatibility or future Conversations extension elected.
