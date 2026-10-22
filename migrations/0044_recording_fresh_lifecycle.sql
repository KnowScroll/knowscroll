-- Fresh lifecycle recording protocol v1 (#381). No legacy adoption/backfill/history scan.
-- Owners: Identity birth/current selective-Clear core witness; Experience per-asset/channel
-- certified_empty distinct from a real false decision. Two EMPTY eight-column tables and one
-- nullable mode column (17 columns). All0001..0043 immutable. Exact PK probes, <=2 corrections.
-- Clear core READY precedes barrier release; financial settlement remains independent.
-- Full erasure removes witnesses without recreating them. Necessary commands remain available.
-- Required rollout: stop/replace ALL incompatible writers and install the closed actual graph
-- before making fresh roots reachable. These guards do not sandbox hostile old aggregate SQL.
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Literal CHECK=1 format tag, never an increasing counter.
-- squawk-ignore prefer-bigint-over-smallint
alter table identity.universes add column recording_lifecycle_protocol smallint;
alter table identity.universes add constraint recording_lifecycle_protocol_version
 check(recording_lifecycle_protocol=1) not valid;
create table identity.recording_lifecycle_witnesses (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),
 account_id uuid not null references identity.accounts(id) on delete restrict,
 -- Literal CHECK=1 protocol tag, never an increasing counter.
 -- squawk-ignore prefer-bigint-over-smallint
 protocol_version smallint not null check(protocol_version=1),
 origin_kind text not null check(origin_kind in('birth','clear_core')),
 clear_operation_id uuid references identity.clear_operations(id) on delete restrict,
 registry_sha256 text not null check(registry_sha256='c21cc86efaa179b73e7d217b7250cba320bdd402a362df1a19266e893649720a'),
 verified_at timestamptz not null,
 primary key(universe_id,privacy_epoch),
 check((origin_kind='birth')=(clear_operation_id is null))
);
create table experience.recording_channel_certificates (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),
 asset_id uuid not null,
 channel text not null check(channel in('saved','liked')),
 initialized_generation integer not null check(initialized_generation between 1 and 2147483647 and initialized_generation%2=1),
 initialized_at timestamptz not null,
 initializing_action_id uuid not null,
 first_decision_action_id uuid,
 primary key(universe_id,privacy_epoch,asset_id,channel),
 foreign key(universe_id,privacy_epoch) references identity.recording_lifecycle_witnesses(universe_id,privacy_epoch) on delete restrict,
 foreign key(universe_id,initializing_action_id) references experience.actions(universe_id,id) on delete restrict deferrable initially deferred,
 foreign key(universe_id,first_decision_action_id) references experience.actions(universe_id,id) on delete restrict deferrable initially deferred
);
create function identity.guard_recording_lifecycle_root() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' then
  if new.recording_lifecycle_protocol is not null and
   (new.privacy_epoch<>1 or new.recording_generation<>1 or not new.recording_on or new.clear_operation_id is not null)
   then raise check_violation using message='recording_lifecycle_birth'; end if;
 else
  if old.recording_lifecycle_protocol=1 and
   (new.recording_lifecycle_protocol is distinct from old.recording_lifecycle_protocol or new.account_id<>old.account_id)
   then raise check_violation using message='recording_lifecycle_mode_immutable'; end if;
  if old.recording_lifecycle_protocol is null and new.recording_lifecycle_protocol is not null and not exists(
   select 1 from identity.recording_lifecycle_witnesses w join identity.clear_operations c on c.id=w.clear_operation_id
    where w.universe_id=new.id and w.privacy_epoch=new.privacy_epoch and w.account_id=new.account_id
     and w.origin_kind='clear_core' and c.scope_id=new.id and c.account_id=new.account_id
     and c.to_epoch=new.privacy_epoch and c.core_done_at is not null and old.clear_operation_id=c.id)
   then raise check_violation using message='recording_lifecycle_no_legacy_adoption'; end if;
 end if;
 return new;
end $$;
create trigger recording_lifecycle_root_guard before insert or update on identity.universes
 for each row execute function identity.guard_recording_lifecycle_root();
create function identity.guard_recording_lifecycle_witness() returns trigger language plpgsql set search_path=pg_catalog as $$
declare root identity.universes%rowtype;
begin
 if tg_op='UPDATE' then raise check_violation using message='recording_lifecycle_witness_immutable'; end if;
 select * into strict root from identity.universes where id=new.universe_id;
 if root.account_id<>new.account_id or root.privacy_epoch<>new.privacy_epoch or new.verified_at<>transaction_timestamp()
  then raise check_violation using message='recording_lifecycle_witness_binding'; end if;
 if new.origin_kind='birth' then
  -- Only the actual root INSERT trigger can issue birth, not a later metadata adoption.
  if pg_trigger_depth()<>2 or root.recording_lifecycle_protocol is distinct from 1 or root.privacy_epoch<>1
   or root.clear_operation_id is not null then raise check_violation using message='recording_lifecycle_birth_only'; end if;
 else
  if not exists(select 1 from identity.clear_operations c where c.id=new.clear_operation_id
   and c.id=root.clear_operation_id and c.account_id=new.account_id and c.scope_id=new.universe_id
   and c.to_epoch=new.privacy_epoch and c.core_done_at is not null)
   then raise check_violation using message='recording_lifecycle_clear_core'; end if;
 end if;
 return new;
end $$;
create trigger recording_lifecycle_witness_guard before insert or update on identity.recording_lifecycle_witnesses
 for each row execute function identity.guard_recording_lifecycle_witness();
create function identity.record_recording_birth() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if new.recording_lifecycle_protocol=1 then
  insert into identity.recording_lifecycle_witnesses values(new.id,new.privacy_epoch,new.account_id,1,'birth',null,
   'c21cc86efaa179b73e7d217b7250cba320bdd402a362df1a19266e893649720a',transaction_timestamp());
 end if;
 return new;
end $$;
create trigger recording_lifecycle_birth after insert on identity.universes for each row execute function identity.record_recording_birth();
create function identity.require_recording_lifecycle_ready() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 -- Ordinary writes after full erasure do not recreate a witness or stop necessary commands.
 if new.recording_lifecycle_protocol=1 and (tg_op='INSERT' or
  (old.clear_operation_id is not null and new.clear_operation_id is null)) and not exists(
   select 1 from identity.recording_lifecycle_witnesses w where w.universe_id=new.id
    and w.privacy_epoch=new.privacy_epoch and w.account_id=new.account_id and w.protocol_version=1)
  then raise check_violation using message='recording_lifecycle_ready_missing'; end if;
 return new;
end $$;
create constraint trigger recording_lifecycle_ready after insert or update on identity.universes
 deferrable initially deferred for each row execute function identity.require_recording_lifecycle_ready();
create function experience.require_fresh_recording_lifecycle(u uuid, epoch integer, g integer)
 returns void language plpgsql set search_path=pg_catalog as $$
begin
 perform experience.require_recording_generation(u,epoch,g);
 if not exists(select 1 from identity.universes r join identity.recording_lifecycle_witnesses w
  on w.universe_id=r.id and w.privacy_epoch=r.privacy_epoch and w.account_id=r.account_id
  where r.id=u and r.privacy_epoch=epoch and r.recording_lifecycle_protocol=1 and w.protocol_version=1)
  then raise check_violation using message='recording_lifecycle_unavailable'; end if;
end $$;
create function experience.guard_recording_channel_certificate() returns trigger language plpgsql set search_path=pg_catalog as $$
declare g integer; kinds text[];
begin
 kinds=case new.channel when 'saved' then array['save','unsave'] else array['like','unlike'] end;
 if tg_op='INSERT' then
  perform experience.require_fresh_recording_lifecycle(new.universe_id,new.privacy_epoch,new.initialized_generation);
  perform experience.require_recording_action(new.universe_id,new.privacy_epoch,new.asset_id,new.initializing_action_id,new.initialized_generation,kinds);
  if not exists(select 1 from experience.actions a where a.universe_id=new.universe_id and a.id=new.initializing_action_id
   and a.created_at=new.initialized_at) then raise check_violation using message='recording_channel_initializing_time'; end if;
 elsif (new.universe_id,new.privacy_epoch,new.asset_id,new.channel,new.initialized_generation,new.initialized_at,new.initializing_action_id)
  is distinct from(old.universe_id,old.privacy_epoch,old.asset_id,old.channel,old.initialized_generation,old.initialized_at,old.initializing_action_id)
  or old.first_decision_action_id is not null then
  raise check_violation using message='recording_channel_certificate_immutable';
 end if;
 if new.first_decision_action_id is not null then
  select c.eligible_generation into g from experience.actions a join experience.recording_command_origins c
   on c.universe_id=a.universe_id and c.command_id=a.command_id and c.privacy_epoch=a.privacy_epoch
   where a.universe_id=new.universe_id and a.id=new.first_decision_action_id;
  if g is null then raise check_violation using message='recording_channel_certificate_decision'; end if;
  perform experience.require_fresh_recording_lifecycle(new.universe_id,new.privacy_epoch,g);
  perform experience.require_recording_action(new.universe_id,new.privacy_epoch,new.asset_id,new.first_decision_action_id,g,kinds);
 end if;
 return new;
end $$;
create trigger recording_channel_certificate_guard before insert or update on experience.recording_channel_certificates
 for each row execute function experience.guard_recording_channel_certificate();
-- At commit the exact receipt must be completed, and certified_empty still has no channel state.
create function experience.check_recording_channel_certificate() returns trigger language plpgsql set search_path=pg_catalog as $$
declare c experience.recording_channel_certificates%rowtype; a experience.action_state%rowtype; n jsonb; action_id uuid;
begin
 select * into c from experience.recording_channel_certificates where universe_id=new.universe_id
  and privacy_epoch=new.privacy_epoch and asset_id=new.asset_id and channel=new.channel;
 if not found then return new; end if;
 foreach action_id in array array[c.initializing_action_id,c.first_decision_action_id] loop
  if action_id is null then continue; end if;
  if not exists(select 1 from experience.actions x join receipts.personal_commands r on r.universe_id=x.universe_id
   and r.command_id=x.command_id and r.privacy_epoch=x.privacy_epoch join experience.recording_command_origins o
   on o.universe_id=x.universe_id and o.command_id=x.command_id and o.privacy_epoch=x.privacy_epoch
   where x.universe_id=c.universe_id and x.id=action_id and o.operation=r.operation and r.outcome is not null and (
    (r.operation in('experience.apply-action','experience.encounter-action-v0')
     and (r.outcome->>'actionId')::uuid=x.id and (r.outcome->>'assetId')::uuid=x.asset_id
     and (r.outcome->>'assetRevision')::integer=x.asset_revision and r.outcome->>'kind'=x.kind)
    or(r.operation='experience.keep-entry-remove' and x.kind='unsave'
     and r.outcome->>'version'='keep-remove.v1' and r.outcome->>'outcome'='accepted'
     and (r.outcome->>'commandId')::uuid=x.command_id and (r.outcome->'entry'->>'assetId')::uuid=x.asset_id
     and (r.outcome->'entry'->>'assetRevision')::integer=x.asset_revision)))
   then raise check_violation using message='recording_channel_certificate_receipt'; end if;
 end loop;
 select * into a from experience.action_state where universe_id=c.universe_id and privacy_epoch=c.privacy_epoch and asset_id=c.asset_id;
 n=to_jsonb(a);
 if (c.first_decision_action_id is null) is distinct from ((n->>('recording_'||c.channel||'_state')) is null)
  then raise check_violation using message='recording_channel_empty_pointer'; end if;
 return new;
end $$;
create constraint trigger recording_channel_certificate_complete after insert or update on experience.recording_channel_certificates
 deferrable initially deferred for each row execute function experience.check_recording_channel_certificate();
-- Every changed real pointer on a fresh root needs its exact current epoch certificate.
create function experience.check_fresh_recording_pointer() returns trigger language plpgsql set search_path=pg_catalog as $$
declare v_channel text; n jsonb; a experience.action_state%rowtype; c experience.recording_channel_certificates%rowtype;
begin
 if not exists(select 1 from identity.universes where id=new.universe_id and recording_lifecycle_protocol=1) then return new; end if;
 select * into a from experience.action_state where universe_id=new.universe_id and asset_id=new.asset_id;
 if not found then return new; end if;
 n=to_jsonb(a);
 foreach v_channel in array array['saved','liked'] loop
  if n->>('recording_'||v_channel||'_state') is null then continue; end if;
  select * into c from experience.recording_channel_certificates t where t.universe_id=a.universe_id
   and t.privacy_epoch=a.privacy_epoch and t.asset_id=a.asset_id and t.channel=v_channel;
  if not found or c.first_decision_action_id is null then
   raise check_violation using message='recording_fresh_pointer_certificate'; end if;
 end loop;
 return new;
end $$;
create constraint trigger recording_fresh_pointer_certificate after insert or update on experience.action_state
 deferrable initially deferred for each row execute function experience.check_fresh_recording_pointer();
-- A positive effective L/B selects the one exact pointer origin; old source audits remain sealed.
create function evidence.check_fresh_recording_credit() returns trigger language plpgsql set search_path=pg_catalog as $$
declare segment experience.recording_segments%rowtype; v_channel text; key text; a experience.action_state%rowtype;
 credit evidence.recording_exposure_credit%rowtype;
begin
 if not exists(select 1 from identity.universes where id=new.universe_id and recording_lifecycle_protocol=1) then return new; end if;
 select * into credit from evidence.recording_exposure_credit where universe_id=new.universe_id and exposure_id=new.exposure_id;
 if not found then return new; end if;
 select * into strict segment from experience.recording_segments where universe_id=credit.universe_id
  and exposure_id=credit.exposure_id and recording_generation=credit.working_generation;
 foreach v_channel in array array['saved','liked'] loop
  key=case v_channel when 'saved' then 'B' else 'L' end;
  if credit.last_effective->'channels'->>key is distinct from 'true' then continue; end if;
  select * into a from experience.action_state where universe_id=credit.universe_id and privacy_epoch=credit.privacy_epoch and asset_id=segment.asset_id;
  if not found or to_jsonb(a)->>('recording_'||v_channel||'_state') is distinct from 'true'
   or(to_jsonb(a)->>('recording_'||v_channel||'_origin_exposure_id'))::uuid is distinct from credit.exposure_id
   or not exists(select 1 from experience.recording_channel_certificates c where c.universe_id=credit.universe_id
    and c.privacy_epoch=credit.privacy_epoch and c.asset_id=segment.asset_id and c.channel=v_channel and c.first_decision_action_id is not null)
   then raise check_violation using message='recording_fresh_credit_origin'; end if;
 end loop;
 return new;
end $$;
create constraint trigger recording_fresh_credit_origin after insert or update on evidence.recording_exposure_credit
 deferrable initially deferred for each row execute function evidence.check_fresh_recording_credit();
