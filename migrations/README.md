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

0040 adds Social's account-lifetime current public roster index/heads and latest hash-only invite.
It backfills only existing explicit public sides and binds projection updates to the same pair transaction.
All earlier SQL remains immutable; schema40 requires compatible writers and no backward activation.

0041 is the Identity recording prerequisite: monotone on/generation fields on the existing root,
SQL transition guards and immutable exact-body account-lifetime recording_commands receipts.
Selective Clear preserves them. This schema does not activate Pause; every contribution owner
must carry and fence original generations before exposing a controller/control. All previous40
SQL files remain immutable. No new root, queue, provider/financial change or deletion executor.

0042 is the recording pipeline schema prerequisite. Eleven initially empty tables hold Experience
command/offer provenance and generation segments, Evidence recorder sessions/source heads/effective
credit, and PC source heads/effective structural and coverage contributions. Nine action-state
columns track independently eligible Save/Like decisions; three Evidence audit columns retain
literal generation 1 for historical rows. All new checks and foreign keys on existing tables are
`NOT VALID`; this migration does not scan or certify historical contributions.

Exact root, epoch, exposure, generation, action and activation bindings supplement the genuine
runtime recording transaction capability. Current-generation writes cannot alter sealed heads;
effective credit carries its previous committed value into an immutable generation baseline.
Activation time is a nullable, set-once pair so a correction-only segment creates no activation
fact. Eligible negative actions can correct earlier effective Save/Like credit through exact
original lineage. A NULL channel state remains uncertified: no legacy initialization, replay
backfill, event-cap reset or positive-growth certification is installed here.

Clear/full erasure must delete PC coverage references, effective contributions and segment heads
before Evidence heads/credit/sessions/audits, then Experience inputs/segments/origins before their
referenced offers, actions, exposures and receipts. Account-lifetime Identity recording policy and
receipts retain their existing lifecycle. Compatible owner adapters and deletion ordering must land
before rollout; stop unfenced older writers before election. This source prerequisite activates no
API, UI, worker role or provider operation. All previous 41 SQL files remain immutable.
