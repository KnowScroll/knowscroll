-- Owner: Geography. Stable meaning, bounded coalesced role work and immutable applied deltas.
-- Personal root precedes all rows, then PC/Evidence/current sorted Content SHARE authorities.
-- No role call is inside a transaction; jobs/committed delta/receipt are atomic (pg-boss only).
-- Reads: caller/epoch, semantic object key, stable UUID pages, revision-indexed contiguous deltas.
-- Growth: <=1000 established objects/relations, bounded run contexts/proposals, retained delta audit.
-- Retention: every personal epoch/run/label/support/delta/job is erased; no scene cache or public seed.
-- Additive; existing processes ignore these rows. Cartographer default disabled; no paid permit.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema geography;
create table geography.runs (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),id uuid not null,desired_revision integer not null check(desired_revision>0),
 status text not null check(status in('queued','prepared','blocked','unknown','accepted','rejected','stale','insufficient')),
 claim_id uuid,claim_until timestamptz,context jsonb check(context is null or (jsonb_typeof(context)='object' and octet_length(context::text)<=524288)),
 proposal jsonb check(proposal is null or (jsonb_typeof(proposal)='object' and octet_length(proposal::text)<=65536)),
 attempt_id uuid,outcome text check(outcome is null or length(outcome)<=100),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(universe_id,id),unique(universe_id,privacy_epoch,id),check((claim_id is null)=(claim_until is null))
);
create unique index geography_active_run on geography.runs(universe_id,privacy_epoch) where status in('queued','prepared','blocked','unknown');
create table geography.state (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),revision integer not null default 0 check(revision>=0),
 structure_revision integer not null default 0 check(structure_revision>=0 and structure_revision<=revision),
 activity_revision integer not null default 0 check(activity_revision>=0 and activity_revision<=revision),
 desired_revision integer not null default 0 check(desired_revision>=0),material_revision integer not null default 0 check(material_revision>=0),
 published_revision integer not null default 0 check(published_revision>=0 and published_revision<=revision),active_run_id uuid,
 primary key(universe_id,privacy_epoch),foreign key(universe_id,privacy_epoch,active_run_id) references geography.runs(universe_id,privacy_epoch,id) on delete restrict
);
create table geography.objects (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),id uuid not null,semantic_key text not null check(length(semantic_key) between 1 and 240),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384),
 support_refs jsonb not null check(jsonb_typeof(support_refs)='array' and jsonb_array_length(support_refs)<=100 and octet_length(support_refs::text)<=32768),
 primary key(universe_id,id),unique(universe_id,privacy_epoch,semantic_key)
);
create index geography_object_page on geography.objects(universe_id,privacy_epoch,id);
create table geography.relations (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),id uuid not null,semantic_key text not null check(length(semantic_key) between 1 and 500),
 kind text not null check(kind in('route','alias')),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384),
 support_refs jsonb not null check(jsonb_typeof(support_refs)='array' and jsonb_array_length(support_refs)<=100 and octet_length(support_refs::text)<=32768),
 primary key(universe_id,id),unique(universe_id,privacy_epoch,semantic_key)
);
create table geography.deltas (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),revision integer not null check(revision>0),transition_id uuid not null,
 run_id uuid not null,policy_version text not null check(policy_version='geography-passive.v1'),input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=131072),
 primary key(universe_id,privacy_epoch,revision),unique(universe_id,transition_id),
 foreign key(universe_id,privacy_epoch,run_id) references geography.runs(universe_id,privacy_epoch,id) on delete restrict
);
-- Accepted effects and their original identity are stable. Erasure may DELETE personal rows;
-- updates cannot rewrite an applied transition or turn a label/activity change into formation.
create function geography.guard_delta() returns trigger language plpgsql as $$
begin raise exception 'GEOGRAPHY_DELTA_IMMUTABLE' using errcode='23514'; end $$;
create trigger geography_delta_immutable before update on geography.deltas for each row execute function geography.guard_delta();
create function geography.guard_place() returns trigger language plpgsql as $$
begin
 if (new.universe_id,new.privacy_epoch,new.id,new.semantic_key) is distinct from (old.universe_id,old.privacy_epoch,old.id,old.semantic_key)
 or (new.payload-array['label','objectRevision','activity']) is distinct from (old.payload-array['label','objectRevision','activity'])
 then raise exception 'GEOGRAPHY_IDENTITY_IMMUTABLE' using errcode='23514'; end if;
 return new;
end $$;
create trigger geography_place_identity before update on geography.objects for each row execute function geography.guard_place();
create function geography.guard_relation() returns trigger language plpgsql as $$
begin
 if (new.universe_id,new.privacy_epoch,new.id,new.semantic_key,new.kind) is distinct from (old.universe_id,old.privacy_epoch,old.id,old.semantic_key,old.kind)
 or (new.payload-array['status','relationRevision']) is distinct from (old.payload-array['status','relationRevision'])
 then raise exception 'GEOGRAPHY_RELATION_IMMUTABLE' using errcode='23514'; end if;
 return new;
end $$;
create trigger geography_relation_identity before update on geography.relations for each row execute function geography.guard_relation();
