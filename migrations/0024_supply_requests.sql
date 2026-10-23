-- Supply private demand/waiter bindings and independently public canonical matching work.
-- Owner: modules/supply; Content availability counters below belong to Content.
-- Queries: owned request UUID/epoch; unique active canonical key. No private context in work.
-- Growth: one bounded private row per deliberate ask, retained until personal erasure; shared
-- canonical work retained independently. No attempts, provider grant, or production outbox.
-- Root -> private demand -> sorted Content SHARE -> matching work. No cross-person lock.
-- Additive rollout; resolver cannot dispatch providers. Existing Content open/discovery unchanged.
set local lock_timeout='5s';
set local statement_timeout='60s';
create schema supply;
create table supply.work (
 id uuid primary key,
 canonical_key text not null check(canonical_key ~ '^[0-9a-f]{64}$'),
 brief jsonb not null check(jsonb_typeof(brief)='object' and octet_length(brief::text)<=4096),
 active boolean not null default true,
 created_at timestamptz not null default now(),
 closed_at timestamptz,
 check(active=(closed_at is null))
);
create unique index supply_active_key on supply.work(canonical_key) where active;
create table supply.requests (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),
 id uuid not null,
 command jsonb not null check(jsonb_typeof(command)='object' and octet_length(command::text)<=16384),
 state text not null check(state in('requested','ready','unavailable','cancelled')),
 request_revision integer not null check(request_revision>0),
 revision integer not null check(revision>=0),
 decision text not null check(decision in('reuse','join','create','refuse')),
 work_id uuid references supply.work(id) on delete restrict,
 brief jsonb check(brief is null or (jsonb_typeof(brief)='object' and octet_length(brief::text)<=4096)),
 reason text check(reason in('unsupported_request','no_compatible_supply','not_permitted','budget_unavailable','could_not_prepare','source_unavailable')),
 content jsonb check(content is null or (jsonb_typeof(content)='object' and octet_length(content::text)<=32768)),
 content_availability_revision integer check(content_availability_revision>0),
 source_availability_revision integer check(source_availability_revision>0),
 created_at timestamptz not null,
 updated_at timestamptz not null,
 primary key(universe_id,id),
 check((state='ready')=(content is not null)),
 check((content is null)=(content_availability_revision is null)),
 check((state='unavailable')=(reason is not null)),
 check(state<>'requested' or (work_id is not null and brief is not null)),
 check(updated_at>=created_at)
);
create index supply_requests_owner_epoch on supply.requests(universe_id,privacy_epoch,created_at desc,id);

-- Current revision alone misses withdrawal/re-admission of the same immutable bytes. This
-- Content-owned counter permits read-only Supply snapshots to order those availability changes.
-- Integer overflow refuses the Content mutation rather than rounding a public revision.
alter table content.assets add column availability_revision integer not null default 1 check(availability_revision>0);
alter table content.assets add column availability_changed_at timestamptz not null default now();
create function content.advance_availability() returns trigger language plpgsql as $$
begin
 if new.status is distinct from old.status or new.revision is distinct from old.revision then
  new.availability_revision := old.availability_revision + 1;
  new.availability_changed_at := greatest(clock_timestamp(),old.availability_changed_at);
 else
  new.availability_revision := old.availability_revision;
  new.availability_changed_at := old.availability_changed_at;
 end if;
 return new;
end $$;
create trigger assets_availability before update on content.assets
 for each row execute function content.advance_availability();
