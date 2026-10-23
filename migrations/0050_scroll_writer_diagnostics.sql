-- Scroll writer: diagnostics for refused answers, and one writer call per job.
--
-- 1. reasoning.production_rejected_answers (owner: reasoning, nonpersonal production ledger).
--    Derived diagnostics, never authority. A refused model answer in nonpersonal Scroll
--    production is kept redacted and bounded to 64 KiB with the validator's own findings, so a
--    failing writer can be diagnosed from evidence. Personal roles never write here: only the
--    production ledger implements the recording port. Queries: one row by attempt (operator
--    "show"), newest first by recorded_at (operator "list"), expiry scan by expires_at (purge).
--    Growth: at most one row per refused production attempt. Retention: 30 days from recording;
--    the existing protected-request purge deletes expired rows. Erasure: none, no account or
--    universe data enters nonpersonal production. Additive; older processes never touch it.
--
-- 2. content.scroll_production_runs (owner: content/production). A job is now research, then one
--    writer call and at most one repair: the separate claims stage and its run are gone. The
--    column claims_run_id goes, the state check loses 'claims', and a job left in that state
--    (none can continue: the stage no longer exists) is closed as rejected. The claims column
--    stays and now records the passages a published Scroll rests on. Rollout: apply with the new
--    workers; no process of the previous recipe may run a job after this migration.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table reasoning.production_rejected_answers (
  scope_id text not null,
  attempt_id uuid not null,
  -- The harness verdict (OUTPUT_SCHEMA_MISMATCH, OUTPUT_NOT_ONE_JSON_OBJECT, OUTPUT_TRUNCATED, ...).
  reason text not null,
  -- The validator's own findings as the repair request carried them: [{path, code, detail?}].
  issues jsonb not null,
  -- Redacted answer text (or bounded raw reply body for an unreadable reply), cut at 64 KiB.
  answer_text text not null,
  -- Length of the answer before it was cut.
  answer_chars integer not null,
  truncated boolean not null,
  recorded_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint production_rejected_answers_pkey primary key (scope_id, attempt_id),
  constraint production_rejected_answers_attempt_fkey foreign key (scope_id, attempt_id)
    references reasoning.production_attempts (scope_id, id) on delete restrict,
  constraint production_rejected_answers_issues_check check (jsonb_typeof(issues) = 'array'),
  constraint production_rejected_answers_size_check check (answer_chars >= 0 and char_length(answer_text) <= 65536),
  constraint production_rejected_answers_expiry_check check (expires_at > recorded_at)
);
create index production_rejected_answers_recorded_idx on reasoning.production_rejected_answers (recorded_at desc);
create index production_rejected_answers_expiry_idx on reasoning.production_rejected_answers (expires_at);
comment on table reasoning.production_rejected_answers is
  'Redacted, bounded refused answers of nonpersonal production attempts for diagnosis; 30-day retention.';

-- A job parked in the retired claims stage cannot continue; close it so the new state check holds.
update content.scroll_production_runs set state = 'rejected', completed_at = now() where state = 'claims';

-- squawk-ignore ban-drop-column
alter table content.scroll_production_runs drop column claims_run_id;
-- squawk-ignore ban-drop-constraint
alter table content.scroll_production_runs drop constraint scroll_production_runs_state_check;
alter table content.scroll_production_runs
  add constraint scroll_production_runs_state_check
  check (state in ('research', 'writer', 'published', 'rejected', 'unknown')) not valid;
-- Left NOT VALID like the other forward vocabulary changes: every new write is checked, and
-- validation belongs in its own transaction (squawk constraint-missing-not-valid).
