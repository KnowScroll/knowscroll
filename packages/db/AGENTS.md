# Persistence ownership

Append ordered numbered migrations. Never rewrite an applied migration or remove user history to get a test green. Coordinate shared schema changes before independent agents implement consumers. Tests use isolated databases. Ledger rows are source events; Accounts/Trace are rebuildable projections. Privacy lifecycle may erase payloads under a later explicit policy; append-only is not a promise to retain personal data forever.

ADR-0009 governs session hashing, expiry/revocation, ownership FKs and privacy epochs. ADR-0010 defines the bootstrap history-clear policy: authenticated universe lock, expected epoch, exact retry receipt, calling-session rollover, scoped FK-safe removal and monotonic revisions in one transaction. Do not retain deleted payloads in receipts or logs. Shared assets and unrelated universes survive. Full account deletion, backups and semantic reset have separate unresolved retention boundaries.
