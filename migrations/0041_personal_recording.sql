-- Identity owns recording policy on the existing personal root and immutable account commands.
-- Authoritative, initial1/on; parity and exact monotone boolean transitions are SQL-enforced.
-- Queries: root by UUID; command by (account_id,command_id), no scan/queue/second root.
-- Growth: two root fields, one bounded exact-body row per accepted command (including no-op).
-- Selective Clear retains both fields and these account-lifetime receipts; account deletion owns
-- their future explicit removal. No export/deletion executor or provider/accounting effect.
-- Rollout prerequisite only: all growth owners must carry/fence original generation before any
-- control is exposed. Old40 SQL is immutable; apply full0001..0041, never downgrade old writers.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table identity.universes add column recording_on boolean not null default true;
alter table identity.universes add column recording_generation integer not null default 1
  check(recording_generation between 1 and 2147483647);
-- Existing roots acquire literal1/true defaults, so parity already holds by construction.
-- NOT VALID avoids a historical root scan and still checks every inserted/updated row.
alter table identity.universes add constraint recording_parity
  check(recording_on=(recording_generation%2=1)) not valid;
create function identity.guard_recording_policy() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='INSERT' then
  if new.recording_generation<>1 or not new.recording_on then raise check_violation using message='recording_initial_policy'; end if;
 elsif (new.recording_on,new.recording_generation) is distinct from (old.recording_on,old.recording_generation) then
  if new.recording_on=old.recording_on or old.recording_generation=2147483647 or new.recording_generation::bigint<>old.recording_generation::bigint+1
   then raise check_violation using message='recording_monotone_transition'; end if;
 end if;
 return new;
end $$;
create trigger recording_policy_guard before insert or update on identity.universes
 for each row execute function identity.guard_recording_policy();
create table identity.recording_commands (
 account_id uuid not null references identity.accounts(id) on delete restrict,
 scope_id uuid not null references identity.universes(id) on delete restrict,
 command_id uuid not null,
 request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
 request_body jsonb not null check(octet_length(request_body::text)<=512),
 outcome_version integer not null default 1 check(outcome_version=1),
 requested_epoch integer not null check(requested_epoch>=1),
 requested_on boolean not null,
 from_generation integer not null check(from_generation>=1),
 to_generation integer not null check(to_generation>=1),
 changed boolean not null,
 recorded_at timestamptz not null,
 primary key(account_id,command_id),
 check((changed and from_generation<2147483647 and to_generation::bigint=from_generation::bigint+1)
   or (not changed and to_generation=from_generation)),
 check(requested_on=(to_generation%2=1)),
 check(request_body=jsonb_build_object('version','recording-policy.v1','commandId',request_body->>'commandId',
   'expectedPrivacyEpoch',requested_epoch,'expectedRecordingGeneration',from_generation,'on',requested_on)),
 check(request_body->>'commandId' is not null and (request_body->>'commandId')::uuid=command_id)
);
-- Bind to the current locked root after the policy/revision update, never a historical owner.
-- Receipt updates are forbidden. Deletion remains a future explicit account-owned lifecycle.
create function identity.guard_recording_command() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if tg_op='UPDATE' then raise check_violation using message='recording_receipt_immutable'; end if;
 if not exists(select 1 from identity.universes u join identity.accounts a on a.id=u.account_id
   where u.id=new.scope_id and u.account_id=new.account_id and u.privacy_epoch=new.requested_epoch
   and u.status='active' and a.status='active' and u.clear_operation_id is null
   and u.recording_generation=new.to_generation and u.recording_on=new.requested_on)
  then raise check_violation using message='recording_receipt_binding'; end if;
 return new;
end $$;
create trigger recording_command_guard before insert or update on identity.recording_commands
 for each row execute function identity.guard_recording_command();
