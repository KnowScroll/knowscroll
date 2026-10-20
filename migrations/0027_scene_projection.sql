-- Owner: Scenes. Derived persisted appearance, never formation/evidence authority.
-- Query: locked universe/epoch current pointer, stable object/chunk identity, exact immutable version.
-- Bounds: 1000 objects / 1000 relations globally in projector; 100 objects/routes per chunk,
-- 128 chunks per manifest, canonical parser 262144 bytes per document plus SQL byte ceilings.
-- Growth: immutable versions retain earlier views until full personal erasure; no public cache.
-- Correction: label/activity and newer snapshots only; identity/seed/anchor/chunk stay pinned.
-- Retention: erase ALL epochs, versions and pg-boss states before Geography. No historical seeding.
-- Additive rollout: older processes ignore scenes; migration creates no personal state or jobs.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema scenes;
create table scenes.manifests (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),scene_revision integer not null check(scene_revision>0),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=262144),
 primary key(universe_id,privacy_epoch,scene_revision)
);
create table scenes.chunks (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),chunk_id uuid not null,scene_revision integer not null check(scene_revision>0),system_id uuid not null,
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=262144),
 primary key(universe_id,privacy_epoch,chunk_id,scene_revision)
);
create table scenes.objects (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),object_id uuid not null,system_id uuid not null,chunk_id uuid not null,
 slot integer not null check(slot between 0 and 1023),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384),
 primary key(universe_id,privacy_epoch,object_id),unique(universe_id,privacy_epoch,slot)
);
create table scenes.state (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),world_seed text not null check(world_seed~'^[a-f0-9]{64}$'),
 scene_revision integer not null check(scene_revision>=0),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=262144),
 primary key(universe_id,privacy_epoch)
);
create function scenes.guard_version() returns trigger language plpgsql as $$
begin raise exception 'SCENE_VERSION_IMMUTABLE' using errcode='23514'; end $$;
create trigger scene_manifest_immutable before update on scenes.manifests for each row execute function scenes.guard_version();
create trigger scene_chunk_immutable before update on scenes.chunks for each row execute function scenes.guard_version();
create function scenes.guard_object() returns trigger language plpgsql as $$
begin
 if (new.universe_id,new.privacy_epoch,new.object_id,new.system_id,new.chunk_id,new.slot) is distinct from (old.universe_id,old.privacy_epoch,old.object_id,old.system_id,old.chunk_id,old.slot)
 or (new.payload-'descriptor') is distinct from (old.payload-'descriptor')
 or (new.payload->'descriptor'-array['label','activity']) is distinct from (old.payload->'descriptor'-array['label','activity'])
 then raise exception 'SCENE_IDENTITY_IMMUTABLE' using errcode='23514'; end if;
 return new;
end $$;
create trigger scene_object_identity before update on scenes.objects for each row execute function scenes.guard_object();
create function scenes.guard_state() returns trigger language plpgsql as $$
begin
 if (new.universe_id,new.privacy_epoch,new.world_seed) is distinct from (old.universe_id,old.privacy_epoch,old.world_seed) or new.scene_revision<old.scene_revision
 then raise exception 'SCENE_SEED_IMMUTABLE' using errcode='23514'; end if;
 return new;
end $$;
create trigger scene_state_identity before update on scenes.state for each row execute function scenes.guard_state();
