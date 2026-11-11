-- #674 (slice 1.2) Composer policy v2 (D-408): a stored decision may name `composer-policy.v2`, and a global sweep can find
-- expired decisions. Owner: modules/composer (the offers index serves its prune probe and is Experience's table).
--
-- 0081 widened the pin of 0017 to v0 and v1. A decision replays under the policy it names, so every v0 and v1 row keeps
-- replaying byte for byte and only new rows name v2. The payload check (the label in the payload equals the column) and the
-- immutability trigger are unchanged.
--
-- Query shapes. The prune job (`composer.prune-decisions`) finds the universes whose decisions expired in the last seven
-- days and are held by no offer and no buffer: one range scan of `composer_decisions_expired_idx`, oldest first, with a
-- probe of `offers_decision_idx` per row (before, an offer was found only by scanning the person's offers). Pruning itself
-- is unchanged: `pruneComposerDecisions` per universe under the personal root, in bounded batches.
-- Growth: one entry per decision (30 days of decisions) and one per offer. Retention and erasure: unchanged; both indexes
-- go with their rows.
-- Rollout: an older writer still writes v0 or v1 and passes the wider check. A newer writer's v2 row would be refused by an
-- older database, so this migration is applied before the new binary runs, as every migration is.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The pin is widened by name; every existing row names v0 or v1, which the new check also allows.
-- squawk-ignore ban-drop-constraint
alter table composer.decisions drop constraint decisions_policy_version_check;
alter table composer.decisions
  add constraint decisions_policy_version_check
  check (policy_version in ('composer-policy.v0', 'composer-policy.v1', 'composer-policy.v2')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table composer.decisions validate constraint decisions_policy_version_check;

-- Existing inventory is bounded at rollout (30 days of decisions, 15-minute offers); the transactional migrator cannot run
-- CONCURRENTLY, and the lock timeout above bounds the wait.
-- squawk-ignore require-concurrent-index-creation
create index composer_decisions_expired_idx on composer.decisions(expires_at, id);
-- squawk-ignore require-concurrent-index-creation
create index offers_decision_idx on experience.offers(universe_id, privacy_epoch, decision_id);
