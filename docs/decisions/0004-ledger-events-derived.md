# ADR-0004 — Canonical history with derived state and exposure lineage

Date: 2026-09-15. Status: accepted under the owner’s delegated bootstrap authority.

## Context

The system needs to know what actually happened and which recommendation caused the opportunity. A watch is not proof of interest or learning. User privacy must remain possible even with durable history.

## Decision

Use PostgreSQL source events and rebuildable Accounts/Chart projections. In the bootstrap, server `eventId` identifies the accepted event; client idempotency key identifies a retryable action. They are different IDs. Selection and actual exposure are separate records; keep causation references the exposure event. Event and job admission share one transaction. The complex logical Ledger remains the target; physical partitions and other event families evolve through migrations.

## Alternatives and why

Mutable state plus an unrelated audit log risks losing causal history. Copying the old SQLite schema would couple this new repository to obsolete implementation assumptions. This decision supersedes the old repository SQLite default for this new product only.

## Consequences

Current rows support a narrow exposure/keep slice; full typed envelopes, policy/source/app versions, privacy epochs, offline ordering and rebuild tooling are #4. Normal domain corrections append events. Privacy erasure/redaction and retention follow explicit lifecycle policy; append-only is not a promise to retain personal data forever. Never claim all target Ledger fields already exist.

## Sources and verification

[Current migration](../../packages/db/migrations/0001_bootstrap.sql), [product laws](../product/definition.md), [target event architecture](../architecture/target/04-EVENT-ARCHITECTURE.md).
