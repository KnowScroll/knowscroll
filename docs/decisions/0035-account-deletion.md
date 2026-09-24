# ADR-0035 — Deleting the owner account: Reset, plus the account, in one transaction

Date: 2026-09-24. Status: accepted for [#135](https://github.com/KnowScroll/knowscroll/issues/135)
(parent #72). Builds on ADR-0026 (magic-link single-owner identity), ADR-0028/0030 (privacy
lifecycle and Reset) and ADR-0034 (desktop session cookie).

## Context

Reset (ADR-0030) erases personal history and ends every session, but keeps the account, its
sign-in tokens (salted requester fingerprints, timestamps) and the dated privacy receipts (when
the reader paused, exported, cleared or reset). A person leaving the product needs those gone too.
The schema deliberately refuses each of those deletions: sign-in tokens are "never deleted",
privacy receipts are immutable, and a universe "stays with the account that adopted it".

## Decision

1. **Route.** `POST /v1/account/delete {requestId, expectedPrivacyEpoch, confirmation:
   'delete-my-account-and-history'}` through the normal authenticated path (universe lock, epoch
   recheck). Its literal differs from Reset's: it removes more. A cookie session also needs its
   CSRF token and same origin (ADR-0034), and the response clears the cookie.
2. **One transaction.** Advance the privacy epoch; erase exactly what Reset erases; write an
   `account_deletion_receipt`; delete every sign-in token of the account, every `device_session`
   of the universe (not merely revoke), the four dated privacy receipt tables' rows for the
   universe and the `account` row; unbind the universe (`account_id = NULL`) and clear its pause.
3. **Guards stay closed.** The receipt is written first. A single SQL predicate,
   `account_deletion_in_progress(universe, account)`, is true only when a receipt for that
   universe/account carries `deleted_at = now()` — the current transaction's start. The three guards
   (`sign_in_token_guard`, `privacy_receipt_immutable`, `universe_account_binding_guard`) allow their
   one deletion only then. An earlier deletion's receipt authorizes nothing.
4. **What stays.** The empty universe row (the single-owner universe is fixed; a later sign-in with
   the owner address creates a new account that adopts it and starts from nothing); shared
   knowledge; minimal, content-free reasoning accounting under its existing retention (ADR-0019);
   and the tombstone itself — ids, epochs, a session count and a time, never the address. It is
   immutable and cannot be deleted even inside the deletion transaction.
5. **No replay.** The calling session is deleted, so a retry cannot authenticate. A client that
   sent a deletion and receives 401 treats itself as signed out either way and clears local state.
6. **Backups.** The development stack keeps no product backups. A future hosted deployment with
   backups must state their retention in its privacy notice; this ADR does not claim backups are
   purged.

## Alternatives rejected

- Soft delete (`account.disabled_at`): keeps the address and the dated receipts, which is the
  thing being asked to go.
- `ALTER TABLE ... DISABLE TRIGGER` inside the transaction: takes a table lock, affects every
  concurrent writer, and leaves the guards' meaning in application code.
- Deleting the universe row: dozens of shared foreign keys and the fixed owner universe id; an
  empty, unbound universe is observably equivalent.

## Consequences

Migration 0029, `deleteAccount` in `packages/db/src/privacy.ts`, the route in `apps/api/src/app.ts`,
`AccountDeletionInput`/`AccountDeletionReceipt` contracts, and `tests/account-deletion.test.ts`
(confirmation, stale epoch, full footprint, re-sign-in, cookie + CSRF, guards refusing outside the
transaction). Clients: web settings and Android privacy screen offer it behind the literal.
