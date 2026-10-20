# Supply / Quartermaster — bounded backend foundation (#239)

This module accepts deliberate private topic/variant requests, reuses current admitted inventory,
coalesces compatible missing supply under one active public key, and resolves each private waiter.
It has no HTTP route, request UI, producer/provider bridge or paid allowance. #239 remains open.
The existing Scroll operator is not a Supply commissioning capability and is never called here.

## Public use cases

`CreateRequest`, `ReadRequest`, `CancelRequest` and `ResolveRequest` are framework-free public
ports; composition binds their tokens through `supplyProviders`. API wiring installs use cases
without exposing a route. Worker wiring registers the actual `supply.resolve-request` consumer.
The merged declaration-only `contracts/supply` schemas define the accepted wire semantics.

Creation validates the wire input, enters `withPersonalScope`, checks the immutable receipt key,
validates any exact owned activated source plus optional latest Composer session, then rechecks
current Content after the sorted SHARE-lock wait. Retryable stale/source/authority refusals write
no receipt. A fresh accepted demand, immutable acceptance receipt, personal revision and any
required pg-boss work commit together. Identical replay keeps the original request ID, timestamp,
epoch and watermark; only `replayed` changes. Different operation/input conflicts. Current scope
is checked before every replay, so prior-epoch receipts cannot disclose private outcomes.

A source's optional session fences the deliberate submission, including after waiting. Subsequent
ordinary navigation does not revoke an already accepted request. Resolution independently checks
the current epoch, owning account active status, owned activated exact source and Content rights/head/capabilities; it does not
borrow HTTP guards or infer the newest exposure. Account status is checked before/after Content
waits through Identity's scoped read, preserving the system actor and existing root-before-status
protocol. Session/device sign-out does not cancel an already accepted demand. None of these references creates consumption.

## Deterministic matching and honest limits

Only exact `content-concepts.v1` catalogue membership (and exact optional facet membership) or a
current admitted public explanation lineage admits a canonical brief. Catalogue reuse requires
an admitted primary topic and optional facet, exact language and requested format. Variant reuse
reads actual Content siblings, matches the same explanation, and requires the other format.
All candidates are exact current admitted revisions, negotiated for supplied client capabilities.
The current canonical production policy admits English (`en`) only; arbitrary language strings
never enter a shared brief. Other language requests close as unsupported until an explicit policy
adds their canonical meanings/production capabilities.
The current Content model grants shared admitted access; the brief's fixed `shared_admitted`
rights class does not invent private-content rights or authorize a different future rights class.

The public key hashes only this code-admitted brief: catalogue version/reference or public exact
explanation/source lineage, format, language, fixed rights and policy version. There is no inferred
angle/depth/freshness/continuity equivalence. A contextual catalogue ask needs a future admitted
semantic brief; freeform text, contextual asks and unsupported catalogue/variant meanings are
accepted as durable `unavailable/unsupported_request`, with no shared key or queued work. Their
text/context remains only in the private row. Series/related future slots are unsupported.

Compatible current content is immediately ready, with no resolver job. Otherwise a unique partial
index atomically joins/creates one active canonical matching group, and each private waiter gets
its own transactionally committed resolver job. `create` here means a matching group, never a paid
production run. Its current `preparing/phase:requested` status names this real bounded resolver,
not generation progress. The resolver retries current inventory and either binds real admitted
content or closes `unavailable/budget_unavailable`: no Supply commissioning allowance/bridge exists.
This reason records the actual admission barrier; it is not an assertion that a provider failed.
No percentages, ETA, model call, attempt ledger entry or claimed paid work is manufactured.

Cancellation changes only an open owned waiter. Ready/unavailable are `already_closed`; repeated
cancellation is `already_cancelled`. A cancel receipt replays its original result. Cancellation
never deletes admitted content, mutates another waiter, recalls a dispatched attempt or promises
a refund. Closed requests never rebind or restart. A new deliberate request is a new command.

## Persistence, revision and locking

| Store | Role / query / growth | Retention and erasure |
|---|---|---|
| `supply.requests` | Private demand and waiter in one bounded row; exact `(universe_id,id)` and owner/epoch/recent index. Stores validated command, decision, group link and one immutable ready binding. | Full personal erasure removes every epoch; no surviving private context in public work. |
| `supply.work` | Public canonical matching group; SHA-256 key, bounded brief, unique active-key index. No owner, context, prompt, ledger or second outbox. One group per admitted missing key while active. | Independently public metadata survives erasure; cancellation does not control shared work. Resolver closes its group; other waiters resolve through their own jobs. |
| `pgboss/supply.resolve-request` | v1 owner/epoch/request IDs only; 180s expiry, three 10s backoff retries, local concurrency 1, 7d waiting retention, 2d settled retention and declared dead letter. | Eraser removes queued, active, settled and dead-letter payloads for the owner. pg-boss is the only work outbox. |

Lock order: personal root → owned demand → all required Content asset SHARE locks in canonical
UUID order → matching group unique-key/row lock. A resolver handles one recipient per transaction;
it never holds shared work while acquiring another personal root. Content admission never calls
back into personal scopes. No provider/network wait occurs in a transaction or HTTP path.

`0024` also adds Content-owned `availability_revision` / `availability_changed_at`. Current asset
revision alone cannot order withdrawal and re-admission of the same immutable bytes. A narrow
trigger increases the integer counter only when admission status/current revision changes,
ignores manual counter/timestamp edits otherwise, and fails closed on integer overflow. All old
SQL bytes and legacy opening/historical exact-read semantics remain unchanged.

Status is read-only: no mutation, queue or attempt. For an open/ready request it rechecks current
source/target heads under SHARE. Its revision is stored request revision plus monotonic Content
availability deltas from its one-time binding. Withdrawal invalidates ready; re-admission may
restore the exact same binding at a higher revision. A terminal resolver/cancel freezes at the
latest derived revision + 1 and never resumes/rebinds, so later reads cannot regress. Arithmetic
must remain a positive safe integer. A read returns the current personal catch-up watermark;
global Content changes do not increment that personal watermark or emit a personal hint. Consumers
must poll/refetch/reconnect and fence snapshots by request revision as well as AccountScope.
Ready contains allowlisted metadata only; explicit later open/activation still grants rendering.

## Verification and outstanding acceptance

`tests/integration/modules/supply.test.ts` supplies authored CI content only and exercises real
PostgreSQL/pg-boss: concurrent unique keys/replays, waiter privacy/cancel, unsupported private asks,
atomic rollback, current eligibility/withdrawal/re-admission ordering, worker epoch/revocation,
erasure and no paid attempt. The existing strict erasure inventory fixture is extended without
weakening any assertion. Automated suites run in GitHub Actions only. Fresh SSD schema codegen,
local type/lint/build checks and CI fixtures are separate from runtime/provider acceptance.

Remaining: shared route declaration then HTTP consumer, E04 ask/E07 request UI and list/retry
contracts, approved commissioning/budget/attempt-ledger bridge, Content-owned future continuation
slots, and actual missing-format → real production → ready → explicit read acceptance on dev.
No provider grant, #232 allowance, Cutroom script/spend or live deployment is changed here.
