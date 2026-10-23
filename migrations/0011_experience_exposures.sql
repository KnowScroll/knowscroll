-- 0011_experience_exposures: the exposure, the lineage root of one person's encounter with one
-- admitted revision (S1.6, #229).
--
-- Owner: experience module. Authoritative.
-- Reads: one exposure by (universe_id, id) (rendering its document, activation, and the evidence
--   module's lineage checks through experience's read port).
-- Writes: one row per accepted open command (with its receipt, in the personal scope's
--   transaction); activated_at is set once by the activate command.
-- Growth: one row per opened encounter; reads are always by id, never a history scan.
-- Retention/erasure: personal; erased per universe through the erasure registry. Unlike saved
--   items, exposures do not survive "clear exploration history" (blueprint §19: encounter
--   observations and evidence go with it).
-- Rollout: new table. The asset revision is referenced with ON DELETE RESTRICT, so a revision an
--   exposure rests on can never disappear.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table experience.exposures (
  universe_id uuid not null,
  id uuid not null,
  asset_id uuid not null,
  asset_revision integer not null,
  kind text not null,
  -- How the person came to this encounter. Only `direct` (an address) exists in this story; the
  -- application owns the vocabulary, the database only checks its shape.
  origin text not null,
  -- What the client said it can render when it opened; the document is negotiated for it, so the
  -- exposure records what was presented (blueprint §6 "retain a clear reference").
  capabilities jsonb not null,
  command_id uuid not null,
  privacy_epoch integer not null,
  opened_at timestamptz not null default now(),
  -- Set once, when the article becomes the active reading surface. Visibility is observed apart.
  activated_at timestamptz,
  constraint exposures_pkey primary key (universe_id, id),
  constraint exposures_command_key unique (universe_id, command_id),
  constraint exposures_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint exposures_revision_fkey foreign key (asset_id, asset_revision) references content.asset_revisions (asset_id, revision) on delete restrict,
  constraint exposures_kind_check check (kind in ('reel', 'scroll')),
  constraint exposures_origin_check check (origin ~ '^[a-z][a-z_]{1,31}$'),
  constraint exposures_revision_check check (asset_revision >= 1),
  constraint exposures_capabilities_check check (jsonb_typeof(capabilities) = 'object' and octet_length(capabilities::text) <= 8192)
);

create index exposures_recent_idx on experience.exposures (universe_id, opened_at desc, id);
