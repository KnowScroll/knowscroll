# infrastructure/erasure

The erasure registry (blueprint §5). Every module declares the personal data it holds, next to its
own code, and the backend composes those declarations into one list. Full erasure, selective Clear
and the schema inventory all read that list.

Status: implemented and covered by the integration tests against real PostgreSQL. Account
deletion and export read the same list (#246, D-043): implemented, and runtime-verified through the
installed API and worker in `tests/integration/release/account-http.test.ts`.

## What a module declares

Each module exports a `ModuleErasure` from `adapters/erasure.ts`, built with `declareErasure`:

| Field | Meaning |
|---|---|
| `tables` | Personal tables keyed by `universe_id`. Each references `identity.universes` with `ON DELETE RESTRICT`, so rows can only leave through an eraser. |
| `accountTables` | Account-keyed tables (identity's addresses, sign-in links, sessions; Social's friendships). Clear and reset keep them; account deletion removes them. |
| `accountColumns` | Account or person columns outside identity, such as `*_account_id` or `person_id`. Account deletion must handle each one. |
| `nonRowStores` | Personal stores SQL cannot see: job payloads (`pgboss/<queue>`), media, mail held by a provider. |
| `erase` | Full erasure of one universe, inside the locked personal scope. Idempotent. |
| `clearExploration` | What selective Clear does: a disposition per store (`erase`, `preserve`, `redact_accounting`, `external_retention`) and its own eraser. Saved items, friends, sign-in and financial records are kept. |
| `eraseAccount` | Account deletion only: removes the module's account-keyed rows and account links after every `erase` has run. Required when the module declares `accountTables`, or `accountColumns` outside its own `tables`. Idempotent. |
| `export` | What the person's export holds: `covers` (stores `read` reports on), `omits` (stores left out, each with its reason) and `read(scope, person)`, which returns bounded plain-JSON sections of the person's own records. Helpers: `exportReading` (one omit reason for the rest), `exportNothing`, `boundedSection`. |

`declareErasure` (`declaration.ts`) builds the declaration in one expression, so nothing is
assigned to it afterwards. The module writes its stores and `erase` as before, selective Clear as
`clear: { defaultDisposition?, dispositions?, erase }` and the export as
`export: (declaration) => exportNothing(declaration, reason)` (or `exportReading`). The helper gives
every declared store the default disposition unless the module names an exception, and builds the
export from the finished declaration so it can account for every declared store. With no
`defaultDisposition`, each store needs a named disposition and start-up refuses an unnamed one
(`CLEAR_DISPOSITION_MISSING`). A disposition for a store the module does not declare is kept, so
the same check refuses it.

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

## Account deletion and export

`accountLifecycleRegistry(modules)` runs at start-up in every process (`src/erasure-registry.ts`).
It refuses a module that holds account-keyed stores without an `eraseAccount`, a module without an
`export`, and an export that does not account for exactly the stores the module declares, so a new
store cannot be forgotten by either. `eraseAccountData(scope, registry)` runs every module's `erase`
and then every `eraseAccount` inside the deletion transaction, and `exportPersonalData` collects
each module's export section inside the person's locked scope. The export's `ExportPerson` carries `reach`, Content's
check of which assets the person may still read: a module that names content by title in the file asks it, so a
Scroll made for a thread the person left keeps no title there (the experience export lists it as "Withdrawn"). The use cases and their
lifecycles are in `modules/identity/README.md`.

Account deletion removes the personal roots last: a foreign key from any store the registry missed
makes the final `delete` fail and the transaction roll back, so a forgotten store stops deletion
loudly instead of leaving a person's rows behind an account that is gone.

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

Play (`play.calls`, `play.scroll_results`, `play.landmarks`, D-082, D-188) is universe-keyed: Clear and full erasure delete it, the export lists it in words, and no other module reads it (D-063).

Not in the registry: `identity.accounts` and `identity.universes` (the personal roots; account
deletion removes them after everything else) and shared tables. A shared table has none of the links above, and each
shared family keeps its own inventory and test that proves it: the Reel order stores
(`contentReelStores`) and the Region projection
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
