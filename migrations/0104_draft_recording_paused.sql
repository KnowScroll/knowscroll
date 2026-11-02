-- #653 (v3) A What-if draft taken up while recording is paused says so (D-388): `failure` gains `recording_paused`, so the sheet can
-- tell the person that suggestions need recording on, instead of "we couldn't think of directions".
--
-- Owner: scenarios. Authoritative. One check widened on an existing column; no new column, row or index.
-- Query shapes, locking, access, growth: unchanged. The draft stays the requester's own and expires with the rest of the draft.
-- Retention and erasure: unchanged (the draft is deleted with the person's other drafts; the export does not list drafts).
-- Rollout: the usual order. The migration runs before the worker that writes the new value.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Required vocabulary extension; the replacement enforces every old value plus the new one, and validates in this same migration.
-- squawk-ignore ban-drop-constraint
alter table scenarios.drafts drop constraint drafts_failure_check;
alter table scenarios.drafts
  add constraint drafts_failure_check
    check (failure in ('could_not_suggest', 'budget_unavailable', 'recording_paused')) not valid;
-- Every existing row holds an older value, so the check holds.
-- squawk-ignore constraint-missing-not-valid
alter table scenarios.drafts validate constraint drafts_failure_check;
