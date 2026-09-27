# ADR-0010 — Clear Scroll history with a retryable privacy boundary

## Status

Implemented and verified in #29, following ADR-0009. [Wave-three evidence](../journeys/evidence/wave3-integration/README.md) records J003 and Android runtime behavior. This implements bootstrap encounter-history erasure, not account deletion or the full semantic-world reset protocol.

## Context

The person must be able to remove recorded encounters and saved Traces. An epoch fence alone does not erase data. Clearing must survive a lost response, stop obsolete work from restoring history, and preserve other universes and the shared sourced library. A retained audit copy of erased payloads would defeat the control.

## Decision

Expose **Clear Scroll history** in the Universe privacy controls. Explain before confirmation: it removes recorded Scroll encounters and saved Traces, preserves the shared library, and signs out other devices. Require a deliberate confirmation. It does not claim to delete an account, backups, external-provider records or semantic entities that do not exist yet.

### HTTP and retry contract

`POST /v1/history/clear` accepts exactly `{requestId: UUID, expectedPrivacyEpoch: nonnegative integer, confirmation: "clear-scroll-history"}`. The caller's session exclusively supplies universe ownership. Return 200 `{receiptId: UUID, privacyEpoch: number, clearedAt: ISO timestamp}`. The response contains the committed epoch for this operation, not a promise that no later clear occurred.

Under the authenticated universe lock: first look up `(universe, requestId)`. An identical expected epoch replays the exact receipt without clearing again. A changed expected epoch for that key returns 409. For an unknown key, require `expectedPrivacyEpoch === authenticated current epoch`; otherwise return 409. Reject malformed input with 400 after authentication. A valid but foreign/expired/revoked/old-epoch token gets generic 401 under ADR-0009. No clear occurs on validation failure.

Every deliberate confirmation gets one UUID, persisted on the client before sending. Network uncertainty retries that same body. A 409 requires refreshed state and a new explicit confirmation; never mint a replacement key automatically. Concurrent distinct requests based on the same epoch cannot both clear. A retry of an earlier receipt after a later clear must not advance the epoch or erase newer activity.

### Persistence and transaction

Allocate only `0003_history_clear.sql`. Add `history_clear_receipt(id UUID PK, universe_id UUID FK, request_id UUID, epoch_before integer, epoch_after integer, cleared_at timestamptz, UNIQUE(universe_id,request_id))`. Epochs are nonnegative, `epoch_after = epoch_before + 1`. Store no event payload, asset ID, narrative, token, token digest or deleted-row snapshot in this receipt. Existing migrations and existing history are unchanged by migration itself.

`packages/db/src/privacy.ts` exports `clearScrollHistory(client, scope: AuthScope, input: HistoryClearInput): Promise<HistoryClearReceipt>` and a conflict error with HTTP status 409. Caller owns the transaction and has acquired authenticated universe/session locks. Types and strict input schema are exported from `packages/contracts/src/index.ts`.

One transaction performs:

1. Authenticate and lock universe, then validate the retry key and expected epoch.
2. Advance privacy epoch, keeping universe revision monotonic (increment it).
3. Roll only the calling session to the new epoch, without extending expiry or reactivating revocation. Other sessions remain at the old epoch and fail subsequent authentication. This keeps lost-response retry possible without keeping other stale devices authorized.
4. Delete this universe's jobs, Traces, exposures, Ledger rows and decisions in FK-safe order. Clear its Accounts kept-asset list and increment Accounts revision; never reset revisions to zero.
5. Insert the minimal receipt and commit. Earlier clear receipts remain available for exact retry. Shared assets, other universes, migration history and worker heartbeat are untouched.

Failure at any point rolls everything back. The worker and admission already use universe-first locking: work that wins before clear can finish, then clear removes it; work after clear cannot restore deleted rows. A selected candidate must still be re-read under the universe lock. Deleted decision/exposure/event IDs are unknown under existing 422/404 contracts; still-retained older-epoch references return 409. Do not retain erased payloads merely to distinguish those errors.

### Android state and process restoration

Read `privacyEpoch` from the server Universe receipt. Before restoring a stored Scroll after process start or foregrounding, reconcile with server privacy state. A higher epoch invalidates local Scroll content, old decisions/exposures/keep retry envelopes, visited history and reading position. Do not restore private cached state while a clear outcome is uncertain or while its required server reconciliation is unavailable.

Bind the local private namespace (cached Scroll, visited IDs, reading position, observed epoch and pending clear) to the authenticated universe ID. This is local metadata, never HTTP ownership authority. Reconcile server identity before replaying a pending clear; on a different or unknown local owner, purge old private state and require a new explicit confirmation. Epoch monotonicity applies within one universe. Commit an epoch advance and private-cache removal atomically.

Persist pending clear `{requestId, expectedPrivacyEpoch, confirmation}` before dispatch; retain it across process death and network failure. On success, purge old local activity, retain a monotonic observed epoch, discard the pending clear envelope, and refresh the server Universe. Fence all in-flight old responses before they write either UI state or persistent cache. A replayed receipt from an earlier operation must never lower the locally observed epoch. Other-device 401 is displayed honestly as a session problem; no synthetic empty-universe success.

## Retention and neighboring controls

Online bootstrap encounter data is removed in the successful transaction. Minimal clear receipts and authentication records remain for retry/security while the universe exists; there is no scheduled receipt expiry in this slice. That is an explicit retention limit of this implementation, not a claim of full account erasure. The local cluster's WAL/filesystem backups and future hosted backups require a separate bounded retention/restore policy before an erasure guarantee covers them.

- **Pause personalization:** a future reversible admission/application policy for personalized inference. It does not silently erase explicit keeps or revoke authentication. Since the current Composer only avoids explicit keeps and has no inferred personalization, this wave adds no misleading pause toggle.
- **Reset personal universe:** future dependency-aware semantic reset with permitted envelopes and payload tombstones under target chapter 04. It is distinct from physically clearing the current bootstrap encounter tables.
- **Delete account:** future identity, sessions, receipts, shared/social ownership, artifacts, backups and retention policy. A clear receipt does not satisfy it.
- **Semantic proposal read sets:** future typed, scoped entity/evidence revisions checked with permissions, privacy epoch and operation preconditions in the apply transaction. Global universe revision alone must not reject unrelated observations. Explicit keeps remain deterministic additions and must not be invalidated merely because another keep changed Accounts revision. No empty proposal runtime is introduced here.

## Alternatives and consequences

Advancing an epoch without erasing rows does not clear history. Erasing without advancing the epoch permits stale work to reattach. Rolling no session forward prevents lost-response recovery; rolling all sessions forward weakens the stale-device boundary. Retaining full deleted-event audit copies defeats erasure. Per-universe serialization remains a deliberate development tradeoff. Receipt retention and backup erasure remain visible limitations.

## 2026-09-22 successor: erase encounter-derived systems (#72 / #4)

The UI audit reproduced the ADR-0028 integration gap: deleting exposures left the universe's
`world_system` and `world_system_member` rows readable. Extend step 4 to remove those private
projections after exposures are erased, in the same authenticated transaction. This is erasure of
derived encounter history, not deletion of the shared `world` / `world_member` / asset catalog.
Reset inherits the same cleanup. Exact receipt replay still returns before any erasure, preserving
new encounters and a newly derived system after an earlier clear.

Append migration `0025_world_system_privacy_erasure.sql`; do not edit migration 0017. Its replacement
system-delete guard permits removal only after that universe has no exposures. Identity and
evidence guards remain. The migration changes the guard, not existing rows; owner data is not
automatically cleared or migrated by this UI verification. The draft delivery requests privacy-lane
review of this narrow contract extension before merge. Verify both HTTP operations, replay after
new activity, rollback, shared catalog/neighbor preservation and Android foreground erasure.

## Sources / verification

Product law 12, ADR-0004/0009, and target `04-EVENT-ARCHITECTURE.md` §§9/11 inform the boundary. Required evidence: actual nonempty two-universe PostgreSQL/HTTP/worker history clear, exact retry after withheld response, concurrent keys/expected epochs, blocked admission/worker ordering, forced rollback, caller/other-device behavior, no private row or cache resurrection, shared-library preservation and Android confirmation/process-restoration checks. Run destructive cases only against disposable data; never clear owner history to demonstrate success.
