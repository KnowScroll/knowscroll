-- #250 (E07) Retry a request that could not be prepared, as the same request. Owner: modules/supply.
-- supply.requests gains `retries`, how many times the person asked to try this request again, and
-- `wait_started_at`, when its current wait began. A retried request is the same row and ID, so
-- `created_at` keeps saying when it was asked; the wait limit and the resolver's poll slots count from
-- `wait_started_at` (null until a retry: they count from `created_at`, as before). The poll job's
-- identity names the retry, so a new wait never collides with the jobs of the one that ended.
-- The code allows three retries per request; SQL only keeps the count in range.
-- Queries: unchanged (the owned request by ID; the person's open and recent asks). No new index.
-- Growth: two small columns on a row that already exists once per ask. Retention and erasure:
-- unchanged, private to the person and erased with them. Lock order: unchanged.
-- Rollout: additive. Older writers never set either column and read the defaults.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table supply.requests add column retries integer not null default 0;
alter table supply.requests add column wait_started_at timestamptz;
alter table supply.requests add constraint supply_requests_retries check(retries between 0 and 10) not valid;
alter table supply.requests add constraint supply_requests_wait_started
 check(wait_started_at is null or wait_started_at>=created_at) not valid;
