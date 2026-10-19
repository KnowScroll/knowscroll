-- 0003_content_assets: the minimal admitted-asset table the first commands check against.
--
-- Owner: content module. Authoritative for asset identity, current revision and admission status.
-- Reads: asset by id (action commands check existence and revision).
-- Writes: admission (Phase 2 production/import); CI fixtures in tests only.
-- Growth: one row per admitted Reel/Scroll. Retention: shared content, not personal data.
-- Rollout: new schema. The content module's full inventory (explanation units, immutable
--   revisions, variants, publication state) extends this table in Phase 2.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema content;

create table content.assets (
  id uuid primary key,
  revision integer not null,
  kind text not null,
  status text not null,
  created_at timestamptz not null default now(),
  constraint assets_revision_check check (revision >= 1),
  constraint assets_kind_check check (kind in ('reel', 'scroll')),
  constraint assets_status_check check (status in ('admitted', 'withdrawn'))
);
