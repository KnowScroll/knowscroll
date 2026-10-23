-- Owner: content/production. Authoritative PRIVATE supply-job table; only a constraint changes.
-- The recipe vocabulary (the library plan) is code-owned data in content/domain/library, and the
-- worker refuses an unknown key before touching this table. SQL therefore checks only the key's
-- shape, so adding a recipe never needs a migration.
-- Queries/indexes: unchanged (unique topic+policy_version, UUID primary key).
-- Growth/retention/erasure: unchanged; no account/universe data, nothing seeded or enabled here.
-- Rollout: old workers write only the six original keys, which satisfy the new shape.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The closed list is replaced by a shape check in the same transaction.
-- squawk-ignore ban-drop-constraint
ALTER TABLE content.scroll_production_runs DROP CONSTRAINT scroll_production_runs_topic_check;
-- NOT VALID enforces every new write without a table scan; existing keys already match.
ALTER TABLE content.scroll_production_runs
  ADD CONSTRAINT scroll_production_runs_topic_check CHECK (
    topic ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' AND length(topic) <= 64
  ) NOT VALID;
