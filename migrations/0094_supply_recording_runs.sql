-- #586 (v3) Supply's personal model runs follow the person's recording generation (D-264).
--
-- Owners: reasoning (`reasoning.business_runs`, the recording proof of a run) and supply (`supply.quick_answers`).
-- Before: only the Planner and the Cartographer could stamp a run with the recording generation it was made at
-- (migration 0043), so a question's placement and a Quick answer ran on the unproved compatibility path, which works only
-- at the first generation. A person who had paused and resumed recording got "We couldn't answer that one" with no model call.
-- After: Supply's four personal purposes may carry the same proof, so they run at the person's generation and are fenced to it.
--
-- Query shapes: unchanged. The proof columns are read by the run's exact key; the new column is read with its row.
-- Constraints: `reasoning_personal_recording_proof_shape` is replaced with the same shape plus the `supply` owner and its
-- four purposes (`ask-scope`, `ask-library`, `quick-answer`, `quick-answer-support`). It stays NOT VALID, as in 0043, so it
-- checks every new and changed row and scans no history. Old rows carry no proof and keep passing its first branch.
-- Column: a Quick answer remembers the recording generation it was asked at, which its worker runs under. It is the
-- generation the create transaction checked against the person's root. Rows from before this column were asked when only the
-- first generation could run, so they read as generation 1 (the default); they live at most a day.
-- Growth, retention, erasure: unchanged. The column is erased with its row; a run's proof is redacted with its run.
-- Rollout: additive for readers. An older process never writes a Supply proof or reads the column, and still passes the shape.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table reasoning.business_runs drop constraint reasoning_personal_recording_proof_shape;
alter table reasoning.business_runs
  add constraint reasoning_personal_recording_proof_shape check (
    (recording_account_id is null and recording_generation is null
     and recording_context_sha256 is null and recording_model_context_sha256 is null)
    or (privacy_erased_at is null and recording_account_id is not null and recording_generation is not null
     and recording_generation between 1 and 2147483647 and recording_generation % 2 = 1
     and owner_module in ('planner', 'geography', 'supply')
     and ((owner_module = 'planner' and purpose = 'personal-planner')
       or (owner_module = 'geography' and purpose = 'personal-cartographer')
       or (owner_module = 'supply' and purpose in ('ask-scope', 'ask-library', 'quick-answer', 'quick-answer-support')))
     and recording_context_sha256 is not null and recording_model_context_sha256 is not null
     and recording_context_sha256 ~ '^[0-9a-f]{64}$' and recording_model_context_sha256 ~ '^[0-9a-f]{64}$')
  ) not valid;

alter table supply.quick_answers
  add column recording_generation integer not null default 1
    check (recording_generation between 1 and 2147483647 and recording_generation % 2 = 1);
