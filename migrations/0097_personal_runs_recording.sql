-- #595 (v3) The free-text match, Jev, the scenario steps and a room's contribution follow the person's recording generation (D-268).
--
-- Owner: reasoning (`reasoning.business_runs`, the recording proof of a run).
-- Before: only the Planner, the Cartographer and Supply's four question and Quick answer steps could stamp a run with the
-- recording generation it was made at (migrations 0043 and 0096), so these paths ran on the compatibility path, which works
-- only at the first generation. A person who had paused and resumed recording got nothing from them.
-- After: Supply's free-text match, the Composer's Jev assessment, the two steps of a what-if or another perspective, and an
-- AI inhabitant's answer to a member's ask may carry the same proof, so each runs at the person's generation and is fenced to it.
--
-- Query shapes: unchanged. The proof columns are read by the run's exact key.
-- Constraints: `reasoning_personal_recording_proof_shape` is replaced with the same shape plus the new owners and their steps
-- (`supply` `match-request`; `scenarios` `suggest` and `answer`; `rooms` `inhabitant-contribution`; `composer`
-- `jev-assessment`). It stays NOT VALID, as in 0043 and 0096, so it checks every new and changed row and scans no history. Old
-- rows carry no proof and keep passing its first branch.
-- Growth, retention, erasure: unchanged. A run's proof is redacted with its run.
-- Rollout: additive for readers. An older process never writes these proofs and still passes the shape.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Only widens the allowed owners; the replacement immediately enforces everything the old shape did, plus the new steps.
-- squawk-ignore ban-drop-constraint
alter table reasoning.business_runs drop constraint reasoning_personal_recording_proof_shape;
alter table reasoning.business_runs
  add constraint reasoning_personal_recording_proof_shape check (
    (recording_account_id is null and recording_generation is null
     and recording_context_sha256 is null and recording_model_context_sha256 is null)
    or (privacy_erased_at is null and recording_account_id is not null and recording_generation is not null
     and recording_generation between 1 and 2147483647 and recording_generation % 2 = 1
     and owner_module in ('planner', 'geography', 'supply', 'scenarios', 'rooms', 'composer')
     and ((owner_module = 'planner' and purpose = 'personal-planner')
       or (owner_module = 'geography' and purpose = 'personal-cartographer')
       or (owner_module = 'supply' and purpose in
            ('ask-scope', 'ask-library', 'match-request', 'quick-answer', 'quick-answer-support'))
       or (owner_module = 'scenarios' and purpose in ('suggest', 'answer'))
       or (owner_module = 'rooms' and purpose = 'inhabitant-contribution')
       or (owner_module = 'composer' and purpose = 'jev-assessment'))
     and recording_context_sha256 is not null and recording_model_context_sha256 is not null
     and recording_context_sha256 ~ '^[0-9a-f]{64}$' and recording_model_context_sha256 ~ '^[0-9a-f]{64}$')
  ) not valid;
