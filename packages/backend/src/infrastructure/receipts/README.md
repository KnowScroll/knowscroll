# infrastructure/receipts

Command receipts (blueprint §19). Owns: the `receipts` schema.

| Operation | Purpose |
|---|---|
| `requestHash(operation, request)` | SHA-256 over the operation and the canonical validated request (keys sorted, no whitespace; revisions the command relied on are part of the request). Property-tested: key order never changes it. |
| `findPersonalReceipt(scope, key)` | Inside the locked scope: `new`, `replay` (stored outcome of an identical request at the caller's privacy epoch and outcome version), `key_reused` (same `(universe_id, command_id)` with another operation or hash → `COMMAND_KEY_REUSED`, 422), `epoch_mismatch` (a receipt from before a privacy reset, never replayed; the caller is at the current epoch, so it must mint a new command ID), `outcome_version_newer` (written by a newer release during a rolling deploy: retry later, 503) or `outcome_version_older` (a retired shape: mint a new ID). |
| `insertPersonalReceipt(scope, key)` | Inserts the pending receipt before any effect. |
| `completePersonalReceipt(scope, commandId, outcome)` | Stores the bounded JSON outcome in the same transaction as the effects. |
| `findSharedReceipt` / `insertSharedReceipt` / `completeSharedReceipt` | Shared-scope commands: the key binds scope kind and ID (from the `SharedScopeTx`), actor account, operation and command ID. They require a `SharedScopeTx` from `enterSharedRoot`, so the shared root is always locked after the actor's personal root. |

Rules:

- The personal receipt identity is `(universe_id, command_id)`; the universe comes from the
  authenticated scope, never from the client. Keys sort by Unicode code point; Dates, class
  instances and non-finite numbers are refused rather than serialised ambiguously.
- A retryable refusal (missing asset, stale revision, stale epoch, busy) writes no receipt and is
  evaluated again on retry. A command with a terminal refusal must store it or require a new
  command ID (D-016). Accepted commands replay exactly.
- A failure before commit rolls back the receipt with the effects and the enqueued job.
- Erasure: `receipts.personal_commands` is erased per universe (`erasure.ts`); shared receipts
  follow their shared scope's lifecycle.

Outcome versions: a release that writes outcome version N must still read N-1, because retries
and rolling deploys span one release. `experience.apply-action` stores version 1; its shape gained
`revision` before any receipt reached a shared database (the migrations had never left CI), so no
older version 1 exists to read.
