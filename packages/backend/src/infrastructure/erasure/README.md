# infrastructure/erasure

The erasure registry (blueprint §5). Every module declares the personal data it holds, next to its
own code, and the backend composes those declarations into one list. Full erasure, selective Clear
and the schema inventory all read that list.

Status: implemented and covered by the integration tests against real PostgreSQL. Account
deletion itself is not built; the registry only declares what it will have to remove.

## What a module declares

Each module exports a `ModuleErasure` from `adapters/erasure.ts`:

| Field | Meaning |
|---|---|
| `tables` | Personal tables keyed by `universe_id`. Each references `identity.universes` with `ON DELETE RESTRICT`, so rows can only leave through an eraser. |
| `accountTables` | Account-keyed tables (identity's addresses, sign-in links, sessions; Social's friendships). Clear and reset keep them; account deletion removes them. |
| `accountColumns` | Account or person columns outside identity, such as `*_account_id` or `person_id`. Account deletion must handle each one. |
| `nonRowStores` | Personal stores SQL cannot see: job payloads (`pgboss/<queue>`), media, mail held by a provider. |
| `erase` | Full erasure of one universe, inside the locked personal scope. Idempotent. |
| `clearExploration` | What selective Clear does: a disposition per store (`erase`, `preserve`, `redact_accounting`, `external_retention`) and its own eraser. Saved items, friends, sign-in and financial records are kept. |

## How the registry is built

`src/erasure-registry.ts` is a plain list of the modules' declarations, in eraser order (rows that
reference others first, identity last). It exports:

- `personalStores`: the list for full erasure and the inventory.
- `explorationStores`: the same list checked for a disposition on every store.
- `eraseCurrentExploration(scope)`: runs selective Clear's erasers over that list inside the Clear
  core transaction, then records that the real registry did it. Identity installs the new
  recording witness only on that proof, so a test registry cannot mark a Clear as verified.

`erasureRegistry` refuses a table, store or module declared twice. `eraseUniverse` runs the
erasers in order. `eraseExploration` first re-runs the schema inventory inside the Clear
transaction and refuses to erase anything if it finds a problem, then runs every owner's Clear
eraser and requires each to report `completed`.

## Completeness is proved against the schema

`checkErasureInventory(db, registry)` reads the migrated database and returns every problem. CI
runs it, and every Clear runs it again. It fails when:

- a table with a `universe_id` column is not declared, or a declared table lacks the column or the
  `ON DELETE RESTRICT` reference to `identity.universes`;
- a column named `account_id`, `person_id`, `owner_id`, `member_id`, `*_universe_id`,
  `*_account_id` or `*_person_id`, or any column with a foreign key to `identity.accounts` or
  `identity.universes`, outside identity is not declared as an account column (and the reverse: a
  declared column that does not exist);
- an identity table other than `accounts` and `universes` is not declared as an account table;
- another table reaches a personal root through foreign keys and is declared nowhere. A child
  table of a personal table therefore needs its own `universe_id`.

`checkQueuePayloadStores(queues, registry)` fails when a queue whose payload carries `universeId`
has no `pgboss/<queue>` store declared.

Not in the registry: `identity.accounts` and `identity.universes` (the personal roots; account
deletion is their lifecycle) and shared tables. A shared table has none of the links above, and each
shared family keeps its own inventory and test that proves it: the Cutroom stores
(`contentCutroomStores`, `reasoningCutroomStores`) and the Region projection
(`contentRegionStores`) survive both erasers by design.

## Recording witness

The recording lifecycle witness (Pause and Resume, #388) records that a root elected the lifecycle
for its current epoch. It holds the epoch, account and origin (birth or Clear), and no registry
digest. Adding a personal store changes only that module's declaration and its migration. The
history is in `docs/v2/decisions.md` (D-050).

## Failure and recovery

Erasers are idempotent, so a failed Clear or erasure is retried. A Clear that finds an undeclared
personal table, or an eraser that does not report `completed`, rolls back before the barrier is
released. Queue payloads are erased by the owning module's eraser (`deleteJobPayloads`,
`deleteClearJobPayloads`); a job already claimed rechecks authority itself before any effect.
