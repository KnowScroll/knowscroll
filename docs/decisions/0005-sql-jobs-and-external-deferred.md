# ADR-0005 — SQL work admission and separate paid execution protocol

Date: 2026-09-15. Status: accepted under the owner’s delegated bootstrap authority.

## Context

Current jobs only project an explicit keep. Later reasoning/video jobs perform costly external work and have different failure boundaries.

## Decision

For short deterministic work: select a ready job with row locking and SKIP LOCKED, apply Accounts/Trace, mark completed and commit in one transaction. A database connection loss rolls back the transaction and releases the lock. This is a transaction lock, not a time-based lease. Keep the API admission event/job atomic. Failed projections have bounded retries and an inspectable failed state.

## Alternatives and why

A separate broker adds another admission consistency problem without helping this short path. Holding a database transaction across a long provider call is rejected. Temporal or a broker may become appropriate after measured operational need.

## Consequences

The target paid path must persist Job → Step → Attempt, dispatch intent, reservation, deadline and lease/fence before an external attempt. Reconcile ambiguous results by provider request identity where supported; record late usage even when stale output cannot apply. A paid retry is a new Attempt, not an invisible SDK retry or an attempts counter alone. No distributed transaction or exactly-once remote execution is promised. The bootstrap has no paid dispatcher.

## Sources and verification

Implementation update (2026-09-16): select while locking only the owning universe with `FOR UPDATE OF u SKIP LOCKED`, then re-read/lock its job. Failure settlement uses the same universe-before-job order. Epoch mismatch discards work; a missing candidate after privacy clear does no work. ADR-0009/0010 govern these gates. This remains a deterministic database transaction, not a provider lease protocol.

[PostgreSQL SKIP LOCKED](https://www.postgresql.org/docs/16/sql-select.html), [target global execution](../architecture/target/22-GLOBAL-EXECUTION.md), [current projector](../../apps/worker/src/project.ts).

Design update (2026-09-16): [ADR-0012](0012-reasoning-admission-and-reconciliation.md) accepts the separate reasoning record family, atomic reservations, consumed-once dispatch intent and restricted late-usage reconciliation. Strict metadata contracts exist; the SQL reasoning runtime and product dispatcher remain unimplemented.
