# Web Reset after a failure — 2026-09-24 (#135, from #119)

A failed Reset on the web kept its typed confirmation on screen, but neither Confirm nor Cancel
did anything: the store accepted them only while the confirmation was fresh. Now, as for account
deletion (ADR-0035), the same Confirm is the retry with the same request id, and Cancel closes it.
Reset also ends the calling session inside its own transaction (ADR-0030), so a 401 after a lost
response may mean the Reset itself happened. The page then says only that: "Your session ended.
The Reset may have completed, but the connection dropped before it was confirmed. Sign in to see your universe." It never
shows a receipt it did not receive. Its local private state is purged, and the epoch fence stays
at what was observed, so a Reset that did not land is never refused later.

## Proof

- `readerStore.test.ts`: 6 new tests. Three failed before the change: the retry with the same
  request id, Cancel after a failure, and the 401 after a lost response. Two more, added after
  review, kill the mutants that dropped the automatic-retry case or moved the epoch fence ahead: the
  401 that follows the client's own retry, and lost → Cancel → new confirmation → 401, both
  checking the fence stays at the observed epoch. The last one guards the old path: a 401 on the
  first attempt is not reported as a possible Reset. Web unit suite 207/207, `tsc`.
- The real web owner journey (`scripts/run-web-owner-journey.ts`: disposable PostgreSQL, the API,
  Vite in cookie mode, Chromium) now resets twice before deleting the account, with a network
  failure injected in the browser:
  1. No attempt reaches the API. The failure is shown, the same Confirm retries, and the real
     receipt follows (`03-reset-after-retry.png`: epoch 0 → 1). Continuing signs out, and the
     journey signs in again with a new emailed link.
  2. The Reset lands (the API answers 200, which the journey asserts), but that answer is dropped.
     The client's own automatic retry meets the revoked session, and the page says the Reset may
     have completed (`04-reset-may-have-completed.png`).
  Then the account is deleted, and the runner checks the database: 0 accounts, 1 deletion
  receipt, 0 sessions (`web-owner-receipt.json`).
- The same journey without the store change fails at step 1: the receipt never appears.
