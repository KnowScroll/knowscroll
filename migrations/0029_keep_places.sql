-- 0029_keep_places: private per-membership latest Keep position, owned by Experience (#246).
-- Add identities only to actual retained Saved rows; never backfill a position or encounter.
-- Saved membership/ref/time is immutable until Unsave; resave mints a new identity.
-- Reads: one owned exact Saved membership/place. Writes: own root/account gate, Content SHARE,
-- receipt/place/root watermark/hint atomically. No Evidence, jobs, HTTP or provider work.
-- Retention: latest position only, no event history; full erasure deletes places before Saved.
-- This is not the separate exploration-clear lifecycle. Source-only; rollout requires review.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table experience.saved_items add column saved_entry_id uuid;
-- Explicit bounded-time metadata backfill; preserving every existing ref and saved_at value.
update experience.saved_items set saved_entry_id = gen_random_uuid() where saved_entry_id is null;
alter table experience.saved_items alter column saved_entry_id set default gen_random_uuid();
alter table experience.saved_items add constraint saved_items_entry_present check (saved_entry_id is not null) not valid;
-- Atomic identity backfill runs under bounded maintenance locks; split validation would leave a partial rollout.
-- squawk-ignore constraint-missing-not-valid
alter table experience.saved_items validate constraint saved_items_entry_present;
alter table experience.saved_items alter column saved_entry_id set not null;
-- The migrator is one transaction; this backfill/index requires reviewed stopped-service rollout and bounded locks.
-- squawk-ignore require-concurrent-index-creation
create unique index saved_items_entry_key on experience.saved_items(universe_id, saved_entry_id);

create function experience.keep_membership_immutable() returns trigger language plpgsql as $$
begin
  if new.universe_id is distinct from old.universe_id or new.asset_id is distinct from old.asset_id
    or new.asset_revision is distinct from old.asset_revision or new.saved_entry_id is distinct from old.saved_entry_id
    or new.saved_at is distinct from old.saved_at then
    raise check_violation using message = 'keep_membership_immutable';
  end if;
  return new;
end;
$$;
create trigger keep_membership_immutable before update on experience.saved_items
  for each row execute function experience.keep_membership_immutable();

create table experience.saved_places (
  universe_id uuid not null,
  saved_entry_id uuid not null,
  place_revision bigint not null,
  position jsonb not null,
  constraint saved_places_pkey primary key (universe_id, saved_entry_id),
  constraint saved_places_universe_fkey foreign key (universe_id) references identity.universes(id) on delete restrict,
  constraint saved_places_entry_fkey foreign key (universe_id, saved_entry_id)
    references experience.saved_items(universe_id, saved_entry_id) on delete cascade,
  constraint saved_places_revision_check check (place_revision between 1 and 9007199254740991),
  constraint saved_places_position_check check (
    octet_length(position::text) <= 1024 and
    case when jsonb_typeof(position) = 'object' then
      case position ->> 'kind'
        when 'reel' then
          position ?& array['kind', 'positionMs'] and position - array['kind', 'positionMs'] = '{}'::jsonb
          and case when jsonb_typeof(position -> 'positionMs') = 'number'
            then (position ->> 'positionMs')::numeric between 0 and 9007199254740991 else false end
        when 'scroll' then
          position ?& array['kind', 'blockId', 'offsetWithinBlock']
          and position - array['kind', 'blockId', 'offsetWithinBlock'] = '{}'::jsonb
          and jsonb_typeof(position -> 'blockId') = 'string' and (position ->> 'blockId') ~ '^[a-z][a-z0-9-]{1,39}$'
          and case when jsonb_typeof(position -> 'offsetWithinBlock') = 'number'
            then (position ->> 'offsetWithinBlock')::numeric between 0 and 9007199254740991 else false end
        else false
      end
    else false end
  )
);
