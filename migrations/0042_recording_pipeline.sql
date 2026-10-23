-- Recording pipeline prerequisite (#381), reviewed recording-pipeline-design.v4.
-- Owners: Experience immutable command/offer origins and generation segments; Evidence recorder
-- sessions/source heads/effective credit; PC source heads and effective structural/coverage state.
-- Queries: exact (universe,epoch,exposure,generation), one asset/channel pointer, indexed actual
-- activation predecessor, <=100 reconcile IDs, <=16 topic/binding rows and bounded proof sentinels.
-- Growth: eleven EMPTY tables; nine nullable/constant-default action-state columns and three
-- literal legacy1 audit columns. No historical initialization, generation scan, index rewrite,
-- event allowance reset, certification, root fanout, queued repair or second transport/outbox.
-- Retention: exploration state; Clear/full erase PC references/caches/heads before Evidence
-- heads/credit/sessions/audits, then Experience inputs/segments/origins before offers/receipts.
-- Saved and Identity account-lifetime recording policy/receipts keep their existing disposition.
-- Correction: current genuine root/generation only; sealed heads stay immutable. L/B false
-- overrides can correct old EFFECTIVE credit through exact origins, never rewrite old audits.
-- NULL asset/channel state is UNCERTIFIED, not false. Legacy certification is NOT installed.
-- Rollout: SOURCE prerequisite only. No API/UI/role activation; stop old unfenced writers before
-- election. All0001..0041 bytes remain exact. Bounded transactional DDL; no concurrent indexes.
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table evidence.observations add column recording_generation integer not null default 1;
alter table evidence.encounter_evidence add column recording_generation integer not null default 1;
alter table evidence.activity_revisions add column recording_generation integer not null default 1;
alter table evidence.observations add constraint observations_recording_generation
 check(recording_generation between 1 and 2147483647 and recording_generation%2=1) not valid;
alter table evidence.encounter_evidence add constraint encounter_evidence_recording_generation
 check(recording_generation between 1 and 2147483647 and recording_generation%2=1) not valid;
alter table evidence.activity_revisions add constraint activity_revisions_recording_generation
 check(recording_generation between 1 and 2147483647 and recording_generation%2=1) not valid;

create table experience.recording_command_origins (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), command_id uuid not null,
 operation text not null check(operation~'^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$' and length(operation)<=160),
 original_generation integer check(original_generation between 1 and 2147483647),
 eligible_generation integer check(eligible_generation between 1 and 2147483647 and eligible_generation%2=1),
 disposition_version integer not null default 1 check(disposition_version=1),
 recorded_at timestamptz not null,
 primary key(universe_id,command_id), unique(universe_id,privacy_epoch,command_id),
 foreign key(universe_id,command_id) references receipts.personal_commands(universe_id,command_id) on delete restrict,
 check(eligible_generation is null or eligible_generation=coalesce(original_generation,1))
);
create table experience.recording_offer_origins (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), offer_id uuid not null,
 original_command_id uuid not null,
 eligible_generation integer check(eligible_generation between 1 and 2147483647 and eligible_generation%2=1),
 primary key(universe_id,offer_id),
 foreign key(universe_id,privacy_epoch,offer_id) references experience.offers(universe_id,privacy_epoch,id) on delete restrict,
 foreign key(universe_id,privacy_epoch,original_command_id)
  references experience.recording_command_origins(universe_id,privacy_epoch,command_id) on delete restrict
);
create index recording_offer_command on experience.recording_offer_origins(universe_id,privacy_epoch,original_command_id,offer_id);

create table experience.recording_segments (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 recording_generation integer not null check(recording_generation between 1 and 2147483647 and recording_generation%2=1),
 asset_id uuid not null, asset_revision integer not null check(asset_revision>=1),
 kind text not null check(kind in('reel','scroll')),
 explanation_unit_id text not null check(length(explanation_unit_id) between 1 and 160),
 attribution_version text not null default 'recording-attribution.v1' check(attribution_version='recording-attribution.v1'),
 attribution_sha256 text not null check(attribution_sha256~'^[0-9a-f]{64}$'),
 attribution_payload jsonb not null check(jsonb_typeof(attribution_payload)='object' and octet_length(attribution_payload::text)<=16384
  and case when jsonb_typeof(attribution_payload->'topics')='array' then jsonb_array_length(attribution_payload->'topics')<=16 else false end
  and case when jsonb_typeof(attribution_payload->'facets')='array' then jsonb_array_length(attribution_payload->'facets')<=16 else false end),
 initialized_at timestamptz not null,
 first_eligible_activation_at timestamptz,
 first_eligible_activation_command_id uuid,
 primary key(universe_id,exposure_id,recording_generation),
 unique(universe_id,privacy_epoch,exposure_id,recording_generation),
 foreign key(universe_id,exposure_id) references experience.exposures(universe_id,id) on delete restrict,
 foreign key(asset_id,asset_revision) references content.asset_revisions(asset_id,revision) on delete restrict,
 foreign key(universe_id,privacy_epoch,first_eligible_activation_command_id)
  references experience.recording_command_origins(universe_id,privacy_epoch,command_id) on delete restrict,
 check((first_eligible_activation_at is null)=(first_eligible_activation_command_id is null))
);
create index recording_segment_actual_activation on experience.recording_segments
 (universe_id,privacy_epoch,recording_generation,explanation_unit_id,first_eligible_activation_at desc,exposure_id)
 where first_eligible_activation_at is not null;
create index recording_segment_reconcile on experience.recording_segments(universe_id,privacy_epoch,recording_generation,exposure_id);
-- Routing facts span retained generations; correction-only descriptors are not encounters.
create index recording_routing_recent on experience.recording_segments
 (universe_id,privacy_epoch,first_eligible_activation_at desc,exposure_id,recording_generation)
 where first_eligible_activation_at is not null;
create index recording_routing_unit on experience.recording_segments
 (universe_id,privacy_epoch,explanation_unit_id,first_eligible_activation_at desc,exposure_id,recording_generation)
 where first_eligible_activation_at is not null;
create index recording_routing_facets on experience.recording_segments using gin
 ((attribution_payload->'facets') jsonb_path_ops)
 where first_eligible_activation_at is not null;

create table experience.recording_segment_inputs (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 recording_generation integer not null check(recording_generation between 1 and 2147483647 and recording_generation%2=1),
 saved_override boolean, liked_override boolean,
 saved_decision_action_id uuid, liked_decision_action_id uuid,
 saved_origin_action_id uuid, liked_origin_action_id uuid,
 saved_origin_generation integer check(saved_origin_generation between 1 and 2147483647 and saved_origin_generation%2=1),
 liked_origin_generation integer check(liked_origin_generation between 1 and 2147483647 and liked_origin_generation%2=1),
 horizontal boolean not null default false, returned boolean not null default false,
 action_revision integer not null default 0 check(action_revision>=0),
 navigation_revision integer not null default 0 check(navigation_revision>=0),
 primary key(universe_id,exposure_id,recording_generation),
 foreign key(universe_id,privacy_epoch,exposure_id,recording_generation)
  references experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation) on delete restrict,
 foreign key(universe_id,saved_decision_action_id) references experience.actions(universe_id,id) on delete restrict deferrable initially deferred,
 foreign key(universe_id,liked_decision_action_id) references experience.actions(universe_id,id) on delete restrict deferrable initially deferred,
 foreign key(universe_id,saved_origin_action_id) references experience.actions(universe_id,id) on delete restrict,
 foreign key(universe_id,liked_origin_action_id) references experience.actions(universe_id,id) on delete restrict,
 check((saved_override is null)=(saved_decision_action_id is null)),
 check((liked_override is null)=(liked_decision_action_id is null)),
 check((saved_override is null)=(saved_origin_action_id is null)),
 check((liked_override is null)=(liked_origin_action_id is null)),
 check((saved_origin_action_id is null)=(saved_origin_generation is null)),
 check((liked_origin_action_id is null)=(liked_origin_generation is null))
);

create table evidence.recording_sessions (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), session_id uuid not null,
 exposure_id uuid not null,
 recording_generation integer not null check(recording_generation between 1 and 2147483647 and recording_generation%2=1),
 activation_command_id uuid not null, server_started_at timestamptz not null,
 primary key(universe_id,session_id),
 foreign key(universe_id,privacy_epoch,exposure_id,recording_generation)
  references experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation) on delete restrict,
 foreign key(universe_id,privacy_epoch,activation_command_id)
  references experience.recording_command_origins(universe_id,privacy_epoch,command_id) on delete restrict,
 check(session_id=activation_command_id)
);
create index recording_session_exposure on evidence.recording_sessions(universe_id,exposure_id,recording_generation,session_id);
create table evidence.recording_segment_heads (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 recording_generation integer not null check(recording_generation between 1 and 2147483647 and recording_generation%2=1),
 qualification_id uuid, activity_id uuid,
 input_sha256 text not null check(input_sha256~'^[0-9a-f]{64}$'),
 source_vector jsonb not null check(jsonb_typeof(source_vector)='object' and octet_length(source_vector::text)<=4096),
 primary key(universe_id,exposure_id,recording_generation),
 foreign key(universe_id,privacy_epoch,exposure_id,recording_generation)
  references experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation) on delete restrict,
 foreign key(universe_id,qualification_id) references evidence.encounter_evidence(universe_id,id) on delete restrict,
 foreign key(universe_id,privacy_epoch,exposure_id,activity_id)
  references evidence.activity_revisions(universe_id,privacy_epoch,exposure_id,id) on delete restrict
);
create table evidence.recording_exposure_credit (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 working_generation integer not null check(working_generation between 1 and 2147483647 and working_generation%2=1),
 attribution_sha256 text not null check(attribution_sha256~'^[0-9a-f]{64}$'),
 policy_version text not null default 'recording-credit.v1' check(policy_version='recording-credit.v1'),
 frozen_base jsonb not null check(jsonb_typeof(frozen_base)='object' and octet_length(frozen_base::text)<=16384),
 last_effective jsonb not null check(jsonb_typeof(last_effective)='object' and octet_length(last_effective::text)<=16384),
 input_sha256 text not null check(input_sha256~'^[0-9a-f]{64}$'),
 source_vector jsonb not null check(jsonb_typeof(source_vector)='object' and octet_length(source_vector::text)<=4096),
 primary key(universe_id,exposure_id),
 foreign key(universe_id,privacy_epoch,exposure_id,working_generation)
  references experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation) on delete restrict
);

create table personal_context.recording_exposure_contributions (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 working_generation integer not null check(working_generation between 1 and 2147483647 and working_generation%2=1),
 explanation_unit_id text not null check(length(explanation_unit_id) between 1 and 160), qualified boolean not null,
 payload_version text not null default 'recording-personal-contribution.v1' check(payload_version='recording-personal-contribution.v1'),
 frozen_base jsonb not null check(jsonb_typeof(frozen_base)='object' and octet_length(frozen_base::text)<=16384),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384),
 input_sha256 text not null check(input_sha256~'^[0-9a-f]{64}$'),
 primary key(universe_id,exposure_id),
 foreign key(universe_id,privacy_epoch,exposure_id,working_generation)
  references experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation) on delete restrict
);
create index recording_context_unit on personal_context.recording_exposure_contributions
 (universe_id,privacy_epoch,explanation_unit_id,exposure_id) where qualified;
create table personal_context.recording_segment_heads (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 recording_generation integer not null check(recording_generation between 1 and 2147483647 and recording_generation%2=1),
 activity_id uuid not null, qualification_id uuid,
 explanation_unit_id text not null check(length(explanation_unit_id) between 1 and 160), qualified boolean not null,
 payload_version text not null default 'recording-personal-contribution.v1' check(payload_version='recording-personal-contribution.v1'),
 contribution jsonb not null check(jsonb_typeof(contribution)='object' and octet_length(contribution::text)<=16384),
 input_sha256 text not null check(input_sha256~'^[0-9a-f]{64}$'),
 coverage jsonb check(jsonb_typeof(coverage)='object' and octet_length(coverage::text)<=16384),
 coverage_sha256 text check(coverage_sha256~'^[0-9a-f]{64}$'),
 primary key(universe_id,exposure_id,recording_generation),
 unique(universe_id,privacy_epoch,exposure_id,recording_generation),
 unique(universe_id,privacy_epoch,exposure_id,recording_generation,activity_id,qualification_id,coverage_sha256),
 foreign key(universe_id,privacy_epoch,exposure_id,recording_generation)
  references experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation) on delete restrict,
 foreign key(universe_id,privacy_epoch,exposure_id,activity_id)
  references evidence.activity_revisions(universe_id,privacy_epoch,exposure_id,id) on delete restrict,
 foreign key(universe_id,qualification_id) references evidence.encounter_evidence(universe_id,id) on delete restrict,
 check((coverage is null)=(coverage_sha256 is null)),
 check(not qualified or qualification_id is not null)
);
create index recording_context_segment_unit on personal_context.recording_segment_heads
 (universe_id,privacy_epoch,explanation_unit_id,exposure_id,recording_generation) where qualified;
create table personal_context.recording_coverage_contributions (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 working_generation integer not null check(working_generation between 1 and 2147483647 and working_generation%2=1),
 policy_version text not null default 'recording-effective-coverage.v1' check(policy_version='recording-effective-coverage.v1'),
 input_sha256 text not null check(input_sha256~'^[0-9a-f]{64}$'),
 witnesses jsonb not null check(case when jsonb_typeof(witnesses)='array'
  then jsonb_array_length(witnesses)<=16 and octet_length(witnesses::text)<=32768 else false end),
 primary key(universe_id,exposure_id), unique(universe_id,privacy_epoch,exposure_id),
 foreign key(universe_id,privacy_epoch,exposure_id,working_generation)
  references experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation) on delete restrict
);
create table personal_context.recording_coverage_references (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 topic_id text not null check(length(topic_id) between 1 and 160),
 facet_id text not null check(length(facet_id) between 1 and 160),
 meaning_sha256 text not null check(meaning_sha256~'^[0-9a-f]{64}$'),
 explanation_unit_id text not null check(length(explanation_unit_id) between 1 and 160),
 truth_sha256 text not null check(truth_sha256~'^[0-9a-f]{64}$'),
 source_kind text not null check(source_kind in('legacy','segment')),
 source_generation integer not null check(source_generation between 1 and 2147483647 and source_generation%2=1),
 source_activity_id uuid not null, source_qualification_id uuid not null,
 source_certificate_sha256 text not null check(source_certificate_sha256~'^[0-9a-f]{64}$'),
 -- Nullable routing keys implement conditional RESTRICT FKs without indexing historical tables.
 source_segment_generation integer, source_legacy_exposure_id uuid,
 primary key(universe_id,privacy_epoch,exposure_id,topic_id,facet_id),
 foreign key(universe_id,privacy_epoch,exposure_id)
  references personal_context.recording_coverage_contributions(universe_id,privacy_epoch,exposure_id) on delete restrict,
 foreign key(universe_id,privacy_epoch,exposure_id,source_segment_generation,source_activity_id,source_qualification_id,source_certificate_sha256)
  references personal_context.recording_segment_heads(universe_id,privacy_epoch,exposure_id,recording_generation,activity_id,qualification_id,coverage_sha256)
  on delete restrict deferrable initially deferred,
 foreign key(universe_id,privacy_epoch,source_legacy_exposure_id)
  references personal_context.coverage_contributions(universe_id,privacy_epoch,exposure_id) on delete restrict,
 foreign key(universe_id,privacy_epoch,exposure_id,source_activity_id)
  references evidence.activity_revisions(universe_id,privacy_epoch,exposure_id,id) on delete restrict,
 foreign key(universe_id,source_qualification_id) references evidence.encounter_evidence(universe_id,id) on delete restrict,
 check((source_kind='segment' and source_segment_generation is not null and source_segment_generation=source_generation and source_legacy_exposure_id is null)
  or(source_kind='legacy' and source_generation=1 and source_segment_generation is null and source_legacy_exposure_id is not null and source_legacy_exposure_id=exposure_id))
);
create index recording_coverage_reference_probe on personal_context.recording_coverage_references
 (universe_id,privacy_epoch,topic_id,facet_id,explanation_unit_id,exposure_id);

alter table experience.action_state
 add column recording_saved_state boolean,
 add column recording_saved_origin_exposure_id uuid,
 add column recording_saved_origin_action_id uuid,
 add column recording_saved_decision_action_id uuid,
 add column recording_liked_state boolean,
 add column recording_liked_origin_exposure_id uuid,
 add column recording_liked_origin_action_id uuid,
 add column recording_liked_decision_action_id uuid,
 add column recording_channel_revision integer not null default 0;
alter table experience.action_state add constraint recording_channel_revision_range check(recording_channel_revision>=0
 and(recording_saved_state is not null or recording_liked_state is not null or recording_channel_revision=0)) not valid;
alter table experience.action_state add constraint recording_saved_pointer_shape check(
 (recording_saved_origin_exposure_id is null)=(recording_saved_origin_action_id is null)
 and(recording_saved_state is true or(recording_saved_origin_exposure_id is null and recording_saved_origin_action_id is null))
 and(recording_saved_state is null)=(recording_saved_decision_action_id is null)) not valid;
alter table experience.action_state add constraint recording_liked_pointer_shape check(
 (recording_liked_origin_exposure_id is null)=(recording_liked_origin_action_id is null)
 and(recording_liked_state is true or(recording_liked_origin_exposure_id is null and recording_liked_origin_action_id is null))
 and(recording_liked_state is null)=(recording_liked_decision_action_id is null)) not valid;
alter table experience.action_state add constraint recording_saved_origin_exposure_fk foreign key(universe_id,recording_saved_origin_exposure_id)
 references experience.exposures(universe_id,id) on delete restrict not valid;
alter table experience.action_state add constraint recording_liked_origin_exposure_fk foreign key(universe_id,recording_liked_origin_exposure_id)
 references experience.exposures(universe_id,id) on delete restrict not valid;
alter table experience.action_state add constraint recording_saved_origin_action_fk foreign key(universe_id,recording_saved_origin_action_id)
 references experience.actions(universe_id,id) on delete restrict not valid;
alter table experience.action_state add constraint recording_liked_origin_action_fk foreign key(universe_id,recording_liked_origin_action_id)
 references experience.actions(universe_id,id) on delete restrict not valid;
alter table experience.action_state add constraint recording_saved_decision_action_fk foreign key(universe_id,recording_saved_decision_action_id)
 references experience.actions(universe_id,id) on delete restrict deferrable initially deferred not valid;
alter table experience.action_state add constraint recording_liked_decision_action_fk foreign key(universe_id,recording_liked_decision_action_id)
 references experience.actions(universe_id,id) on delete restrict deferrable initially deferred not valid;

-- SQL integrity supplements, never substitutes for the runtime RecordingScopeTx capability.
-- Lock only this same personal root; account UPDATE fencing remains the Identity adapter's job.
create function experience.require_recording_generation(u uuid, epoch integer, g integer)
 returns void language plpgsql set search_path=pg_catalog as $$
declare root identity.universes%rowtype;
begin
 select * into root from identity.universes where id=u for no key update;
 if not found or root.status<>'active' or root.clear_operation_id is not null
  or root.privacy_epoch<>epoch or not root.recording_on or root.recording_generation<>g
  or not exists(select 1 from identity.accounts where id=root.account_id and status='active') then
  raise check_violation using message='recording_scope_not_current';
 end if;
end $$;

create function experience.guard_recording_command_origin() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='UPDATE' then raise check_violation using message='recording_origin_immutable'; end if;
 if not exists(select 1 from receipts.personal_commands r where r.universe_id=new.universe_id
  and r.command_id=new.command_id and r.privacy_epoch=new.privacy_epoch and r.operation=new.operation) then
  raise check_violation using message='recording_origin_receipt';
 end if;
 if new.eligible_generation is not null then
  perform experience.require_recording_generation(new.universe_id,new.privacy_epoch,new.eligible_generation);
 end if;
 return new;
end $$;
create trigger recording_command_origin_guard before insert or update on experience.recording_command_origins
 for each row execute function experience.guard_recording_command_origin();
create function experience.guard_recording_offer_origin() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='UPDATE' then raise check_violation using message='recording_offer_origin_immutable'; end if;
 if new.eligible_generation is not null then
  perform experience.require_recording_generation(new.universe_id,new.privacy_epoch,new.eligible_generation);
  if not exists(select 1 from experience.recording_command_origins c where c.universe_id=new.universe_id
   and c.privacy_epoch=new.privacy_epoch and c.command_id=new.original_command_id
   and c.eligible_generation=new.eligible_generation) then
   raise check_violation using message='recording_offer_origin_upgrade';
  end if;
 end if;
 -- Same held root serializes inserts. The new index bounds this probe before counting.
 if (select count(*) from(select 1 from experience.recording_offer_origins o where o.universe_id=new.universe_id
  and o.privacy_epoch=new.privacy_epoch and o.original_command_id=new.original_command_id limit 3) existing)>=3 then
  raise check_violation using message='recording_offer_origin_limit';
 end if;
 return new;
end $$;
create trigger recording_offer_origin_guard before insert or update on experience.recording_offer_origins
 for each row execute function experience.guard_recording_offer_origin();

create function experience.guard_recording_segment() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 perform experience.require_recording_generation(new.universe_id,new.privacy_epoch,new.recording_generation);
 if tg_op='UPDATE' and
  (to_jsonb(new)-array['first_eligible_activation_at','first_eligible_activation_command_id'])
  is distinct from(to_jsonb(old)-array['first_eligible_activation_at','first_eligible_activation_command_id']) then
  raise check_violation using message='recording_segment_identity_immutable';
 end if;
 if tg_op='UPDATE' and old.first_eligible_activation_at is not null and
  (new.first_eligible_activation_at,new.first_eligible_activation_command_id)
  is distinct from(old.first_eligible_activation_at,old.first_eligible_activation_command_id) then
  raise check_violation using message='recording_activation_immutable';
 end if;
 if not exists(select 1 from experience.exposures x where x.universe_id=new.universe_id and x.id=new.exposure_id
  and x.privacy_epoch=new.privacy_epoch and x.asset_id=new.asset_id and x.asset_revision=new.asset_revision
  and x.kind=new.kind and x.activated_at is not null) then
  raise check_violation using message='recording_segment_exposure';
 end if;
 if new.first_eligible_activation_command_id is not null and not exists(
  select 1 from experience.recording_command_origins c where c.universe_id=new.universe_id
   and c.privacy_epoch=new.privacy_epoch and c.command_id=new.first_eligible_activation_command_id
   and c.eligible_generation=new.recording_generation
   and c.operation in('experience.activate-exposure','experience.activate-offer-v0')) then
  raise check_violation using message='recording_segment_activation_origin';
 end if;
 return new;
end $$;
create trigger recording_segment_guard before insert or update on experience.recording_segments
 for each row execute function experience.guard_recording_segment();
create function evidence.guard_recording_session() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='UPDATE' then raise check_violation using message='recording_session_immutable'; end if;
 perform experience.require_recording_generation(new.universe_id,new.privacy_epoch,new.recording_generation);
 if not exists(select 1 from experience.recording_command_origins c where c.universe_id=new.universe_id
  and c.privacy_epoch=new.privacy_epoch and c.command_id=new.activation_command_id
  and c.eligible_generation=new.recording_generation
  and c.operation in('experience.activate-exposure','experience.activate-offer-v0')) then
  raise check_violation using message='recording_session_activation_origin';
 end if;
 return new;
end $$;
create trigger recording_session_guard before insert or update on evidence.recording_sessions
 for each row execute function evidence.guard_recording_session();
-- Receipts are completed after effects; defer this exact original-command/exposure binding.
create function experience.guard_recording_activation_receipt() returns trigger language plpgsql set search_path=pg_catalog as $$
declare command uuid=(to_jsonb(new)->>tg_argv[0])::uuid;
begin
 if command is not null and not exists(select 1 from receipts.personal_commands r
  where r.universe_id=new.universe_id and r.privacy_epoch=new.privacy_epoch and r.command_id=command
   and r.operation in('experience.activate-exposure','experience.activate-offer-v0')
   and lower(r.outcome->>'exposureId')=new.exposure_id::text) then
  raise check_violation using message='recording_activation_receipt_exposure';
 end if;
 return new;
end $$;
create constraint trigger recording_segment_activation_receipt after insert or update on experience.recording_segments
 deferrable initially deferred for each row execute function experience.guard_recording_activation_receipt('first_eligible_activation_command_id');
create constraint trigger recording_session_activation_receipt after insert on evidence.recording_sessions
 deferrable initially deferred for each row execute function experience.guard_recording_activation_receipt('activation_command_id');

-- Exact indexed audit identity checks, not a latest-exposure semantic fallback or history scan.
create function evidence.require_recording_audits(u uuid, epoch integer, e uuid, g integer, q uuid, a uuid)
 returns void language plpgsql set search_path=pg_catalog as $$
begin
 if q is not null and not exists(select 1 from evidence.encounter_evidence r where r.universe_id=u and r.id=q
  and r.privacy_epoch=epoch and r.exposure_id=e and r.recording_generation=g) then
  raise check_violation using message='recording_qualification_identity';
 end if;
 if a is not null and not exists(select 1 from evidence.activity_revisions r where r.universe_id=u and r.id=a
  and r.privacy_epoch=epoch and r.exposure_id=e and r.recording_generation=g) then
  raise check_violation using message='recording_activity_identity';
 end if;
end $$;
create function experience.guard_recording_current_row() returns trigger language plpgsql set search_path=pg_catalog as $$
declare n jsonb=to_jsonb(new); o jsonb; g integer;
begin
 g=(n->>tg_argv[0])::integer;
 perform experience.require_recording_generation(new.universe_id,new.privacy_epoch,g);
 if n ? 'attribution_sha256' and not exists(select 1 from experience.recording_segments s
  where s.universe_id=new.universe_id and s.privacy_epoch=new.privacy_epoch and s.exposure_id=new.exposure_id
   and s.recording_generation=g and s.attribution_sha256=n->>'attribution_sha256') then
  raise check_violation using message='recording_effective_attribution_identity';
 end if;
 if n ? 'explanation_unit_id' and not exists(select 1 from experience.recording_segments s
  where s.universe_id=new.universe_id and s.privacy_epoch=new.privacy_epoch and s.exposure_id=new.exposure_id
   and s.recording_generation=g and s.explanation_unit_id=n->>'explanation_unit_id') then
  raise check_violation using message='recording_effective_unit_identity';
 end if;
 if tg_op='UPDATE' then
  o=to_jsonb(old);
  if (n->'universe_id',n->'privacy_epoch',n->'exposure_id')
   is distinct from(o->'universe_id',o->'privacy_epoch',o->'exposure_id')
   or(tg_argv[0]='recording_generation' and n->tg_argv[0] is distinct from o->tg_argv[0]) then
   raise check_violation using message='recording_row_identity_immutable';
  end if;
  if tg_argv[0]='working_generation' and g<(o->>tg_argv[0])::integer then
   raise check_violation using message='recording_effective_generation_regression';
  end if;
  if n ? 'attribution_sha256' and n->'attribution_sha256' is distinct from o->'attribution_sha256' then
   raise check_violation using message='recording_effective_attribution_immutable';
  end if;
  if n ? 'explanation_unit_id' and n->'explanation_unit_id' is distinct from o->'explanation_unit_id' then
   raise check_violation using message='recording_effective_unit_immutable';
  end if;
  if n ? 'frozen_base' then
   if g=(o->>tg_argv[0])::integer and n->'frozen_base' is distinct from o->'frozen_base' then
    raise check_violation using message='recording_frozen_base_immutable';
   elsif g<>(o->>tg_argv[0])::integer and
    n->'frozen_base' is distinct from coalesce(o->'last_effective',o->'payload') then
    raise check_violation using message='recording_frozen_base_not_effective';
   end if;
  end if;
 end if;
 if n ? 'qualification_id' or n ? 'activity_id' then
  perform evidence.require_recording_audits(new.universe_id,new.privacy_epoch,new.exposure_id,g,
   (n->>'qualification_id')::uuid,(n->>'activity_id')::uuid);
 end if;
 return new;
end $$;
create trigger recording_inputs_current before insert or update on experience.recording_segment_inputs
 for each row execute function experience.guard_recording_current_row('recording_generation');
create trigger recording_evidence_head_current before insert or update on evidence.recording_segment_heads
 for each row execute function experience.guard_recording_current_row('recording_generation');
create trigger recording_credit_current before insert or update on evidence.recording_exposure_credit
 for each row execute function experience.guard_recording_current_row('working_generation');
create trigger recording_context_head_current before insert or update on personal_context.recording_segment_heads
 for each row execute function experience.guard_recording_current_row('recording_generation');
create trigger recording_context_credit_current before insert or update on personal_context.recording_exposure_contributions
 for each row execute function experience.guard_recording_current_row('working_generation');
create trigger recording_coverage_current before insert or update on personal_context.recording_coverage_contributions
 for each row execute function experience.guard_recording_current_row('working_generation');

-- Deferred exact action binding allows action/origin/link insertion in the same transaction.
-- No retrospective legacy origin is fabricated; a later certification protocol is unallocated.
create function experience.require_recording_action(u uuid, epoch integer, asset uuid, a uuid, g integer, kinds text[])
 returns void language plpgsql set search_path=pg_catalog as $$
begin
 if not exists(select 1 from experience.actions x join experience.recording_command_origins c
  on c.universe_id=x.universe_id and c.command_id=x.command_id and c.privacy_epoch=x.privacy_epoch
  where x.universe_id=u and x.id=a and x.privacy_epoch=epoch and x.asset_id=asset
   and x.kind=any(kinds) and c.eligible_generation=g) then
  raise check_violation using message='recording_action_origin_identity';
 end if;
end $$;
create function experience.guard_recording_input_origins() returns trigger language plpgsql set search_path=pg_catalog as $$
declare segment experience.recording_segments%rowtype; n jsonb=to_jsonb(new); channel text; a uuid; d uuid; g integer;
begin
 select * into strict segment from experience.recording_segments where universe_id=new.universe_id
  and exposure_id=new.exposure_id and recording_generation=new.recording_generation;
 foreach channel in array array['saved','liked'] loop
  d=(n->>(channel||'_decision_action_id'))::uuid;
  if d is not null then
   a=(n->>(channel||'_origin_action_id'))::uuid;
   g=(n->>(channel||'_origin_generation'))::integer;
   perform experience.require_recording_action(new.universe_id,new.privacy_epoch,segment.asset_id,d,new.recording_generation,
    case channel when 'saved' then array['save','unsave'] else array['like','unlike'] end);
   perform experience.require_recording_action(new.universe_id,new.privacy_epoch,segment.asset_id,a,g,
    case channel when 'saved' then array['save'] else array['like'] end);
   if not exists(select 1 from experience.action_links l where l.universe_id=new.universe_id
    and l.privacy_epoch=new.privacy_epoch and l.action_id=a and l.credited_exposure_id=new.exposure_id) then
    raise check_violation using message='recording_input_credited_exposure';
   end if;
  end if;
 end loop;
 if (new.horizontal or new.returned) and segment.first_eligible_activation_at is null then
  raise check_violation using message='recording_input_activation_missing';
 end if;
 return new;
end $$;
create constraint trigger recording_input_origins after insert or update on experience.recording_segment_inputs
 deferrable initially deferred for each row execute function experience.guard_recording_input_origins();

create function experience.guard_recording_channel_shape() returns trigger language plpgsql set search_path=pg_catalog as $$
declare n jsonb=to_jsonb(new); o jsonb; changed boolean;
begin
 if tg_op='UPDATE' then
  o=to_jsonb(old);
  if new.privacy_epoch<>old.privacy_epoch and
   (new.recording_saved_state is not null or new.recording_liked_state is not null or new.recording_channel_revision<>0) then
   raise check_violation using message='recording_channel_epoch_inheritance';
  end if;
  changed=(n-array['liked','hidden','saved_origin_exposure_id','liked_origin_exposure_id','saved_origin_action_id','liked_origin_action_id','recording_channel_revision'])
   is distinct from(o-array['liked','hidden','saved_origin_exposure_id','liked_origin_exposure_id','saved_origin_action_id','liked_origin_action_id','recording_channel_revision']);
  if new.privacy_epoch=old.privacy_epoch and changed then
   if(old.recording_saved_state is not null and new.recording_saved_state is null)
    or(old.recording_liked_state is not null and new.recording_liked_state is null)
    or old.recording_channel_revision=2147483647
    or new.recording_channel_revision::bigint<>old.recording_channel_revision::bigint+1 then
    raise check_violation using message='recording_channel_transition';
   end if;
  elsif new.privacy_epoch=old.privacy_epoch and new.recording_channel_revision<>old.recording_channel_revision then
   raise check_violation using message='recording_channel_revision_without_decision';
  end if;
 elsif(new.recording_saved_state is not null or new.recording_liked_state is not null) and new.recording_channel_revision<>1 then
  raise check_violation using message='recording_channel_initial_revision';
 end if;
 return new;
end $$;
create trigger recording_channel_shape before insert or update on experience.action_state
 for each row execute function experience.guard_recording_channel_shape();
create function experience.guard_recording_channel_origins() returns trigger language plpgsql set search_path=pg_catalog as $$
declare n jsonb=to_jsonb(new); o jsonb; channel text; a uuid; d uuid; e uuid; g integer;
begin
 if tg_op='UPDATE' then o=to_jsonb(old); end if;
 foreach channel in array array['saved','liked'] loop
  if tg_op='UPDATE' and(n->('recording_'||channel||'_state'),n->('recording_'||channel||'_origin_exposure_id'),
   n->('recording_'||channel||'_origin_action_id'),n->('recording_'||channel||'_decision_action_id')) is not distinct from
   (o->('recording_'||channel||'_state'),o->('recording_'||channel||'_origin_exposure_id'),
   o->('recording_'||channel||'_origin_action_id'),o->('recording_'||channel||'_decision_action_id')) then continue; end if;
  d=(n->>('recording_'||channel||'_decision_action_id'))::uuid;
  if d is null then continue; end if;
  select c.eligible_generation into g from experience.actions x join experience.recording_command_origins c
   on c.universe_id=x.universe_id and c.command_id=x.command_id and c.privacy_epoch=x.privacy_epoch
   where x.universe_id=new.universe_id and x.id=d;
  if g is null then raise check_violation using message='recording_channel_decision_ineligible'; end if;
  perform experience.require_recording_generation(new.universe_id,new.privacy_epoch,g);
  perform experience.require_recording_action(new.universe_id,new.privacy_epoch,new.asset_id,d,g,
   case channel when 'saved' then array['save','unsave'] else array['like','unlike'] end);
  a=(n->>('recording_'||channel||'_origin_action_id'))::uuid;
  e=(n->>('recording_'||channel||'_origin_exposure_id'))::uuid;
  if a is not null then
   if not exists(select 1 from experience.actions x join experience.recording_command_origins c
    on c.universe_id=x.universe_id and c.command_id=x.command_id and c.privacy_epoch=x.privacy_epoch
    join experience.action_links l on l.universe_id=x.universe_id and l.action_id=x.id and l.privacy_epoch=x.privacy_epoch
    join experience.exposures p on p.universe_id=l.universe_id and p.id=l.credited_exposure_id and p.privacy_epoch=l.privacy_epoch
    where x.universe_id=new.universe_id and x.privacy_epoch=new.privacy_epoch and x.id=a and x.asset_id=new.asset_id
     and x.kind=case channel when 'saved' then 'save' else 'like' end and c.eligible_generation is not null
     and l.credited_exposure_id=e and p.activated_at is not null) then
    raise check_violation using message='recording_channel_origin_lineage';
   end if;
  end if;
 end loop;
 return new;
end $$;
create constraint trigger recording_channel_origins after insert or update on experience.action_state
 deferrable initially deferred for each row execute function experience.guard_recording_channel_origins();

create function personal_context.guard_recording_coverage_reference() returns trigger language plpgsql set search_path=pg_catalog as $$
declare g integer;
begin
 select working_generation into strict g from personal_context.recording_coverage_contributions
  where universe_id=new.universe_id and privacy_epoch=new.privacy_epoch and exposure_id=new.exposure_id;
 perform experience.require_recording_generation(new.universe_id,new.privacy_epoch,g);
 perform evidence.require_recording_audits(new.universe_id,new.privacy_epoch,new.exposure_id,new.source_generation,
  new.source_qualification_id,new.source_activity_id);
 if not exists(select 1 from evidence.encounter_evidence q where q.universe_id=new.universe_id
  and q.id=new.source_qualification_id and q.qualification='qualified') then
  raise check_violation using message='recording_coverage_source_unqualified';
 end if;
 if new.source_kind='legacy' and not exists(select 1 from personal_context.coverage_contributions c
  where c.universe_id=new.universe_id and c.privacy_epoch=new.privacy_epoch and c.exposure_id=new.exposure_id
   and c.activity_id=new.source_activity_id and c.payload#>>'{evidence,id}'=new.source_qualification_id::text) then
  raise check_violation using message='recording_legacy_coverage_source';
 end if;
 return new;
end $$;
create trigger recording_coverage_reference_guard before insert or update on personal_context.recording_coverage_references
 for each row execute function personal_context.guard_recording_coverage_reference();
