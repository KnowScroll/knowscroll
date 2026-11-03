-- #653 (v3) Which limit closed an ask (D-387): a request refused as `budget_unavailable` says whether the person's own daily
-- cap, the world's daily cap, or ask orders being off closed it, so the screen can tell the truth without guessing.
--
-- Owner: supply. Authoritative. One nullable column on the person's own request row, beside `reason`.
-- `ask_limit`: `person`, `world` or `off`; set only while `reason` is `budget_unavailable` on a question asked from a Scroll.
-- Null for every other request, including every row that exists today (the screen then shows its general words).
-- Query shapes: unchanged (the column rides on the row every read already takes). Locking: unchanged.
-- Access: the person reads their own request only. The value names no other person and no count.
-- Growth: none (a column on a row that exists).
-- Retention and erasure: the row's own; Clear and account deletion remove it with the request. The export lists the request
-- as before; the column adds no new personal data (it is a coarse state of the request).
-- Rollout: additive and nullable. An older process neither reads nor writes the column; it shows the general words.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table supply.requests
  add column ask_limit text,
  add constraint requests_ask_limit_check
    check (ask_limit is null or (ask_limit in ('person', 'world', 'off') and reason is not distinct from 'budget_unavailable')) not valid;
-- The new column is null for every existing row, so the check holds. `is not distinct from` makes a limit with no reason fail
-- (a plain `=` would be null there, and a null check passes).
-- squawk-ignore constraint-missing-not-valid
alter table supply.requests validate constraint requests_ask_limit_check;
