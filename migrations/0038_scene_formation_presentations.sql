-- Scenes owns one immutable minimized delivery fact per actual creation transition and one
-- monotonic claim/terminal state. This is not formation/learning authority or a second outbox.
-- Reads: own epoch/latest or exact transition; global overdue100+one immutable ordinal seek.
-- Growth: one row per creation-bearing commit, max8 typed targets or an honest limit marker.
-- Retention: full/Clear erase ALL epochs plus exact expiry queue/dead-letter payloads. Global
-- recovery payloads contain only non-identifying ordinal watermarks, never personal UUIDs.
-- Lock order: personal root -> owned row; global page/required continuation commits BEFORE
-- any per-owner scope acquisition. No global transaction waits for a personal root.
-- Old0001--0037 bytes remain unchanged. No seed, model, role permission or historical bootstrap.
-- Rolling downgrade is unsupported; exact-schema activation must stop incompatible processes.
set local lock_timeout='5s';
set local statement_timeout='60s';

create table scenes.formation_presentations (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>0),transition_id uuid not null,
 presentation_key bigint generated always as identity unique,
 recorded_at timestamptz not null,geography_revision integer not null check(geography_revision>0),
 structure_revision integer not null check(structure_revision=geography_revision),
 activity_revision integer not null check(activity_revision>=0 and activity_revision<=geography_revision),
 target_count integer not null check(target_count between 1 and 1000),
 fact jsonb check(fact is null or (jsonb_typeof(fact)='object' and octet_length(fact::text)<=32768)),
 limited boolean not null,
 claim_id uuid,attempt_nonce uuid,claimed_at timestamptz,claim_expires_at timestamptz,
 disposition text check(disposition in('shown','skipped')),terminal_at timestamptz,
 primary key(universe_id,transition_id),
 foreign key(universe_id,transition_id) references geography.deltas(universe_id,transition_id) on delete restrict,
 foreign key(universe_id,privacy_epoch,geography_revision) references geography.deltas(universe_id,privacy_epoch,revision) on delete restrict,
 check((limited and target_count>8 and fact is null) or (not limited and target_count<=8 and fact is not null)),
 check((claim_id is null and attempt_nonce is null and claimed_at is null and claim_expires_at is null)
   or(claim_id is not null and attempt_nonce is not null and claimed_at is not null and claim_expires_at is not null and claim_expires_at=claimed_at+interval '30 seconds' and claimed_at>=recorded_at and claimed_at<recorded_at+interval '300 seconds' and not limited)),
 check((disposition is null and terminal_at is null) or (disposition is not null and terminal_at is not null and claim_id is not null and terminal_at>=claimed_at and (disposition<>'shown' or terminal_at<claim_expires_at)))
);
create index formation_latest_idx on scenes.formation_presentations(universe_id,privacy_epoch,recorded_at desc,presentation_key desc);
create unique index formation_claim_idx on scenes.formation_presentations(claim_id) where claim_id is not null;
create index formation_overdue_idx on scenes.formation_presentations(presentation_key) where claim_id is not null and disposition is null;

-- Validate exact committed identities at the recording boundary. The applier supplies actual
-- creation operations only; label/activity/route changes cannot manufacture a birth record.
create function scenes.guard_formation_presentation() returns trigger language plpgsql as $$
declare d jsonb;expected_targets jsonb;actual_targets jsonb;creation_count integer;
begin
 if tg_op='UPDATE' then
  if (new.universe_id,new.privacy_epoch,new.transition_id,new.presentation_key,new.recorded_at,new.geography_revision,new.structure_revision,new.activity_revision,new.target_count,new.fact,new.limited)
    is distinct from (old.universe_id,old.privacy_epoch,old.transition_id,old.presentation_key,old.recorded_at,old.geography_revision,old.structure_revision,old.activity_revision,old.target_count,old.fact,old.limited)
    or (old.claim_id is not null and (new.claim_id,new.attempt_nonce,new.claimed_at,new.claim_expires_at) is distinct from (old.claim_id,old.attempt_nonce,old.claimed_at,old.claim_expires_at))
    or (old.disposition is not null and (new.disposition,new.terminal_at) is distinct from (old.disposition,old.terminal_at))
  then raise exception 'FORMATION_STATE_IMMUTABLE' using errcode='23514';end if;
  return new;
 end if;
 if new.claim_id is not null or new.disposition is not null then raise exception 'FORMATION_INITIAL_STATE' using errcode='23514';end if;
 select payload into d from geography.deltas where universe_id=new.universe_id and privacy_epoch=new.privacy_epoch and transition_id=new.transition_id and revision=new.geography_revision;
 if d is null or (d->>'recordedAt')::timestamptz is distinct from new.recorded_at
   or (d->'geography'->>'structureRevision')::integer is distinct from new.structure_revision
   or (d->'geography'->>'activityRevision')::integer is distinct from new.activity_revision
 then raise exception 'FORMATION_COMMIT_IDENTITY' using errcode='23514';end if;
 select count(*)::integer,jsonb_agg(jsonb_build_object('objectId',x->'object'->'id','parentId',x->'object'->'parent'->'id','kind',x->'object'->'kind','objectRevision',x->'object'->'objectRevision','label',x->'object'->'label','truthStatus',x->'object'->'truthStatus') order by x->'object'->>'id')
 into creation_count,expected_targets from jsonb_array_elements(d->'operations') x where x->>'kind' in('create_system','establish_star','form_planet','add_region');
 if creation_count is distinct from new.target_count then raise exception 'FORMATION_COMMIT_IDENTITY' using errcode='23514';end if;
 if not new.limited then
  select jsonb_agg(x order by x->>'objectId') into actual_targets from jsonb_array_elements(new.fact->'targets') x;
  if actual_targets is distinct from expected_targets or new.fact->>'transitionId' is distinct from new.transition_id::text
    or (new.fact->>'recordedAt')::timestamptz is distinct from new.recorded_at or new.fact->'geography' is distinct from d->'geography'
  then raise exception 'FORMATION_COMMIT_IDENTITY' using errcode='23514';end if;
 end if;
 return new;
end $$;
create trigger guard_formation_presentation before insert or update on scenes.formation_presentations
for each row execute function scenes.guard_formation_presentation();

-- Actual creation-bearing delta and delivery fact commit together, even with an older writer.
-- Deferred so the normal apply callback can record after the owning delta insert. Old writers
-- fail closed rather than commit a birth that the once-only delivery protocol can never recover.
create function scenes.require_formation_fact() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from geography.deltas where universe_id=new.universe_id and transition_id=new.transition_id) then return new;end if;
 if exists(select 1 from jsonb_array_elements(new.payload->'operations') x where x->>'kind' in('create_system','establish_star','form_planet','add_region'))
  and not exists(select 1 from scenes.formation_presentations f where f.universe_id=new.universe_id and f.privacy_epoch=new.privacy_epoch and f.transition_id=new.transition_id)
 then raise exception 'FORMATION_PROTOCOL_REQUIRED' using errcode='23514';end if;
 return new;
end $$;
create constraint trigger require_formation_fact after insert on geography.deltas
 deferrable initially deferred for each row execute function scenes.require_formation_fact();
