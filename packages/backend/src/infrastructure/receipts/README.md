# infrastructure/receipts

Command receipts (blueprint §19). Owns: the `receipts` schema.

| Operation | Purpose |
|---|---|
| `requestHash(operation, request)` | SHA-256 over the operation and the canonical validated request (keys sorted, no whitespace; revisions the command relied on are part of the request). Property-tested: key order never changes it. |
| `findPersonalReceipt(scope, key)` | Inside the locked scope: `new`, `replay` (stored outcome of an identical request) or `key_reused` (same `(universe_id, command_id)` with another operation or hash → `COMMAND_KEY_REUSED`, 422). |
| `insertPersonalReceipt(scope, key)` | Inserts the pending receipt before any effect. |
| `completePersonalReceipt(scope, commandId, outcome)` | Stores the bounded JSON outcome in the same transaction as the effects. |
| `findSharedReceipt` / `insertSharedReceipt` / `completeSharedReceipt` | Shared-scope commands: the key binds scope kind and ID, actor account, operation and command ID. Run inside the transaction that holds the shared root lock. |

Rules:

- The personal receipt identity is `(universe_id, command_id)`; the universe comes from the
  authenticated scope, never from the client.
- A refused command (missing asset, stale revision, …) writes no receipt: refusals are evaluated
  again on retry. Only accepted commands have receipts, and their replay is exact.
- A failure before commit rolls back the receipt with the effects and the enqueued job.
- Erasure: `receipts.personal_commands` is erased per universe (`erasure.ts`); shared receipts
  follow their shared scope's lifecycle.
