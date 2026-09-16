# Durable SQL fairness — issue #55

The internal PostgreSQL scheduler implements ADR-0013 under the existing ADR-0012 privacy/accounting rules. Ordinary provider dispatch remains disabled. All new execution evidence uses synthetic trusted authority, requests and receipts; no provider was called.

## Independent checks

The coordinator owns migration 0006, transaction composition, accounting and final scheduler integration. Native workers were configured as `gpt-5.6-terra` for SQL tests and independent concurrency/privacy review, and `gpt-5.6-sol` for independent service tests. The earlier scheduler draft was superseded before acceptance. Review examined the integrated source, not only worker reports.

The PostgreSQL tests demonstrate:

- Competing clients admit one queued job once; separate universes can progress. An injected insert failure rolls back claim, Permit, reservations, credits and cursors together.
- A locked universe does not block another; a capacity-blocked head does not hide a later fitting request. Sparse scans and maximum-size requests make progress from zero credit.
- Four complete traversals with unequal request charges deliver class charges 200:240:160:120:80, matching 5:6:4:3:2. Different universe request costs/backlogs deliver equal charged service, 60:60, despite request counts 30:6.
- Returning housekeeping demand resumes within the configured visit spend; a saved inner turn resumes without earning a second quantum.
- A forced barrier lets another enqueue invalidate a preflight generation while clear waits for the original universe. The stale selection rolls back; clear removes the old work, and only the surviving universe admits.
- Public authorization/clear/late-receipt paths retain original accounting, including cross-epoch debt. Original rate-window A corrections leave current window B holds unchanged. A separate direct accounting test verifies cap/discard amounts and exactly one not-sent refund delta.

The [restart receipt](postgres-restart.json) records a populated migration-0001–0005 upgrade, unchanged old checksums and data, an actual disposable PostgreSQL process stop/restart, identical durable snapshots, resumed admission and receipt replay with no second effect. Its original revision and source hashes are retained. [Execution metadata](execution.json) links the local regression results and exact logs by hash.

## Limits

These are synthetic PostgreSQL service-opportunity and safety tests, not elapsed-time fairness, throughput, production multi-node capacity or useful recommendation evidence. The restart uses PostgreSQL fast shutdown; it does not prove power-loss or storage-corruption recovery. Rate-window identities are tested with trusted A/B policies; automatic provider window timing remains absent. Unknown remote outcomes and permanent overload can block service indefinitely.

J001–J004 and interruption cleanup remain regression evidence for their existing scopes. No new Android user journey or real product-provider behavior is claimed. Parent #7 remains open for authorized context/proposals, lifecycle controls, exact direct intent and the eventual explicitly bounded product-provider experiment.
