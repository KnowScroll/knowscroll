-- #478 (v3 S-7) Ask orders (D-218): a person's question about the Scroll they are reading becomes a short Scroll made for
-- them alone, through the same made-to-order path as a thread's branch (D-049).
--
-- Owners: supply (`supply.requests` link, `supply.ask_orders` ledger) and content (`made_to_order_scrolls` gains the mode).
-- Query shapes: the person's own request by ID (unchanged); which ordered Scrolls this person asked for (the audience
-- check content makes on every way in); the day's orders for the world and for one person (the two caps); the wait that
-- recent finished orders measured (the "usually" time).
-- Locking: unchanged. The ledger insert happens under the commissioning advisory lock, last in the lock order, as the
-- scenario orders do.
-- Access: the request row is the person's own and carries their words (in `command`) and the Scroll made for them. The
-- ledger names no person and no words: an order, when it was made and when its Scroll was first seen admitted.
-- Growth: one ledger row per ask order, so bounded by the daily caps; the person's rows are bounded by their open and
-- daily limits.
-- Retention: Clear and account deletion erase the person's requests (and so their question and the link to their Scroll).
-- The ledger stays, as the scenario ledger does: it names no one and the caps read it. The Scroll's stored brief is
-- scrubbed by the erasure, and the Scroll is then open to nobody.
-- Rollout: additive. Older writers never set the new columns; a build that does not know the mode `question` never reads an
-- order that has it, because only this build makes one.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A made-to-order Scroll may now answer a person's question.
-- squawk-ignore ban-drop-constraint
alter table content.made_to_order_scrolls drop constraint made_to_order_scrolls_mode_check;
alter table content.made_to_order_scrolls add constraint made_to_order_scrolls_mode_check
  check (mode in ('what_if', 'perspective', 'question')) not valid;
-- A scrubbed question leaves an order whose brief is gone, so the length floor moves from 1 to 0 for it only.
-- squawk-ignore ban-drop-constraint
alter table content.made_to_order_scrolls drop constraint made_to_order_scrolls_brief_check;
alter table content.made_to_order_scrolls add constraint made_to_order_scrolls_brief_check
  check (char_length(brief) between 0 and 6000) not valid;

-- The link from a person's ask to the order made for it: the order and the Scroll's asset. Only the asker may open it.
alter table supply.requests add column ask_order_id uuid;
alter table supply.requests add column ask_asset_id uuid;
alter table supply.requests add constraint supply_requests_ask_order_shape
  check ((ask_order_id is null) = (ask_asset_id is null)) not valid;
-- A request waits on shared work and a brief, or (an ask from here) on the order made for it.
-- squawk-ignore ban-drop-constraint
alter table supply.requests drop constraint requests_check3;
alter table supply.requests add constraint supply_requests_requested_shape
  check (state <> 'requested' or (work_id is not null and brief is not null) or ask_order_id is not null) not valid;
-- Existing rows are few and the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create unique index supply_requests_ask_asset on supply.requests(ask_asset_id) where ask_asset_id is not null;

-- Quartermaster's ledger of ask orders. One row per order commissioned. It names no person and no words: the day's count
-- is what the world's cap reads, and `ready_at` (set once, when the Scroll was first seen admitted) is what the "usually"
-- time is measured from.
create table supply.ask_orders (
  order_id uuid primary key,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  constraint ask_orders_ready_after_created check (ready_at is null or ready_at >= created_at)
);
create index ask_orders_day on supply.ask_orders(created_at);
