-- Owner: content/production. Authoritative PRIVATE nonpersonal recipe-key constraint.
-- Queries/indexes: existing unique (topic, policy_version) and UUID lookups are unchanged.
-- Growth/retention: same bounded supply-job table and correction lineage; no new table/index.
-- Correction/erasure: forward-only constraint extension; no historical row rewrite or deletion.
-- Rollout: apply after 0025; old workers still accept only their code-owned keys. No job,
-- asset, semantic coverage approval, personal evidence or provider/spend grant is seeded.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Required closed vocabulary extension; replacement enforces all old keys plus the three new units.
-- squawk-ignore ban-drop-constraint
ALTER TABLE content.scroll_production_runs DROP CONSTRAINT scroll_production_runs_topic_check;
ALTER TABLE content.scroll_production_runs
  ADD CONSTRAINT scroll_production_runs_topic_check CHECK (
    topic IN (
      'seasons', 'tides', 'greenhouse',
      'greenhouse-radiation', 'greenhouse-balance', 'greenhouse-limits'
    )
  ) NOT VALID;

-- Existing rows passed the stricter validated 0015 constraint and already satisfy this superset.
-- NOT VALID enforces every new write; avoid a table scan while replacement holds ACCESS EXCLUSIVE.
-- Catalog validation can occur in a separate reviewed transaction, as with 0014 vocabulary widening.
