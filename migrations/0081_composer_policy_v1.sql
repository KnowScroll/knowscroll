-- #476 (v3 S-5) Composer policy v1 (D-190): a stored decision may name `composer-policy.v1`. Owner: modules/composer.
--
-- 0017 pinned the label to `composer-policy.v0`, and every decision stored so far names it. A decision replays under
-- the policy it names, so v0 rows keep replaying byte for byte and new rows name v1. The payload check (the label in the
-- payload equals the column) and the immutability trigger are unchanged.
--
-- Query shapes: unchanged. A decision is written once by its id and read by its id; `composer replay-policy` reads
-- the retained decisions in recorded order, a page at a time, and prints counts only.
-- Growth, retention, erasure and lock order: unchanged (30 days; the personal root first).
-- Rollout: an older writer still writes v0 and passes the wider check. A newer writer's v1 row would be refused by an
-- older database, so this migration is applied before the new binary runs, as every migration is.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The pin is widened by name; every existing row names v0, which the new check also allows.
-- squawk-ignore ban-drop-constraint
alter table composer.decisions drop constraint decisions_policy_version_check;
alter table composer.decisions
  add constraint decisions_policy_version_check
  check (policy_version in ('composer-policy.v0', 'composer-policy.v1')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table composer.decisions validate constraint decisions_policy_version_check;
