-- Owner: Planner/Geography personal roles and the personal Reasoning ledger (#381/#246).
-- Derived work origins, NOT collection authority or production/financial permission.
-- Exact existing state/run PK reads; all private payload/proof reads require a genuine current
-- RecordingScopeTx, own account/root/epoch and the actual owning module's purpose proof.
-- Growth: 30 additive columns on five existing tables; no new rows, tables, index or outbox.
-- Required pg-boss work and run wake metadata commit together. No pg-boss history scan.
-- Retention: role rows erase across epochs; Reasoning proof redacts with its irreversible marker.
-- Rollout: all checks/FKs on old tables stay NOT VALID; no UPDATE/backfill/history validation.
-- NULL means unknown legacy, never current generation. Literal1 adoption requires genuine
-- actual1/on runtime proof. Old code on43 is unsupported; compatible consumers precede rollout.
-- These row guards supplement runtime capabilities; they cannot mint or certify provenance.
set local lock_timeout='5s';
set local statement_timeout='60s';


alter table planner.state
 add column desired_recording_generation integer,
 add column desired_origin_kind text,
 add column desired_origin_command_id uuid,
 add column desired_origin_source_revision integer,
 add constraint planner_desired_recording_shape check(
  (desired_recording_generation is null and desired_origin_kind is null
   and desired_origin_command_id is null and desired_origin_source_revision is null)
  or (desired_recording_generation is not null and desired_recording_generation between 1 and 2147483647
   and desired_recording_generation%2=1 and desired_origin_kind is not null
   and case desired_origin_kind
    when 'material' then desired_origin_command_id is null and desired_origin_source_revision is not null and desired_origin_source_revision>0
    when 'command' then desired_origin_command_id is not null and desired_origin_source_revision is null
    when 'legacy1' then desired_recording_generation=1 and desired_origin_command_id is null and desired_origin_source_revision is null
    else false end)
 ) not valid;

alter table planner.runs
 add column recording_account_id uuid,
 add column recording_generation integer,
 add column recording_origin_kind text,
 add column recording_origin_command_id uuid,
 add column recording_origin_source_revision integer,
 add column recording_context_sha256 text,
 add column recording_model_context_sha256 text,
 add column normal_wake_id uuid,
 add column claim_wake_claim_id uuid,
 add constraint planner_run_recording_origin_shape check(
  (recording_account_id is null and recording_generation is null and recording_origin_kind is null
   and recording_origin_command_id is null and recording_origin_source_revision is null)
  or (recording_account_id is not null and recording_generation is not null
   and recording_generation between 1 and 2147483647 and recording_generation%2=1
   and recording_origin_kind is not null and case recording_origin_kind
    when 'material' then recording_origin_command_id is null and recording_origin_source_revision is not null and recording_origin_source_revision>0
    when 'command' then recording_origin_command_id is not null and recording_origin_source_revision is null
    when 'legacy1' then recording_generation=1 and recording_origin_command_id is null and recording_origin_source_revision is null
    else false end)
 ) not valid,
 add constraint planner_run_recording_hash_shape check(
  (recording_context_sha256 is null and recording_model_context_sha256 is null
   and (recording_generation is null or context is null))
  or (recording_generation is not null and context is not null
   and recording_context_sha256 is not null and recording_model_context_sha256 is not null
   and recording_context_sha256~'^[0-9a-f]{64}$' and recording_model_context_sha256~'^[0-9a-f]{64}$')
 ) not valid,
 add constraint planner_run_recording_wake_shape check(
  claim_wake_claim_id is null or (claim_id is not null and claim_wake_claim_id=claim_id)
 ) not valid,
 add constraint planner_run_recording_account_fk foreign key(recording_account_id)
  references identity.accounts(id) on delete restrict not valid;

-- The birth origin stays fixed even when a queued run coalesces a newer source within SAMEg.
-- Frozen context/model hashes and their context become set-once. Claim/status/wake metadata
-- may change for necessary bookkeeping; an expired claim never becomes collection authority.
create function planner.guard_recording_run() returns trigger language plpgsql as $$
begin
 if old.recording_generation is not null and
  (new.universe_id,new.privacy_epoch,new.id,new.recording_account_id,new.recording_generation,
   new.recording_origin_kind,new.recording_origin_command_id,new.recording_origin_source_revision)
  is distinct from
  (old.universe_id,old.privacy_epoch,old.id,old.recording_account_id,old.recording_generation,
   old.recording_origin_kind,old.recording_origin_command_id,old.recording_origin_source_revision)
 then raise exception 'PERSONAL_ROLE_RECORDING_ORIGIN_IMMUTABLE' using errcode='23514'; end if;
 if old.recording_context_sha256 is not null and
  (new.recording_context_sha256,new.recording_model_context_sha256,new.context,new.context_version)
  is distinct from
  (old.recording_context_sha256,old.recording_model_context_sha256,old.context,old.context_version)
 then raise exception 'PERSONAL_ROLE_RECORDING_CONTEXT_IMMUTABLE' using errcode='23514'; end if;
 return new;
end $$;
create trigger planner_recording_run_guard before update on planner.runs
 for each row execute function planner.guard_recording_run();


alter table geography.state
 add column desired_recording_generation integer,
 add column desired_origin_kind text,
 add column desired_origin_command_id uuid,
 add column desired_origin_source_revision integer,
 add constraint geography_desired_recording_shape check(
  (desired_recording_generation is null and desired_origin_kind is null
   and desired_origin_command_id is null and desired_origin_source_revision is null)
  or (desired_recording_generation is not null and desired_recording_generation between 1 and 2147483647
   and desired_recording_generation%2=1 and desired_origin_kind is not null
   and case desired_origin_kind
    when 'material' then desired_origin_command_id is null and desired_origin_source_revision is not null and desired_origin_source_revision>0
    when 'command' then desired_origin_command_id is not null and desired_origin_source_revision is null
    when 'legacy1' then desired_recording_generation=1 and desired_origin_command_id is null and desired_origin_source_revision is null
    else false end)
 ) not valid;

alter table geography.runs
 add column recording_account_id uuid,
 add column recording_generation integer,
 add column recording_origin_kind text,
 add column recording_origin_command_id uuid,
 add column recording_origin_source_revision integer,
 add column recording_context_sha256 text,
 add column recording_model_context_sha256 text,
 add column normal_wake_id uuid,
 add column claim_wake_claim_id uuid,
 add constraint geography_run_recording_origin_shape check(
  (recording_account_id is null and recording_generation is null and recording_origin_kind is null
   and recording_origin_command_id is null and recording_origin_source_revision is null)
  or (recording_account_id is not null and recording_generation is not null
   and recording_generation between 1 and 2147483647 and recording_generation%2=1
   and recording_origin_kind is not null and case recording_origin_kind
    when 'material' then recording_origin_command_id is null and recording_origin_source_revision is not null and recording_origin_source_revision>0
    when 'command' then recording_origin_command_id is not null and recording_origin_source_revision is null
    when 'legacy1' then recording_generation=1 and recording_origin_command_id is null and recording_origin_source_revision is null
    else false end)
 ) not valid,
 add constraint geography_run_recording_hash_shape check(
  (recording_context_sha256 is null and recording_model_context_sha256 is null
   and (recording_generation is null or context is null))
  or (recording_generation is not null and context is not null
   and recording_context_sha256 is not null and recording_model_context_sha256 is not null
   and recording_context_sha256~'^[0-9a-f]{64}$' and recording_model_context_sha256~'^[0-9a-f]{64}$')
 ) not valid,
 add constraint geography_run_recording_wake_shape check(
  claim_wake_claim_id is null or (claim_id is not null and claim_wake_claim_id=claim_id)
 ) not valid,
 add constraint geography_run_recording_account_fk foreign key(recording_account_id)
  references identity.accounts(id) on delete restrict not valid;

-- The birth origin stays fixed even when a queued run coalesces a newer source within SAMEg.
-- Frozen context/model hashes and their context become set-once. Claim/status/wake metadata
-- may change for necessary bookkeeping; an expired claim never becomes collection authority.
create function geography.guard_recording_run() returns trigger language plpgsql as $$
begin
 if old.recording_generation is not null and
  (new.universe_id,new.privacy_epoch,new.id,new.recording_account_id,new.recording_generation,
   new.recording_origin_kind,new.recording_origin_command_id,new.recording_origin_source_revision)
  is distinct from
  (old.universe_id,old.privacy_epoch,old.id,old.recording_account_id,old.recording_generation,
   old.recording_origin_kind,old.recording_origin_command_id,old.recording_origin_source_revision)
 then raise exception 'PERSONAL_ROLE_RECORDING_ORIGIN_IMMUTABLE' using errcode='23514'; end if;
 if old.recording_context_sha256 is not null and
  (new.recording_context_sha256,new.recording_model_context_sha256,new.context)
  is distinct from
  (old.recording_context_sha256,old.recording_model_context_sha256,old.context)
 then raise exception 'PERSONAL_ROLE_RECORDING_CONTEXT_IMMUTABLE' using errcode='23514'; end if;
 return new;
end $$;
create trigger geography_recording_run_guard before update on geography.runs
 for each row execute function geography.guard_recording_run();


alter table reasoning.business_runs
 add column recording_account_id uuid,
 add column recording_generation integer,
 add column recording_context_sha256 text,
 add column recording_model_context_sha256 text,
 add constraint reasoning_personal_recording_proof_shape check(
  (recording_account_id is null and recording_generation is null
   and recording_context_sha256 is null and recording_model_context_sha256 is null)
  or (privacy_erased_at is null and recording_account_id is not null and recording_generation is not null
   and recording_generation between 1 and 2147483647 and recording_generation%2=1
   and owner_module in('planner','geography')
   and ((owner_module='planner' and purpose='personal-planner')
     or (owner_module='geography' and purpose='personal-cartographer'))
   and recording_context_sha256 is not null and recording_model_context_sha256 is not null
   and recording_context_sha256~'^[0-9a-f]{64}$' and recording_model_context_sha256~'^[0-9a-f]{64}$')
 ) not valid,
 add constraint reasoning_personal_recording_account_fk foreign key(recording_account_id)
  references identity.accounts(id) on delete restrict not valid;

-- Accounting can continue while recording is paused. Its immutable run identity stays intact.
-- Only irreversible personal redaction may remove these four proof fields; a marked NULL row
-- is erased, never adopted as legacy1. Existing erasure/usage/brake identities remain unchanged.
create function reasoning.guard_personal_recording_proof() returns trigger language plpgsql as $$
begin
 -- Redaction never rewrites the minimal accounting identity, including legacy rows.
 if (new.universe_id,new.id,new.privacy_epoch,new.owner_module)
  is distinct from (old.universe_id,old.id,old.privacy_epoch,old.owner_module)
 then raise exception 'PERSONAL_REASONING_ACCOUNTING_IDENTITY_IMMUTABLE' using errcode='23514'; end if;
 if new.privacy_erased_at is not null then
  if new.recording_account_id is not null or new.recording_generation is not null
   or new.recording_context_sha256 is not null or new.recording_model_context_sha256 is not null
  then raise exception 'PERSONAL_REASONING_ERASED_PROOF' using errcode='23514'; end if;
 elsif old.recording_generation is not null and
  (new.purpose,new.recording_account_id,new.recording_generation,
   new.recording_context_sha256,new.recording_model_context_sha256)
  is distinct from
  (old.purpose,old.recording_account_id,old.recording_generation,
   old.recording_context_sha256,old.recording_model_context_sha256)
 then raise exception 'PERSONAL_REASONING_RECORDING_PROOF_IMMUTABLE' using errcode='23514'; end if;
 return new;
end $$;
create trigger reasoning_personal_recording_proof_guard before update on reasoning.business_runs
 for each row execute function reasoning.guard_personal_recording_proof();
