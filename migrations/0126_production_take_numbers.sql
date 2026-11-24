-- #800 (D-439) A take refused with `asset_conflict` does not count toward a recipe's three takes. Owner: content/production
-- (`content.scroll_production_runs`, private, nonpersonal, retained).
--
-- Why. A take's number is part of the job's identity: `unique (topic, policy_version, take)`, and the table held at most three
-- takes per recipe and version (`scroll_production_runs_take_check`, 0052). A take that the publication step refused before
-- anything was stored (the asset conflicted) is not the writer's fault and no longer counts, but it keeps its number: numbers are
-- never reused, so the audit of a refused take is never overwritten. A recipe therefore needs room for the takes that count
-- (three) and for the takes that were refused (at most three more). The check widens from 1..3 to 1..6.
-- The code bounds the other side: a recipe never has more than three counted takes, and no take is numbered past six, so the
-- table holds at most six rows per recipe and version and a loop of refused paid takes still ends.
--
-- The replacement only widens the allowed range, so every existing row satisfies it. NOT VALID keeps the replacement from
-- scanning the table under the lock and still enforces every new write (as 0052 did for the constraint it replaces).
-- Query shapes, indexes, growth (six rows, not three, per recipe and version), retention, erasure and lock order: unchanged.
-- Rollout: additive. A process from before this change writes only takes 1 to 3 and reads the same rows; it counts every take,
-- which is the stricter rule, so it never starts a take the new rule refuses. A process of this release reads a refused take as
-- not counted from the receipts the job already recorded; no column is added.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- squawk-ignore ban-drop-constraint
alter table content.scroll_production_runs drop constraint scroll_production_runs_take_check;
alter table content.scroll_production_runs
  add constraint scroll_production_runs_take_check check (take between 1 and 6) not valid;
