-- ADR-0042 (#166): a background inquiry may take one bounded continuation step in the same
-- conversation after the validator refuses its proposal, may hand its pairs to child inquiries that
-- share its budget, and may be mailed by more typed causes. Also the #153 guards: only the newest
-- consent request applies, and whether an inquiry's request was sent is the database's own record.

-- The route declares its thinking mode, its continuation bound and its children; like the rest of it,
-- none of these changes once installed.
ALTER TABLE background_inquiry_route
 ADD COLUMN thinking text NOT NULL DEFAULT 'disabled' CHECK (thinking IN ('disabled','adaptive')),
 ADD COLUMN max_continuation_steps smallint NOT NULL DEFAULT 1 CHECK (max_continuation_steps BETWEEN 0 AND 2),
 ADD COLUMN max_children smallint NOT NULL DEFAULT 0 CHECK (max_children IN (0,2,3));
DROP TRIGGER background_inquiry_route_no_rebind ON background_inquiry_route;
CREATE TRIGGER background_inquiry_route_no_rebind BEFORE UPDATE OF policy_version, route_id, route_profile_version, transport, model,
 max_input_tokens, max_output_tokens, global_bucket_id, provider_account_bucket_id, route_quota_bucket_id, remote_concurrency_bucket_id,
 owner_capacity, job_capacity, coalescing_delay_seconds, job_ttl_seconds, thinking, max_continuation_steps, max_children ON background_inquiry_route
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_route_immutable();

-- A family: an inquiry the mailbox opened may become a parent whose Job only waits (no Step of its own)
-- and holds the family's budget; each child has one pair, its own Job, context, Step and request, and
-- no budget of its own. `sent` records, once an inquiry closes, whether any request of its Job was
-- dispatched (#153: a pair counts as asked only then).
ALTER TABLE background_inquiry
 ADD COLUMN role text NOT NULL DEFAULT 'single' CHECK (role IN ('single','parent','child')),
 ADD COLUMN parent_id uuid REFERENCES background_inquiry(id),
 ADD COLUMN sent boolean;
CREATE INDEX background_inquiry_children ON background_inquiry(parent_id) WHERE parent_id IS NOT NULL;

-- Rows closed before this migration: a recorded dispatch while the private graph still exists; once it
-- was retired, a recorded attempt counts as sent, as every closed inquiry's pairs counted before.
DROP TRIGGER background_inquiry_guard ON background_inquiry;
UPDATE background_inquiry i SET sent = CASE
  WHEN i.job_id IS NULL THEN false
  WHEN EXISTS (SELECT 1 FROM reasoning_job j WHERE j.id = i.job_id) THEN EXISTS (SELECT 1 FROM reasoning_attempt at
    JOIN reasoning_accounting ac ON ac.attempt_id = at.id WHERE at.job_id = i.job_id AND ac.dispatch_id IS NOT NULL)
  ELSE i.attempt_id IS NOT NULL END
 WHERE i.status NOT IN ('pending','queued');

ALTER TABLE background_inquiry
 DROP CONSTRAINT background_inquiry_status_check,
 ADD CONSTRAINT background_inquiry_status_check
  CHECK (status IN ('pending','queued','admitted','rejected','none','nothing_to_ask','failed','withdrawn','settled')),
 DROP CONSTRAINT background_inquiry_check1,
 ADD CONSTRAINT background_inquiry_opened CHECK ((job_id IS NULL) = (policy_version IS NULL) AND (job_id IS NULL) = (through_sequence IS NULL)
  AND (job_id IS NULL) = (pairs IS NULL) AND (job_id IS NULL) = (opened_at IS NULL)),
 -- Every opened inquiry has a Step, context and request of its own, except a parent: its Job only waits.
 ADD CONSTRAINT background_inquiry_own_step CHECK ((step_id IS NULL) = (context_id IS NULL) AND (step_id IS NULL) = (request_id IS NULL)
  AND (step_id IS NOT NULL) = (job_id IS NOT NULL AND role <> 'parent')),
 -- The family's budget is the parent's: a child never opens one.
 ADD CONSTRAINT background_inquiry_family_budget CHECK (CASE WHEN role = 'child' THEN job_bucket_id IS NULL ELSE (job_bucket_id IS NULL) = (job_id IS NULL) END),
 ADD CONSTRAINT background_inquiry_family CHECK ((role = 'child') = (parent_id IS NOT NULL) AND (role <> 'child' OR jsonb_array_length(pairs) = 1)),
 ADD CONSTRAINT background_inquiry_parent_status CHECK ((status <> 'settled' OR role = 'parent')
  AND (role <> 'parent' OR (status IN ('queued','settled','withdrawn') AND request_hash IS NULL AND attempt_id IS NULL))),
 ADD CONSTRAINT background_inquiry_sent CHECK ((status IN ('pending','queued')) = (sent IS NULL));

-- An inquiry is created pending (or, a child, queued by its parent's opening); it moves pending ->
-- queued (the Job's identity, then its request bytes once) -> one terminal outcome, or pending ->
-- nothing_to_ask | withdrawn | failed. A parent ends settled (every child closed) or withdrawn.
CREATE OR REPLACE FUNCTION background_inquiry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent background_inquiry;
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.role = 'child' THEN
   SELECT * INTO parent FROM background_inquiry WHERE id = NEW.parent_id FOR UPDATE;
   IF parent.id IS NULL OR parent.role <> 'parent' OR parent.status <> 'queued' OR NEW.status <> 'queued'
     OR (NEW.universe_id, NEW.privacy_epoch, NEW.kind, NEW.first_mail_at, NEW.policy_version, NEW.through_sequence)
       IS DISTINCT FROM (parent.universe_id, parent.privacy_epoch, parent.kind, parent.first_mail_at, parent.policy_version, parent.through_sequence)
     OR NOT parent.pairs @> NEW.pairs
     OR EXISTS (SELECT 1 FROM background_inquiry s WHERE s.parent_id = NEW.parent_id AND s.pairs = NEW.pairs)
     OR (SELECT count(*) FROM background_inquiry s WHERE s.parent_id = NEW.parent_id) >= 3 THEN
    RAISE EXCEPTION 'A child inquiry asks one pair of its own queued parent, at most three children';
   END IF;
   NEW.opened_at := clock_timestamp();
   RETURN NEW;
  END IF;
  IF NEW.status <> 'pending' OR NEW.role <> 'single' THEN RAISE EXCEPTION 'An inquiry starts pending'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id, NEW.universe_id, NEW.privacy_epoch, NEW.kind, NEW.first_mail_at, NEW.parent_id)
   IS DISTINCT FROM (OLD.id, OLD.universe_id, OLD.privacy_epoch, OLD.kind, OLD.first_mail_at, OLD.parent_id) THEN
  RAISE EXCEPTION 'An inquiry keeps its identity';
 END IF;
 IF OLD.status NOT IN ('pending','queued') THEN RAISE EXCEPTION 'A closed inquiry does not change'; END IF;
 IF OLD.status = 'pending' THEN
  IF NEW.status = 'queued' THEN
   NEW.opened_at := clock_timestamp();
   RETURN NEW;
  END IF;
  IF NEW.role <> OLD.role OR NEW.status NOT IN ('nothing_to_ask','withdrawn','failed') THEN RAISE EXCEPTION 'Illegal inquiry transition from pending'; END IF;
 ELSE
  IF (NEW.policy_version, NEW.job_id, NEW.step_id, NEW.context_id, NEW.request_id, NEW.job_bucket_id, NEW.through_sequence, NEW.pairs, NEW.opened_at, NEW.role)
    IS DISTINCT FROM (OLD.policy_version, OLD.job_id, OLD.step_id, OLD.context_id, OLD.request_id, OLD.job_bucket_id, OLD.through_sequence, OLD.pairs, OLD.opened_at, OLD.role) THEN
   RAISE EXCEPTION 'An opened inquiry keeps its Job';
  END IF;
  IF (NEW.request_hash, NEW.input_bytes) IS DISTINCT FROM (OLD.request_hash, OLD.input_bytes) AND OLD.request_hash IS NOT NULL THEN
   RAISE EXCEPTION 'An inquiry''s request bytes are recorded once';
  END IF;
  IF NEW.status = 'queued' THEN RETURN NEW; END IF;
  IF OLD.role = 'parent' THEN
   IF NEW.status NOT IN ('settled','withdrawn') OR (NEW.status = 'settled'
     AND EXISTS (SELECT 1 FROM background_inquiry c WHERE c.parent_id = NEW.id AND c.status IN ('pending','queued'))) THEN
    RAISE EXCEPTION 'A parent inquiry settles only once every child has closed';
   END IF;
  ELSIF NEW.status NOT IN ('admitted','rejected','none','failed','withdrawn') OR NEW.request_hash IS NULL AND NEW.status IN ('admitted','rejected','none') THEN
   RAISE EXCEPTION 'Illegal inquiry transition from queued';
  END IF;
 END IF;
 -- A decided proposal must be this inquiry's own: this universe and epoch, the model, this attempt.
 IF NEW.proposal_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM semantic_proposal p
   WHERE p.id = NEW.proposal_id AND p.scope_kind = 'universe' AND p.universe_id = NEW.universe_id AND p.privacy_epoch = NEW.privacy_epoch
     AND p.proposer_kind = 'model' AND p.proposer_ref = NEW.attempt_id::text
     AND p.status = CASE NEW.status WHEN 'admitted' THEN 'admitted' ELSE 'rejected' END) THEN
  RAISE EXCEPTION 'An inquiry outcome names only its own decided proposal';
 END IF;
 -- Whether a request was sent is read from the Job's own dispatches, never supplied.
 NEW.sent := NEW.job_id IS NOT NULL AND EXISTS (SELECT 1 FROM reasoning_attempt at JOIN reasoning_accounting ac ON ac.attempt_id = at.id
   WHERE at.job_id = NEW.job_id AND ac.dispatch_id IS NOT NULL);
 NEW.closed_at := clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER background_inquiry_guard BEFORE INSERT OR UPDATE ON background_inquiry
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_guard();

-- The next Step of an inquiry's Job after the validator refused its proposal: the exact request it
-- sends, and the refused attempt's assistant turn it continues. That turn is protected runtime data:
-- the native content blocks exactly as the provider returned them, thinking blocks included, in their
-- original order. It is never exposed to a client, exported, used as evidence or put in a receipt, and
-- it is erased with its Step (ADR-0019 retirement) or its epoch (Clear/Reset).
CREATE TABLE background_inquiry_continuation (
 step_id uuid PRIMARY KEY,
 job_id uuid NOT NULL,
 context_id uuid NOT NULL,
 universe_id uuid NOT NULL,
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 inquiry_id uuid NOT NULL REFERENCES background_inquiry(id) ON DELETE CASCADE,
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 2 AND 3),
 previous_attempt_id uuid NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 input_bytes integer NOT NULL CHECK (input_bytes BETWEEN 1 AND 16384),
 -- The validator's reason codes for the refused proposal, which the continuation turn names.
 reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) BETWEEN 1 AND 24),
 assistant_turn jsonb NOT NULL CHECK (jsonb_typeof(assistant_turn) = 'array' AND jsonb_array_length(assistant_turn) BETWEEN 1 AND 64),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (job_id, ordinal),
 FOREIGN KEY (step_id, job_id, context_id, universe_id, privacy_epoch)
  REFERENCES reasoning_step(id, job_id, context_id, universe_id, privacy_epoch) ON DELETE CASCADE
);

CREATE FUNCTION background_inquiry_continuation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'An inquiry continuation is immutable'; END IF;
 IF TG_OP = 'DELETE' THEN
  IF EXISTS (SELECT 1 FROM reasoning_step WHERE id = OLD.step_id)
    AND EXISTS (SELECT 1 FROM universe WHERE id = OLD.universe_id AND privacy_epoch = OLD.privacy_epoch) THEN
   RAISE EXCEPTION 'An inquiry continuation is erased only with its Step or its epoch';
  END IF;
  RETURN OLD;
 END IF;
 -- Within the route's bound, the next pending Step of an open inquiry's own Job, on its sealed context;
 -- it continues the previous Step's answered attempt, whose proposal the validator refused.
 IF NOT EXISTS (SELECT 1 FROM background_inquiry i JOIN background_inquiry_route r ON r.policy_version = i.policy_version
     JOIN reasoning_step s ON s.id = NEW.step_id AND s.job_id = i.job_id AND s.context_id = i.context_id
     WHERE i.id = NEW.inquiry_id AND i.job_id = NEW.job_id AND i.universe_id = NEW.universe_id AND i.privacy_epoch = NEW.privacy_epoch
       AND i.status = 'queued' AND s.ordinal = NEW.ordinal AND s.status = 'pending' AND NEW.ordinal <= 1 + r.max_continuation_steps)
   OR NOT EXISTS (SELECT 1 FROM reasoning_attempt a JOIN reasoning_step p ON p.id = a.step_id JOIN reasoning_accounting ac ON ac.attempt_id = a.id
     JOIN semantic_proposal sp ON sp.proposer_kind = 'model' AND sp.proposer_ref = a.id::text AND sp.status = 'rejected'
       AND sp.scope_kind = 'universe' AND sp.universe_id = NEW.universe_id AND sp.privacy_epoch = NEW.privacy_epoch
     WHERE a.id = NEW.previous_attempt_id AND a.job_id = NEW.job_id AND p.ordinal = NEW.ordinal - 1 AND ac.state = 'responded') THEN
  RAISE EXCEPTION 'A continuation is the next Step of its open inquiry after a refused proposal, within the route''s bound';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER background_inquiry_continuation_guard BEFORE INSERT OR UPDATE OR DELETE ON background_inquiry_continuation
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_continuation_guard();

-- ADR-0042 §5: the moment from which a change in this epoch may become paid work -- when consent was
-- last turned on, or recording last resumed, whichever is later. Nothing earlier is ever mailed.
CREATE FUNCTION inquiry_mail_since(universe uuid, epoch integer) RETURNS timestamptz LANGUAGE sql STABLE AS $$
 SELECT GREATEST(
  (SELECT min(r.requested_at) FROM background_inquiry_consent_request r
    WHERE r.universe_id = universe AND r.privacy_epoch = epoch AND r.enabled
      AND NOT EXISTS (SELECT 1 FROM background_inquiry_consent_request d
        WHERE d.universe_id = universe AND d.privacy_epoch = epoch AND NOT d.enabled AND d.requested_at > r.requested_at)),
  (SELECT max(p.applied_at) FROM privacy_recording_receipt p WHERE p.universe_id = universe AND p.action = 'resume'))
$$;

-- Each mail's typed cause: a place formed (ADR-0038 §3), a bridge between two live places revoked,
-- or a personal hypothesis about a live place created or changed. Each cause mails at most once.
ALTER TABLE inquiry_mail
 ADD COLUMN cause_kind text NOT NULL DEFAULT 'place_formed' CHECK (cause_kind IN ('place_formed','bridge_revoked','hypothesis_changed')),
 ALTER COLUMN cause_delta_id DROP NOT NULL,
 ADD COLUMN cause_bridge_id uuid REFERENCES bridge(id),
 ADD COLUMN cause_hypothesis_id uuid REFERENCES personal_hypothesis(id),
 ADD COLUMN cause_hypothesis_revision integer CHECK (cause_hypothesis_revision >= 1),
 ADD CONSTRAINT inquiry_mail_one_cause CHECK ((cause_kind = 'place_formed') = (cause_delta_id IS NOT NULL)
  AND (cause_kind = 'bridge_revoked') = (cause_bridge_id IS NOT NULL) AND (cause_kind = 'hypothesis_changed') = (cause_hypothesis_id IS NOT NULL)
  AND (cause_hypothesis_id IS NULL) = (cause_hypothesis_revision IS NULL)),
 ADD CONSTRAINT inquiry_mail_revocation_once UNIQUE (universe_id, cause_bridge_id),
 ADD CONSTRAINT inquiry_mail_hypothesis_once UNIQUE (cause_hypothesis_id, cause_hypothesis_revision);
ALTER TABLE inquiry_mail ALTER COLUMN cause_kind DROP DEFAULT;

-- Nothing is mailed without consent, while paused, or for a cause the rules do not allow: mail joins a
-- pending inquiry of its universe and epoch, for a planet/region formed in this transaction, a bridge
-- between two live places revoked since consent (or the last resume), or a hypothesis about a live
-- place revised since then.
CREATE OR REPLACE FUNCTION inquiry_mail_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Inquiry mail is immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM universe u JOIN background_inquiry_consent c ON c.universe_id = u.id AND c.privacy_epoch = u.privacy_epoch
   WHERE u.id = NEW.universe_id AND u.privacy_epoch = NEW.privacy_epoch AND u.recording_paused_at IS NULL AND c.enabled) THEN
  RAISE EXCEPTION 'Inquiry mail needs active consent in the current epoch while recording';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM background_inquiry i WHERE i.id = NEW.inquiry_id AND i.universe_id = NEW.universe_id
   AND i.privacy_epoch = NEW.privacy_epoch AND i.kind = NEW.kind AND i.status = 'pending') THEN
  RAISE EXCEPTION 'Inquiry mail joins a pending inquiry of its own universe';
 END IF;
 IF NEW.cause_kind = 'place_formed' AND NOT EXISTS (SELECT 1 FROM atlas_delta d WHERE d.id = NEW.cause_delta_id AND d.universe_id = NEW.universe_id
   AND d.kind = 'place_formed' AND d.after->>'kind' IN ('planet','region') AND d.txid = pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Inquiry mail is caused by a place formed in this transaction';
 END IF;
 IF NEW.cause_kind = 'bridge_revoked' AND NOT EXISTS (SELECT 1 FROM bridge b
   JOIN atlas_place f ON f.universe_id = NEW.universe_id AND f.anchor_concept_id = b.from_concept_id AND f.state = 'live' AND f.kind IN ('planet','region')
   JOIN atlas_place t ON t.universe_id = NEW.universe_id AND t.anchor_concept_id = b.to_concept_id AND t.state = 'live' AND t.kind IN ('planet','region')
   WHERE b.id = NEW.cause_bridge_id AND b.status = 'revoked' AND (b.universe_id IS NULL OR b.universe_id = NEW.universe_id)
     AND b.status_changed_at > inquiry_mail_since(NEW.universe_id, NEW.privacy_epoch)) THEN
  RAISE EXCEPTION 'Inquiry mail is caused by a bridge between two live places revoked since consent';
 END IF;
 IF NEW.cause_kind = 'hypothesis_changed' AND NOT EXISTS (SELECT 1 FROM personal_hypothesis h
   JOIN atlas_place p ON p.universe_id = h.universe_id AND p.anchor_concept_id = h.concept_id AND p.state = 'live' AND p.kind IN ('planet','region')
   WHERE h.id = NEW.cause_hypothesis_id AND h.universe_id = NEW.universe_id AND h.privacy_epoch = NEW.privacy_epoch
     AND h.revision = NEW.cause_hypothesis_revision AND h.revised_at > inquiry_mail_since(NEW.universe_id, NEW.privacy_epoch)) THEN
  RAISE EXCEPTION 'Inquiry mail is caused by a hypothesis about a live place revised since consent';
 END IF;
 IF (SELECT count(*) FROM inquiry_mail WHERE inquiry_id = NEW.inquiry_id) >= 16 THEN
  RAISE EXCEPTION 'An inquiry holds at most 16 causes';
 END IF;
 RETURN NEW;
END $$;

-- #153: consent changes only with the newest recorded request of its universe and epoch, so an older
-- request can never be applied again.
CREATE OR REPLACE FUNCTION background_inquiry_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM background_inquiry_consent_request r
   WHERE r.id = NEW.request_id AND r.universe_id = NEW.universe_id AND r.privacy_epoch = NEW.privacy_epoch
     AND r.enabled = NEW.enabled AND r.daily_limit = NEW.daily_limit) THEN
  RAISE EXCEPTION 'Consent changes only with a recorded request for exactly this change';
 END IF;
 IF EXISTS (SELECT 1 FROM background_inquiry_consent_request n JOIN background_inquiry_consent_request r
     ON r.universe_id = n.universe_id AND r.privacy_epoch = n.privacy_epoch AND r.id <> n.id AND r.requested_at >= n.requested_at
   WHERE n.id = NEW.request_id) THEN
  RAISE EXCEPTION 'Consent applies only its newest request';
 END IF;
 IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN RAISE EXCEPTION 'Consent starts at revision 1'; END IF;
 IF TG_OP = 'UPDATE' AND ((NEW.universe_id, NEW.privacy_epoch) IS DISTINCT FROM (OLD.universe_id, OLD.privacy_epoch)
   OR NEW.request_id = OLD.request_id OR NEW.revision <> OLD.revision + 1) THEN
  RAISE EXCEPTION 'A consent change is a new request and the next revision';
 END IF;
 NEW.changed_at := clock_timestamp();
 RETURN NEW;
END $$;
