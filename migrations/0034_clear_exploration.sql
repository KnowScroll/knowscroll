-- Identity-owned account-lifetime Clear receipts and exact accounting identities.
-- Default inert: no operation/barrier/queue is installed by this migration.
-- Account deletion owns these minimal records; selective Clear retains them.
-- No request/output/context bytes, user text or accounting state machine changes.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table identity.universes add column clear_operation_id uuid;
create table identity.clear_operations (
 id uuid primary key,
 account_id uuid not null references identity.accounts(id) on delete restrict,
 scope_id uuid not null references identity.universes(id) on delete restrict,
 command_id uuid not null,
 request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
 outcome_version integer not null default 1 check (outcome_version = 1),
 from_epoch integer not null check (from_epoch >= 1 and from_epoch < 2147483647),
 to_epoch integer not null check (to_epoch = from_epoch + 1),
 recorded_at timestamptz not null default now(),
 phase text not null default 'removing_live_data'
   check (phase in ('removing_live_data', 'waiting_for_accounting', 'verifying_live_removal')),
 failure_code text check (failure_code in ('temporarily_unavailable', 'completion_unverified')),
 core_done_at timestamptz,
 completed_at timestamptz,
 constraint clear_operations_command_key unique(account_id, command_id),
 constraint clear_operations_completion_check check (completed_at is null or core_done_at is not null),
 constraint clear_operations_core_check check (core_done_at is null or phase <> 'removing_live_data')
);
-- New empty table: transactional index creation has no live rows to block.
create unique index clear_operations_one_core on identity.clear_operations(scope_id) where core_done_at is null;
create index clear_operations_latest on identity.clear_operations(account_id, to_epoch desc);
create table identity.clear_liabilities (
 operation_id uuid not null references identity.clear_operations(id) on delete restrict,
 account_id uuid not null references identity.accounts(id) on delete restrict,
 scope_id uuid not null references identity.universes(id) on delete restrict,
 attempt_id uuid not null,
 run_id uuid not null,
 role_id text not null check (octet_length(role_id) between 1 and 128),
 role_version text not null check (octet_length(role_version) between 1 and 128),
 provider text not null check (octet_length(provider) between 1 and 128),
 model text not null check (octet_length(model) between 1 and 128),
 budget_window date not null,
 reserved_tokens integer not null check (reserved_tokens >= 0),
 primary key(operation_id, attempt_id)
);
create function identity.guard_clear_operation() returns trigger language plpgsql as $$
begin
 if tg_op = 'INSERT' then
  if not exists(select 1 from identity.universes u where u.id=new.scope_id and u.account_id=new.account_id)
  then raise check_violation using message='clear_operation_owner_binding'; end if;
  return new;
 end if;
 if (new.id,new.account_id,new.scope_id,new.command_id,new.request_hash,new.outcome_version,
     new.from_epoch,new.to_epoch,new.recorded_at) is distinct from
    (old.id,old.account_id,old.scope_id,old.command_id,old.request_hash,old.outcome_version,
     old.from_epoch,old.to_epoch,old.recorded_at)
 then raise check_violation using message = 'clear_receipt_immutable'; end if;
 if old.core_done_at is not null and new.core_done_at is distinct from old.core_done_at
 then raise check_violation using message = 'clear_core_monotonic'; end if;
 if old.completed_at is not null and (new.completed_at is distinct from old.completed_at or new.failure_code is not null)
 then raise check_violation using message = 'clear_completion_monotonic'; end if;
 return new;
end $$;
create trigger clear_operation_guard before insert or update on identity.clear_operations
 for each row execute function identity.guard_clear_operation();
create function identity.guard_clear_barrier() returns trigger language plpgsql as $$
begin
 if new.clear_operation_id is not null and not exists (
  select 1 from identity.clear_operations o where o.id = new.clear_operation_id
   and o.account_id = new.account_id and o.scope_id = new.id
   and o.to_epoch = new.privacy_epoch and o.core_done_at is null)
 then raise check_violation using message = 'clear_barrier_binding'; end if;
 if old.clear_operation_id is not null and new.clear_operation_id is distinct from old.clear_operation_id
  and not exists (select 1 from identity.clear_operations o
   where o.id = old.clear_operation_id and o.core_done_at is not null)
 then raise check_violation using message = 'clear_barrier_incomplete'; end if;
 return new;
end $$;
create trigger clear_barrier_guard before update on identity.universes
 for each row execute function identity.guard_clear_barrier();
create function identity.guard_clear_liability() returns trigger language plpgsql as $$
begin
 if tg_op = 'UPDATE' then raise check_violation using message = 'clear_liability_immutable'; end if;
 if not exists (select 1 from identity.clear_operations o where o.id = new.operation_id
  and o.account_id = new.account_id and o.scope_id = new.scope_id and o.core_done_at is null)
 then raise check_violation using message = 'clear_liability_binding'; end if;
 return new;
end $$;
create trigger clear_liability_guard before insert or update on identity.clear_liabilities
 for each row execute function identity.guard_clear_liability();
