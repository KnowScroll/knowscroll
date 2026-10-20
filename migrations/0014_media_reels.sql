-- 0014_media_reels: shared immutable media objects and approved Cutroom reuse admissions (#233).
-- Owner: content. Reads: digest/key or admitted revision. Writes: worker import, after file fsync,
-- probe and atomic install, one short admission transaction. Growth: one row per unique MP4 and
-- imported run. Retained with shared revisions; contains no personal history and is not erased.
-- Rollout: additive; old releases ignore these tables. Rollback code leaves admitted bytes intact.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table content.media_objects (
  id uuid primary key,
  logical_key text not null unique,
  backend text not null,
  sha256 text not null unique,
  size_bytes integer not null,
  mime text not null,
  revision integer not null default 1,
  probe jsonb not null,
  created_at timestamptz not null default now(),
  constraint media_objects_key_check check (logical_key ~ '^sha256/[0-9a-f]{2}/[0-9a-f]{64}\.mp4$'),
  constraint media_objects_backend_check check (backend = 'local'),
  constraint media_objects_sha_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint media_objects_size_check check (size_bytes > 0 and size_bytes <= 67108864),
  constraint media_objects_mime_check check (mime = 'video/mp4'),
  constraint media_objects_revision_check check (revision >= 1),
  constraint media_objects_probe_check check (jsonb_typeof(probe) = 'object' and octet_length(probe::text) <= 16384)
);

create table content.reel_imports (
  run_id uuid primary key,
  asset_id uuid not null,
  asset_revision integer not null,
  media_id uuid not null,
  script_name text not null,
  fixture boolean not null default false,
  imported_at timestamptz not null default now(),
  constraint reel_imports_revision_key unique (asset_id, asset_revision),
  constraint reel_imports_revision_fkey foreign key (asset_id, asset_revision) references content.asset_revisions (asset_id, revision) on delete restrict,
  constraint reel_imports_media_fkey foreign key (media_id) references content.media_objects (id) on delete restrict,
  constraint reel_imports_revision_check check (asset_revision >= 1),
  constraint reel_imports_script_check check (script_name in ('greenhouse', 'seasons-v5', 'tides-v4'))
);

-- Only widens the allowed observation vocabulary; older Scroll rows and readers retain their shape.
-- Required vocabulary extension; the replacement immediately enforces all old kinds plus Reel.
-- squawk-ignore ban-drop-constraint
alter table evidence.observations drop constraint observations_kind_check;
alter table evidence.observations add constraint observations_kind_check
  check (kind in ('scroll.block_coverage', 'scroll.active_dwell', 'scroll.block_interaction', 'reel.playback')) not valid;
-- Existing rows passed the preceding stricter validated constraint; NOT VALID still enforces
-- every new write. Leave catalog validation for a separate transaction/migration, avoiding a scan
-- while the constraint replacement holds ACCESS EXCLUSIVE.

-- CF-65 structural fence: even a misconfigured local/CI operator cannot admit fixture media into
-- a real world's database. Local hands-on databases use knowscroll_fixture_*; CI uses ks_it_*.
create function content.refuse_fixture_reel_in_real_database() returns trigger
language plpgsql as $$
begin
  if new.fixture and current_database() !~ '^(ks_it_|knowscroll_fixture_)' then
    raise check_violation using message = 'fixture_reel_database_refused';
  end if;
  return new;
end;
$$;
create trigger reel_imports_fixture_fence before insert or update on content.reel_imports
  for each row execute function content.refuse_fixture_reel_in_real_database();
