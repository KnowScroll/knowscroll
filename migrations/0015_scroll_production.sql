-- Owner: content/production. Authoritative, PRIVATE nonpersonal supply jobs and research snapshots.
-- Queries: unique topic+policy version and UUID primary key; bounded first library growth.
-- Retention: kept for correction lineage, no account/universe data or erasure declaration.
-- Corrections: a reviewed new policy version creates another job and immutable asset revision.
-- Rollout: additive table; old workers do not read it. No production job is seeded/enabled here.
CREATE TABLE content.scroll_production_runs (
  id uuid PRIMARY KEY,
  topic text NOT NULL CHECK (topic IN ('seasons', 'tides', 'greenhouse')),
  policy_version text NOT NULL,
  target_revision integer NOT NULL CHECK (target_revision > 0),
  scope_generation integer NOT NULL CHECK (scope_generation > 0),
  state text NOT NULL CHECK (state IN ('research', 'claims', 'writer', 'published', 'rejected', 'unknown')),
  claims_run_id uuid NOT NULL UNIQUE,
  writer_run_id uuid NOT NULL UNIQUE,
  research jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(research) = 'array'),
  claims jsonb,
  writer_output jsonb,
  outcomes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(outcomes) = 'array'),
  asset_id uuid,
  asset_revision integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (topic, policy_version),
  CHECK ((state = 'published') = (asset_id IS NOT NULL AND asset_revision IS NOT NULL)),
  CHECK ((state IN ('published', 'rejected', 'unknown')) = (completed_at IS NOT NULL))
);
COMMENT ON TABLE content.scroll_production_runs IS 'PRIVATE research snapshots, exact quote bindings, role outcomes and lineage. No consumer read port.';
