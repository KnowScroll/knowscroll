-- Personal role run pacing (#231, D-052). Owner: modules/geography and modules/planner.
-- Each role's state row gains `next_run_not_before`: the earliest time that person's next run of the
-- role may start. A run that settles sets it a little ahead, so reading that keeps arriving is
-- coalesced into one pending run with a delayed wake instead of one model run per encounter. Null
-- means no wait. Derived scheduling state, never evidence: every settled run rewrites it.
-- Queries: read and written with the state row by its primary key. Growth: none. Retention and
-- erasure are the state row's, unchanged. Rollout: additive and nullable. An older writer leaves it
-- null (no wait) and an older reader ignores it.
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table geography.state add column next_run_not_before timestamptz;
alter table planner.state add column next_run_not_before timestamptz;
