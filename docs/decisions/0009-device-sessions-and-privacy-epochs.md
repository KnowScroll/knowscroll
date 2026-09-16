# ADR-0009 — Device sessions and privacy epoch fences

## Status

Implemented in #21 through PRs #26/#25, with [wave-two runtime evidence](../journeys/evidence/wave2-integration/README.md). Production login remains unimplemented. [ADR-0010](0010-clear-scroll-history.md) extends this contract for the next scoped history-clear increment; it does not turn epoch fencing into a full privacy lifecycle.

## Context

The bootstrap binds all authenticated requests to one development universe. A bearer comparison alone cannot express independent ownership, expiry or revocation. Future lifecycle operations also need queued work to stop applying obsolete state. Existing owner history must survive migration.

## Decision

Use operator-provisioned opaque device sessions. Generate 32 random bytes; store only their SHA-256 digest. A session binds a device UUID to a universe UUID and its privacy epoch. It expires after 30 days by default (operator range 1–720 hours), and may be revoked server-side. This binding does not verify a real person's identity. Keep loopback and production guards.

Enroll `KS_DEV_TOKEN` once as a regular session for the existing owner universe. Repeated startup must never extend expiry, reactivate a revoked session, or bypass session lookup. Existing HTTP input schemas stay unchanged. Mobile remains a development client; public signup, account recovery and device enrollment UX are later work.

### Shared persistence and helper contract

Only migration `0002_identity_epochs.sql` changes schema. Add nonnegative integer `privacy_epoch` (default zero) to universe, decision, ledger and job. Add `device_session(id, universe_id, device_id, token_hash, privacy_epoch, created_at, expires_at, revoked_at)` with unique 64-character lowercase hexadecimal token hash and universe FK. Add terminal job status `discarded` and `discarded_at`; stale work has no completed timestamp and never enters retry. Preserve all original migration bytes and rows.

Enforce same-universe lineage with composite foreign keys for decision/exposure, Ledger causation, exposure/event, job/event and Trace/event. Keep existing IDs and uniqueness. A migration that encounters incompatible history must fail transactionally rather than rewrite it.

`packages/db/src/identity.ts` exports:

- `AuthScope`: `{sessionId, deviceId, universeId, privacyEpoch, expiresAt}` (expiry ISO string).
- `UnauthorizedSession`: generic authentication error.
- `ensureDevelopmentSession(token: string): Promise<void>`: enroll once; reject token collisions with another owner/device binding; no raw token logging.
- `authenticateAndLock(client, token: string): Promise<AuthScope>`: caller owns a transaction. Look up the hash, lock its universe, then re-read and validate session expiry/revocation and current epoch. Use `clock_timestamp()` for expiry after lock waits. Unknown, expired, revoked and old-epoch sessions all fail identically.
- `revokeSession(client, scope): Promise<void>`: revoke the authenticated session while its universe lock is held.
- `provisionIdentity({universeId?, deviceId?, expiresInHours?} = {}): Promise<{token: string, scope: AuthScope}>`: create a new universe/accounts unless an existing universe is explicitly selected; lock before minting at its current epoch. Never create an arbitrary missing existing universe.

`lockUniverse(client, universeId = OWNER_ID)` remains backward compatible for bootstrap callers. All serving code supplies ownership explicitly. Operator CLI `scripts/provision-session.ts --out PATH [--universe-id UUID] [--device-id UUID] [--expires-in-hours N]` writes a new mode-0600 credential file, never tokens to stdout or arguments. Refuse overwrite or a destination inside a Git repository unless ignored. It is a trusted local operator command, not an HTTP enrollment endpoint.

### HTTP contract

Every `/v1` route runs authentication and its reads/writes in one transaction holding the universe lock. No body/query identifier can select ownership. Health remains unauthenticated. `buildApp(token)` stays synchronous; development enrollment runs in its async startup hook.

- Existing universe/feed/exposure/interaction/event response fields remain compatible. Add `privacyEpoch` to universe and feed receipts.
- `GET /v1/session` returns the authenticated `AuthScope` only.
- `POST /v1/session/revoke` accepts exactly `{}` and returns 204. Subsequent requests (including after restart) return generic 401. No arbitrary target session parameter.
- Foreign decisions/exposures fail 422 and foreign events return 404. Unknown bearer sessions return 401.
- Decision/exposure references from an older epoch fail 409 before idempotency replay. Decisions, exposure/keep Ledger events and jobs are stamped with the admitted epoch. Existing current-epoch idempotency and conflict behavior remain.

### Lock order and deterministic worker

Acquire universe before session/domain/job/projection rows. A worker may peek at a candidate without a row lock, then lock its universe and re-lock/re-read the still-pending job. Recheck both the job and causal Ledger epoch/scope under that lock before projection. Old-epoch work becomes discarded without changing Trace, Accounts or universe revision. Current work retains transactional, idempotent projection. `projectOne()` returns `{jobId, status: 'completed' | 'discarded'} | null`; logs report that actual outcome.

Session revocation uses the same universe lock as requests: a request that wins the lock may finish, while requests after committed revocation cannot act. This is not cancellation of already committed work. Epoch advancement has no public endpoint this wave; tests advance a disposable universe to exercise the fence. Full clear/delete/pause behavior requires a later retention and audit policy. This is not the semantic proposal read-set protocol.

## Alternatives and why

Keep the static bearer: cannot revoke individual devices or establish independent ownership. Introduce public identity infrastructure now: would expand beyond the verified local product and require enrollment/recovery/deployment choices. Put ownership in request bodies: lets clients choose authority. Lock jobs before universes: conflicts with admission/lifecycle lock order and risks deadlock.

## Consequences

Requests serialize per universe for now. Raw tokens exist only at provisioning and on the client. Session expiry is operationally visible; operators mint a replacement explicitly. Shared editorial assets remain global, while decisions, events and projections are private. Existing content is not erased or relabeled as belonging to a new person.

## Sources / verification

[OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) informs token entropy and server-side invalidation. [PostgreSQL row locking](https://www.postgresql.org/docs/16/explicit-locking.html) informs the common lock order. Acceptance is real PostgreSQL tests plus J001 and a two-session HTTP/separate-worker journey, including expiry, revocation races, stale epochs and cross-universe denial. Historical receipts must not claim a service is currently running.
