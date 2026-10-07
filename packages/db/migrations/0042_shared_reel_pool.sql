-- #199: one Cutroom pool shared by several worlds (dev and stage), and Cutroom's own automatic
-- re-run of a failed run. Every rule of migration 0013 still holds for an ordinary order; this adds:
--
-- * receive jobs: this world looks up a Reel another world already ordered and imports it. A receive
--   never sends a request, so it needs no grant and reserves nothing.
-- * resume attempts: when Cutroom re-runs a failed run on its own, the re-run is recorded as the job's
--   second attempt, and the job's spend is the sum of both.
-- * a per-world live cap, recorded in a table instead of a constant. It is 200 cents unless an
--   operator raises it, and never above 500 (the owner's $5 for dev and stage together, 2026-10-07).
--   The shared $5 itself lives in the separate knowscroll_pool database (pool-migrations/).

-- Jobs: an order (the 0013 shape) or a receive (no grant, no budget).
ALTER TABLE generation_job
 ADD COLUMN kind text NOT NULL DEFAULT 'order' CHECK (kind IN ('order','receive')),
 ADD COLUMN shared_pool boolean NOT NULL DEFAULT false,
 ADD COLUMN pool_settled_at timestamptz,
 ALTER COLUMN grant_id DROP NOT NULL,
 DROP CONSTRAINT generation_job_budget_cents_check,
 ADD CONSTRAINT generation_job_kind_budget CHECK (
  (kind = 'order' AND grant_id IS NOT NULL AND budget_cents > 0)
  OR (kind = 'receive' AND grant_id IS NULL AND budget_cents = 0 AND shared_pool)),
 ADD CONSTRAINT generation_job_pool_settled CHECK (pool_settled_at IS NULL OR (shared_pool AND kind = 'order'));

-- Attempts: an order's own send (ordinal 1), Cutroom's re-run of it (ordinal 2), or a receive.
ALTER TABLE cutroom_attempt
 ADD COLUMN role text NOT NULL DEFAULT 'order' CHECK (role IN ('order','resume','receive')),
 ADD COLUMN resumes_attempt_id uuid REFERENCES cutroom_attempt(id),
 DROP CONSTRAINT cutroom_attempt_ordinal_check,
 DROP CONSTRAINT cutroom_attempt_request_id_key,
 DROP CONSTRAINT cutroom_attempt_check3,
 ADD CONSTRAINT cutroom_attempt_role_ordinal CHECK (
  (role IN ('order','receive') AND ordinal = 1 AND resumes_attempt_id IS NULL)
  OR (role = 'resume' AND ordinal = 2 AND resumes_attempt_id IS NOT NULL)),
 -- Only an order is ever sent by this world, so only an order passes through dispatch.
 ADD CONSTRAINT cutroom_attempt_dispatch CHECK (
  role <> 'order' OR state IN ('prepared','not_sent') OR dispatch_committed_at IS NOT NULL),
 ADD CONSTRAINT cutroom_attempt_role_states CHECK (
  role = 'order'
  OR (role = 'resume' AND state IN ('accepted','finished') AND dispatch_committed_at IS NULL)
  OR (role = 'receive' AND state IN ('prepared','not_sent','accepted','finished') AND dispatch_committed_at IS NULL));
-- A request id belongs to one first attempt in a world; the re-run shares it, as in Cutroom.
CREATE UNIQUE INDEX cutroom_attempt_one_request ON cutroom_attempt(request_id) WHERE ordinal = 1;

CREATE OR REPLACE FUNCTION cutroom_attempt_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Cutroom attempts are never deleted'; END IF;
 IF (NEW.id, NEW.job_id, NEW.ordinal, NEW.role, NEW.resumes_attempt_id, NEW.request_id, NEW.request_body, NEW.body_sha256, NEW.contract_revision, NEW.created_at)
   IS DISTINCT FROM (OLD.id, OLD.job_id, OLD.ordinal, OLD.role, OLD.resumes_attempt_id, OLD.request_id, OLD.request_body, OLD.body_sha256, OLD.contract_revision, OLD.created_at)
  OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
  OR NEW.resend_count < OLD.resend_count
  OR NEW.next_since < OLD.next_since
  OR (OLD.dispatch_committed_at IS NOT NULL AND NEW.dispatch_committed_at IS DISTINCT FROM OLD.dispatch_committed_at)
  OR (OLD.settlement <> 'held' AND NEW.settlement IS DISTINCT FROM OLD.settlement)
  OR (NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.role = 'order' AND OLD.state = 'prepared' AND NEW.state IN ('dispatch_committed','not_sent'))
    OR (OLD.role = 'order' AND OLD.state = 'dispatch_committed' AND NEW.state IN ('accepted','refused','unknown'))
    OR (OLD.role = 'order' AND OLD.state = 'unknown' AND NEW.state IN ('accepted','refused'))
    OR (OLD.role = 'receive' AND OLD.state = 'prepared' AND NEW.state IN ('accepted','not_sent'))
    OR (OLD.state = 'accepted' AND NEW.state = 'finished')))
 THEN RAISE EXCEPTION 'Illegal Cutroom attempt transition'; END IF;
 RETURN NEW;
END $$;

-- A re-run continues a finished first attempt of the same job, under the same request id.
CREATE FUNCTION cutroom_attempt_resume_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.role = 'resume' AND NOT EXISTS (
  SELECT 1 FROM cutroom_attempt a
  WHERE a.id = NEW.resumes_attempt_id AND a.job_id = NEW.job_id AND a.ordinal = 1
   AND a.role = 'order' AND a.state = 'finished' AND a.request_id = NEW.request_id
   AND a.body_sha256 = NEW.body_sha256 AND a.result->>'status' = 'failed'
 ) THEN RAISE EXCEPTION 'A resume attempt must continue its job''s own failed first attempt'; END IF;
 IF NEW.role = 'receive' AND NOT EXISTS (
  SELECT 1 FROM generation_job j WHERE j.id = NEW.job_id AND j.kind = 'receive'
 ) THEN RAISE EXCEPTION 'A receive attempt belongs to a receive job'; END IF;
 IF NEW.role = 'order' AND EXISTS (
  SELECT 1 FROM generation_job j WHERE j.id = NEW.job_id AND j.kind = 'receive'
 ) THEN RAISE EXCEPTION 'A receive job never sends a request'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cutroom_attempt_resume_guard BEFORE INSERT ON cutroom_attempt
 FOR EACH ROW EXECUTE FUNCTION cutroom_attempt_resume_guard();

CREATE OR REPLACE FUNCTION generation_job_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Generation jobs are never deleted'; END IF;
 IF (NEW.id, NEW.brief_id, NEW.engine_id, NEW.grant_id, NEW.until, NEW.budget_cents, NEW.deadline_at, NEW.created_at, NEW.kind, NEW.shared_pool)
   IS DISTINCT FROM (OLD.id, OLD.brief_id, OLD.engine_id, OLD.grant_id, OLD.until, OLD.budget_cents, OLD.deadline_at, OLD.created_at, OLD.kind, OLD.shared_pool)
  OR NEW.fence < OLD.fence
  OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
  OR (OLD.pool_settled_at IS NOT NULL AND NEW.pool_settled_at IS DISTINCT FROM OLD.pool_settled_at)
  OR (OLD.status IN ('completed','refused','stopped','failed','cancelled') AND NEW.status IS DISTINCT FROM OLD.status)
 THEN RAISE EXCEPTION 'Illegal generation job update'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION generation_job_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind = 'receive' THEN
  IF NOT EXISTS (
   SELECT 1 FROM cutroom_engine e, generation_brief b
   WHERE e.id = NEW.engine_id AND b.id = NEW.brief_id
    AND b.review_state = 'approved' AND e.retired_at IS NULL
  ) THEN RAISE EXCEPTION 'A receive job needs an approved brief and an active engine'; END IF;
  RETURN NEW;
 END IF;
 IF NOT EXISTS (
  SELECT 1 FROM cutroom_engine e, generation_budget_grant g, generation_brief b
  WHERE e.id = NEW.engine_id AND g.id = NEW.grant_id AND b.id = NEW.brief_id
   AND e.provider_mode = g.mode AND b.review_state = 'approved' AND e.retired_at IS NULL
   AND g.expires_at > clock_timestamp() AND g.admission_paused_at IS NULL
   AND g.reserved_cents >= NEW.budget_cents AND g.reserved_cents + g.spent_cents <= g.cap_cents
 ) THEN RAISE EXCEPTION 'A generation job needs an approved brief, an active engine, and an unexpired, unpaused grant of the engine''s mode with its budget already reserved within cap'; END IF;
 RETURN NEW;
END $$;

-- The per-world live cap. One row; 200 cents until an operator raises it; at most 500.
CREATE TABLE generation_live_cap (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 cap_cents integer NOT NULL CHECK (cap_cents BETWEEN 0 AND 500),
 set_by text NOT NULL CHECK (length(btrim(set_by)) BETWEEN 1 AND 200),
 set_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO generation_live_cap (cap_cents, set_by) VALUES (200, 'owner decision 2026-09-20 (ADR-0021 sec. 6)');
CREATE TRIGGER generation_live_cap_no_delete BEFORE DELETE ON generation_live_cap
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

CREATE OR REPLACE FUNCTION generation_live_cap_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap integer := (SELECT cap_cents FROM generation_live_cap);
BEGIN
 IF NEW.mode = 'live' AND (SELECT coalesce(sum(cap_cents),0) FROM generation_budget_grant
   WHERE mode = 'live' AND id <> NEW.id) + NEW.cap_cents > coalesce(cap, 200)
 THEN RAISE EXCEPTION 'Live generation grants may not exceed the owner cap of % cents in total', coalesce(cap, 200); END IF;
 IF TG_OP = 'UPDATE' AND (NEW.mode, NEW.cap_cents, NEW.authorization_ref, NEW.created_at)
   IS DISTINCT FROM (OLD.mode, OLD.cap_cents, OLD.authorization_ref, OLD.created_at)
  OR NEW.overage_cents < OLD.overage_cents
  OR (OLD.admission_paused_at IS NOT NULL AND NEW.admission_paused_at IS NULL AND NEW.overage_cents > 0)
 THEN RAISE EXCEPTION 'A grant''s mode, cap and authorization are immutable, and a recorded overage never shrinks'; END IF;
 RETURN NEW;
END $$;
