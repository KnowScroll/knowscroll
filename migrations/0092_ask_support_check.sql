-- #580 (v3 S-7b) The support check of ask orders (D-250 to D-252): the answer to a person's question is read against the
-- passages it cites before the person is served, in the same production job as its writer.
--
-- Owner: supply (`supply.ask_orders`, the ledger of ask orders, D-218). Authoritative for the world's daily cap and the
-- "usually" time. The check itself adds no table: it is a model step of the production job, and its receipts are part of the
-- job's outcomes (content).
-- One new column says whether an order was made under the check. The "usually" time is the median of how long finished ask
-- orders took, and an order made before the check did not wait for it, so those rows must not be counted once the check
-- is part of the wait (D-252). Existing rows default to false: none of them was checked.
-- Query shapes: unchanged (the day's count by `created_at`; the latest finished orders by `ready_at`). The "usually" read now
-- also filters on `support_checked`; the table is bounded by the daily cap, so no index is added.
-- Locking: unchanged. The ledger insert happens under the commissioning advisory lock, last in the lock order.
-- Access: names no person and no words, as before.
-- Growth: unchanged, one row per ask order.
-- Retention and erasure: unchanged. The ledger names no one, so it stays through Clear and account deletion.
-- Rollout: additive. An older writer inserts without the column and gets false, so its orders are not counted in the
-- "usually" time; an older reader ignores the column.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table supply.ask_orders add column support_checked boolean not null default false;
