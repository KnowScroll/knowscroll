-- Identity-owned bounded recovery of durable Clear operations, not a second outbox.
-- pg-boss remains the only delivery queue. No normal queue is installed by this migration.
-- Preserve 0034 acceptance, epoch/barrier/core/completion and all accounting identities.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table identity.clear_operations
 add column recovery_after timestamptz,
 add column recovery_attempts integer not null default 0,
 add column cleanup_due_at timestamptz,
 add column cleanup_recovery_after timestamptz,
 add column cleanup_recovery_attempts integer not null default 0;
alter table identity.clear_operations
 add constraint clear_recovery_attempts_check check (
  recovery_attempts between 0 and 3 and cleanup_recovery_attempts between 0 and 3
 ) not valid,
 add constraint clear_cleanup_completion_check check (
  (cleanup_due_at is null or (core_done_at is not null and completed_at is not null))
  and (cleanup_recovery_after is null or cleanup_due_at is not null)
 ) not valid;
-- Backfill only minimal Identity-owned captured windows, never Reasoning/request/output tables.
-- An already-pruned set may receive a harmless exact-set verification; immutable receipts stay exact.
update identity.clear_operations o set cleanup_due_at = (
 select (max(l.budget_window) + 1)::timestamp at time zone 'UTC'
 from identity.clear_liabilities l where l.operation_id=o.id
) where o.completed_at is not null
 and exists(select 1 from identity.clear_liabilities l where l.operation_id=o.id);
-- squawk-ignore constraint-missing-not-valid
alter table identity.clear_operations validate constraint clear_recovery_attempts_check;
-- squawk-ignore constraint-missing-not-valid
alter table identity.clear_operations validate constraint clear_cleanup_completion_check;
-- Small account-lifetime operation index; bounded transactional migration, never concurrent DDL.
-- squawk-ignore require-concurrent-index-creation
create index clear_operations_recovery_due on identity.clear_operations(recovery_after,recorded_at,id)
 where completed_at is null and recovery_attempts < 3;
-- squawk-ignore require-concurrent-index-creation
create index clear_operations_cleanup_due on identity.clear_operations(cleanup_recovery_after,cleanup_due_at,id)
 where completed_at is not null and cleanup_due_at is not null and cleanup_recovery_attempts < 3;
create function identity.guard_clear_recovery() returns trigger language plpgsql as $$
begin
 if new.recovery_attempts < old.recovery_attempts or new.recovery_attempts > old.recovery_attempts+1
  or new.cleanup_recovery_attempts < old.cleanup_recovery_attempts
  or new.cleanup_recovery_attempts > old.cleanup_recovery_attempts+1
 then raise check_violation using message='clear_recovery_budget_monotonic'; end if;
 if old.cleanup_due_at is not null and new.cleanup_due_at is not null
  and new.cleanup_due_at is distinct from old.cleanup_due_at
 then raise check_violation using message='clear_cleanup_deadline_immutable'; end if;
 if old.completed_at is not null and old.cleanup_due_at is null and new.cleanup_due_at is not null
 then raise check_violation using message='clear_cleanup_cannot_reopen'; end if;
 return new;
end $$;
create trigger clear_recovery_guard before update on identity.clear_operations
 for each row execute function identity.guard_clear_recovery();
