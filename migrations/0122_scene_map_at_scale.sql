-- #674 slice 4.3 (D-417) Map at scale: a sky of systems, a layout that grows, one system at a time.
--
-- Owner: scenes (and two read indexes of geography). Derived appearance, never formation, evidence or learning
-- authority.
-- Query shapes: the sky (every system of a universe and epoch, ordered by system id, optionally only those changed
-- after a scene revision); one system's current chunks (the newest version of each of its chunk ids) and objects;
-- the objects of a few systems by id; the planet types a universe already uses (looks, group by type). Geography:
-- the places of one system through their parent key, the places and routes changed after a revision.
-- Constraints: one `scenes.systems` row per system with at most one system per coarse grid cell; a v1 object keeps
-- its lattice slot (unique among v1 objects), a v2 planet its system-local ordinal (unique within its system), every
-- other v2 object no slot; an object's layout is frozen with the rest of its identity.
-- Growth: one row per system (the sky) beside the rows that already exist; the whole-map manifest and the route
-- membership list leave `scenes.state`, so its payload no longer grows with the map. Chunk versions stay immutable.
-- Retention: erased with every other scenes table by full erasure and by selective Clear.
-- Rollout: additive for older readers of the objects (a v1 row is unchanged). Stop the old `scenes.project` consumers
-- before migrating and deploy the new worker with the migration. An old projector is not adopted again: it writes the
-- whole-map state with a scene revision that has gone back, `scenes.guard_state` refuses that, and its job dead-letters.
-- (A world an old projector creates after the migration has no state row to regress, and the next projection adopts it.)
-- This file adopts every world that exists now (`scenes.adopt_legacy_layout`): it moves no slot, anchor, seed, family or
-- chunk. Locks: see migrations/README.md (0122).

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Every object that exists now was laid out by canonical-lattice.v1.
alter table scenes.objects add column layout text not null default 'canonical-lattice.v1'
  check (layout in ('canonical-lattice.v1', 'canonical-lattice.v2'));
-- squawk-ignore ban-drop-not-null
alter table scenes.objects alter column slot drop not null;
-- squawk-ignore ban-drop-constraint
alter table scenes.objects drop constraint objects_slot_check;
-- squawk-ignore ban-drop-constraint
alter table scenes.objects drop constraint objects_universe_id_privacy_epoch_slot_key;
-- squawk-ignore constraint-missing-not-valid
alter table scenes.objects add constraint objects_layout_slot_check check (
  (layout = 'canonical-lattice.v1' and slot between 0 and 1023)
  or (layout = 'canonical-lattice.v2' and (slot is null or slot >= 0))
);
-- squawk-ignore require-concurrent-index-creation
create unique index scene_objects_v1_slot on scenes.objects (universe_id, privacy_epoch, slot)
  where layout = 'canonical-lattice.v1';
-- squawk-ignore require-concurrent-index-creation
create unique index scene_objects_v2_ordinal on scenes.objects (universe_id, privacy_epoch, system_id, slot)
  where layout = 'canonical-lattice.v2' and slot is not null;
-- squawk-ignore require-concurrent-index-creation
create index scene_objects_system on scenes.objects (universe_id, privacy_epoch, system_id);

create or replace function scenes.guard_object() returns trigger language plpgsql as $$
begin
 if (new.universe_id,new.privacy_epoch,new.object_id,new.system_id,new.chunk_id,new.slot,new.layout) is distinct from (old.universe_id,old.privacy_epoch,old.object_id,old.system_id,old.chunk_id,old.slot,old.layout)
 or (new.payload-'descriptor') is distinct from (old.payload-'descriptor')
 or ((new.payload->'descriptor')-array['label','activity']) is distinct from ((old.payload->'descriptor')-array['label','activity'])
 then raise exception 'SCENE_IDENTITY_IMMUTABLE' using errcode='23514'; end if;
 return new;
end $$;

-- A new world is pinned to v2; a world that began on v1 keeps its pinned policy (the state guard refuses a change).
-- squawk-ignore ban-drop-constraint
alter table scenes.state drop constraint state_policy_version_check;
-- squawk-ignore constraint-missing-not-valid
alter table scenes.state add constraint state_policy_version_check
  check (policy_version in ('canonical-lattice.v1', 'canonical-lattice.v2'));

-- The sky: one row per system. `cell` is the coarse grid cell of a v2 system (null for a v1 system, which keeps its
-- lattice slot); `planet_count` and `object_count` count the stored objects of the system; `scene_revision` is the
-- scene revision at which anything of the system last changed, so a client holding an older one reads it again.
create table scenes.systems (
  universe_id uuid not null references identity.universes (id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch > 0),
  system_id uuid not null,
  cell integer check (cell is null or cell >= 0),
  planet_count integer not null check (planet_count >= 0),
  object_count integer not null check (object_count >= 1),
  scene_revision integer not null check (scene_revision >= 0),
  primary key (universe_id, privacy_epoch, system_id),
  unique (universe_id, privacy_epoch, cell),
  foreign key (universe_id, privacy_epoch, system_id)
    references scenes.objects (universe_id, privacy_epoch, object_id) on delete restrict
);
create index scene_systems_revision on scenes.systems (universe_id, privacy_epoch, scene_revision);

-- A system's current manifest is the newest version of each of its chunk ids.
-- squawk-ignore require-concurrent-index-creation
create index scene_chunks_system on scenes.chunks (universe_id, privacy_epoch, system_id, chunk_id, scene_revision desc);

-- Geography reads of one system and of what changed, without loading the whole map.
-- squawk-ignore require-concurrent-index-creation
create index geography_object_parent on geography.objects (universe_id, privacy_epoch, (payload ->> 'parentKey'));
-- squawk-ignore require-concurrent-index-creation
create index geography_object_revision on geography.objects (universe_id, privacy_epoch, ((payload ->> 'objectRevision')::integer));
-- squawk-ignore require-concurrent-index-creation
create index geography_relation_from on geography.relations (universe_id, privacy_epoch, (payload ->> 'fromKey'));
-- squawk-ignore require-concurrent-index-creation
create index geography_relation_revision on geography.relations (universe_id, privacy_epoch, ((payload ->> 'relationRevision')::integer));

-- Gives a world that was projected before this layout its sky and its new state shape, and moves nothing: no slot,
-- anchor, seed, family, chunk or manifest reference changes. A state whose payload still holds the whole-map manifest
-- or the route membership list is the old shape; a state already in the new shape is left alone, so a second call is a
-- no-op. It can run again on an old-shape state of a world that has v2 systems and more objects than the first time:
-- it then refreshes the counts of the sky rows that exist (their cell and scene revision stay), adds the rows that are
-- missing, and sets `layout.nextCell` past the highest cell taken, so no cell is taken twice.
-- `layout.legacyReach` is the widest anchor of the world's v1 objects, so a new system is laid out past them.
create function scenes.adopt_legacy_layout(u uuid, e integer) returns boolean language plpgsql as $$
declare
  st scenes.state%rowtype;
  reach numeric;
  next_cell integer;
begin
  select * into st from scenes.state where universe_id = u and privacy_epoch = e for update;
  if not found or not (st.payload ? 'manifest' or st.payload ? 'routeChunks') then return false; end if;
  insert into scenes.systems (universe_id, privacy_epoch, system_id, cell, planet_count, object_count, scene_revision)
  select u, e, o.system_id, null,
    count(*) filter (where o.payload -> 'descriptor' ->> 'kind' = 'planet'), count(*), st.scene_revision
  from scenes.objects o
  where o.universe_id = u and o.privacy_epoch = e
  group by o.system_id
  on conflict (universe_id, privacy_epoch, system_id) do update
    set planet_count = excluded.planet_count, object_count = excluded.object_count;
  select coalesce(max(greatest(abs((o.payload -> 'descriptor' -> 'anchor' ->> 'x')::numeric),
    abs((o.payload -> 'descriptor' -> 'anchor' ->> 'y')::numeric))), 0) into reach
  from scenes.objects o
  where o.universe_id = u and o.privacy_epoch = e and o.layout = 'canonical-lattice.v1';
  select coalesce(max(y.cell) + 1, 0) into next_cell
  from scenes.systems y where y.universe_id = u and y.privacy_epoch = e;
  update scenes.state set payload = jsonb_strip_nulls(jsonb_build_object(
    'projected', st.payload -> 'manifest' -> 'revisions',
    'layout', jsonb_build_object('legacyReach', reach, 'nextCell', next_cell),
    'failure', st.payload -> 'failure'))
  where universe_id = u and privacy_epoch = e;
  return true;
end $$;

select scenes.adopt_legacy_layout(universe_id, privacy_epoch) from scenes.state;
