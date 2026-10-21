-- #246 personal Reasoning privacy fence. Existing accounting identities/states and shared
-- receipts survive; only retained personal payload is redacted. No production/Cutroom change.
-- Owner: Reasoning. Reads: exact personal run/attempt marker during admission/settlement.
-- Writes: root-locked erasure marks once; ledger-owned settlement preserves the redacted shape.
-- Growth/retention: no new rows; existing terminal cleanup still removes personal rows.
-- Rollout: additive columns, but old personal workers must be drained before using this eraser.
-- An old writer is refused by the CHECKs, not considered a successful accounting rollout.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table reasoning.business_runs add column privacy_erased_at timestamptz;
alter table reasoning.external_attempts add column privacy_erased_at timestamptz;

alter table reasoning.business_runs add constraint business_runs_privacy_erased_check check (
 privacy_erased_at is null
 or (purpose = 'privacy-erased' and context_bundle_ref is null and context_refs is null)
) not valid;
alter table reasoning.external_attempts add constraint external_attempts_privacy_erased_check check (
 privacy_erased_at is null
 or (output is null and output_issues is null and quota_observation is null
     and (outcome_code is null or outcome_code in ('OUTCOME_NOT_RECORDED',
       'TRANSPORT_OUTCOME_UNKNOWN', 'AUTHORITY_REFUSED', 'QUOTA_UNAVAILABLE',
       'SUCCEEDED', 'REJECTED', 'REQUEST_EXPIRED')) and dispatched_by is null
     and (written_off_reason is null or written_off_reason = 'privacy-erased')
     and (written_off_by is null or written_off_by = 'privacy-erased')
     and (remote_id is null or remote_id ~ '^[A-Za-z0-9_.:-]{1,128}$'))
) not valid;
alter table reasoning.business_runs validate constraint business_runs_privacy_erased_check;
alter table reasoning.external_attempts validate constraint external_attempts_privacy_erased_check;

create function reasoning.keep_privacy_erased_marker() returns trigger language plpgsql as $$
begin
 if old.privacy_erased_at is not null and new.privacy_erased_at is distinct from old.privacy_erased_at
 then raise check_violation using message = 'reasoning_privacy_marker_immutable'; end if;
 return new;
end $$;
create trigger business_runs_privacy_marker before update on reasoning.business_runs
 for each row execute function reasoning.keep_privacy_erased_marker();
create trigger external_attempts_privacy_marker before update on reasoning.external_attempts
 for each row execute function reasoning.keep_privacy_erased_marker();
