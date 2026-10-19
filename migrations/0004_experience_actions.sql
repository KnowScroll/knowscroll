-- 0004_experience_actions: explicit actions on content (save/unsave) and the saved-items state.
--
-- Owner: experience module. Authoritative.
-- Reads: saved items of one universe, newest first, bounded (GET /v1/saved); one action by id
--   (evidence job); saved state of one asset inside the locked scope.
-- Writes: one action row and the saved-item change per accepted command, with its receipt and
--   evidence job, in one transaction.
-- Growth: actions grow with use (bounded reads only); saved items one per saved asset.
-- Retention/erasure: personal; erased per universe through the erasure registry. Saved items are
--   preserved by "clear exploration history" (blueprint §19).
-- Rollout: new schema.

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema experience;

create table experience.saved_items (
  universe_id uuid not null,
  asset_id uuid not null,
  asset_revision integer not null,
  saved_at timestamptz not null,
  constraint saved_items_pkey primary key (universe_id, asset_id),
  constraint saved_items_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint saved_items_asset_fkey foreign key (asset_id) references content.assets (id) on delete restrict,
  constraint saved_items_revision_check check (asset_revision >= 1)
);

create index saved_items_recent_idx on experience.saved_items (universe_id, saved_at desc, asset_id);

create table experience.actions (
  universe_id uuid not null,
  id uuid not null,
  command_id uuid not null,
  kind text not null,
  asset_id uuid not null,
  asset_revision integer not null,
  privacy_epoch integer not null,
  created_at timestamptz not null default now(),
  constraint actions_pkey primary key (universe_id, id),
  constraint actions_command_key unique (universe_id, command_id),
  constraint actions_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint actions_kind_check check (kind in ('save', 'unsave')),
  constraint actions_revision_check check (asset_revision >= 1)
);
