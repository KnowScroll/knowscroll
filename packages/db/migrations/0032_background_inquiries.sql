-- ADR-0038 (#132): background bridge inquiries. A reader's standing consent lets the Cartographer's
-- new places post mail; mail coalesces into at most one pending inquiry per universe and kind; the
-- worker turns a due inquiry into one background Job with fresh authority; a reply changes state
-- only as a bridge proposal decided by bridge-validator-v1. Consent, mail and inquiries are private
-- history: Clear/Reset erase them after the epoch advances, and export carries them.

-- The deployment's inquiry route, like the answer route (migration 0028). `policy_version` names
-- the fairness scheduler its Jobs are enqueued under and the reasoning policy they resolve to; it may
-- be the answer route's, so the existing class-aware fairness decides between direct Asks and
-- background inquiries. Nothing is enabled implicitly.
CREATE TABLE background_inquiry_route (
 policy_version reasoning_label PRIMARY KEY REFERENCES reasoning_fairness_policy(version),
 route_id reasoning_label NOT NULL,
 route_profile_version reasoning_label NOT NULL,
 transport text NOT NULL CHECK (transport IN ('fixture','minimax')),
 model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 16384),
 max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 4096),
 global_bucket_id uuid NOT NULL REFERENCES reasoning_bucket(id),
 provider_account_bucket_id uuid NOT NULL REFERENCES reasoning_bucket(id),
 route_quota_bucket_id uuid NOT NULL REFERENCES reasoning_bucket(id),
 remote_concurrency_bucket_id uuid NOT NULL REFERENCES reasoning_bucket(id),
 owner_capacity bigint NOT NULL CHECK (owner_capacity > 0),
 job_capacity bigint NOT NULL CHECK (job_capacity > 0),
 -- A pending inquiry becomes due once its first mail is this old: a burst of places costs one call.
 coalescing_delay_seconds integer NOT NULL CHECK (coalescing_delay_seconds BETWEEN 0 AND 86400),
 job_ttl_seconds integer NOT NULL CHECK (job_ttl_seconds BETWEEN 30 AND 86400),
 enabled boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX background_inquiry_route_one_enabled ON background_inquiry_route((true)) WHERE enabled;

CREATE TABLE background_inquiry_owner_bucket (
 policy_version reasoning_label NOT NULL REFERENCES background_inquiry_route(policy_version),
 universe_id uuid NOT NULL REFERENCES universe(id),
 bucket_id uuid NOT NULL UNIQUE REFERENCES reasoning_bucket(id),
 PRIMARY KEY (policy_version, universe_id)
);

-- Every consent change is an explicit request from a live session of the universe, kept as history.
CREATE TABLE background_inquiry_consent_request (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 session_id uuid NOT NULL,
 client_request_id uuid NOT NULL,
 enabled boolean NOT NULL,
 daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 1 AND 10),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (universe_id, client_request_id)
);

-- The standing consent: one row per universe and epoch, changed only by a recorded request.
CREATE TABLE background_inquiry_consent (
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 enabled boolean NOT NULL,
 daily_limit integer NOT NULL CHECK (daily_limit BETWEEN 1 AND 10),
 revision integer NOT NULL CHECK (revision >= 1),
 request_id uuid NOT NULL UNIQUE REFERENCES background_inquiry_consent_request(id),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (universe_id, privacy_epoch)
);

CREATE TABLE background_inquiry (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 kind text NOT NULL CHECK (kind = 'bridge_between_places'),
 status text NOT NULL CHECK (status IN ('pending','queued','admitted','rejected','none','nothing_to_ask','failed','withdrawn')),
 first_mail_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- Set together when the worker creates the Job (pending -> queued). Named without a foreign key: the
 -- inquiry outlives its execution graph's seven-day retirement, like an answer request.
 policy_version reasoning_label REFERENCES background_inquiry_route(policy_version),
 job_id uuid UNIQUE,
 step_id uuid,
 context_id uuid,
 request_id uuid UNIQUE,
 job_bucket_id uuid UNIQUE REFERENCES reasoning_bucket(id),
 through_sequence bigint CHECK (through_sequence >= 1),
 -- The offered pairs' codes and names, for the reader's list: [{a:{code,name},b:{code,name}}].
 pairs jsonb CHECK (pairs IS NULL OR (jsonb_typeof(pairs) = 'array' AND jsonb_array_length(pairs) BETWEEN 1 AND 3)),
 opened_at timestamptz,
 -- Written once, after the sealed context exists (the bytes derive from it).
 request_hash text CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 input_bytes integer CHECK (input_bytes BETWEEN 1 AND 16384),
 -- The outcome. Provider text survives only inside a decided proposal (semantic_proposal).
 attempt_id uuid,
 proposal_id uuid UNIQUE REFERENCES semantic_proposal(id),
 reasons jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) <= 24),
 closed_at timestamptz,
 CHECK ((request_hash IS NULL) = (input_bytes IS NULL)),
 CHECK ((job_id IS NULL) = (policy_version IS NULL) AND (job_id IS NULL) = (step_id IS NULL) AND (job_id IS NULL) = (context_id IS NULL)
    AND (job_id IS NULL) = (request_id IS NULL) AND (job_id IS NULL) = (job_bucket_id IS NULL) AND (job_id IS NULL) = (through_sequence IS NULL)
    AND (job_id IS NULL) = (pairs IS NULL) AND (job_id IS NULL) = (opened_at IS NULL)),
 CHECK ((status IN ('pending','queued')) = (closed_at IS NULL)),
 CHECK (status <> 'pending' OR (job_id IS NULL AND attempt_id IS NULL AND proposal_id IS NULL AND jsonb_array_length(reasons) = 0)),
 CHECK (status <> 'queued' OR (job_id IS NOT NULL AND attempt_id IS NULL AND proposal_id IS NULL AND jsonb_array_length(reasons) = 0)),
 CHECK (status NOT IN ('admitted','rejected','none') OR (job_id IS NOT NULL AND request_hash IS NOT NULL AND attempt_id IS NOT NULL)),
 CHECK (status <> 'admitted' OR (proposal_id IS NOT NULL AND jsonb_array_length(reasons) = 0)),
 CHECK (status <> 'none' OR (proposal_id IS NULL AND jsonb_array_length(reasons) = 0)),
 CHECK (status <> 'nothing_to_ask' OR job_id IS NULL),
 CHECK (status NOT IN ('rejected','failed','withdrawn','nothing_to_ask') OR jsonb_array_length(reasons) >= 1),
 CHECK (status IN ('admitted','rejected') OR proposal_id IS NULL)
);
-- ADR-0038 §3: at most one pending inquiry per universe and kind.
CREATE UNIQUE INDEX background_inquiry_one_pending ON background_inquiry(universe_id, kind) WHERE status = 'pending';
CREATE INDEX background_inquiry_universe ON background_inquiry(universe_id, first_mail_at DESC, id);
CREATE INDEX background_inquiry_due ON background_inquiry(first_mail_at, id) WHERE status = 'pending';

-- One row per Cartographer change that asked for a look, joined to the inquiry it coalesced into.
CREATE SEQUENCE inquiry_mail_sequence AS bigint;
CREATE TABLE inquiry_mail (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 kind text NOT NULL CHECK (kind = 'bridge_between_places'),
 inquiry_id uuid NOT NULL REFERENCES background_inquiry(id),
 cause_delta_id uuid NOT NULL UNIQUE REFERENCES atlas_delta(id),
 sequence bigint NOT NULL UNIQUE DEFAULT nextval('inquiry_mail_sequence'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER SEQUENCE inquiry_mail_sequence OWNED BY inquiry_mail.sequence;
CREATE INDEX inquiry_mail_inquiry ON inquiry_mail(inquiry_id, sequence);
CREATE INDEX inquiry_mail_universe ON inquiry_mail(universe_id);

-- Guards ---------------------------------------------------------------------------------------

CREATE FUNCTION background_inquiry_route_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'background_inquiry_route rows are immutable except enabled';
END $$;
CREATE TRIGGER background_inquiry_route_no_rebind BEFORE UPDATE OF policy_version, route_id, route_profile_version, transport, model,
 max_input_tokens, max_output_tokens, global_bucket_id, provider_account_bucket_id, route_quota_bucket_id, remote_concurrency_bucket_id,
 owner_capacity, job_capacity, coalescing_delay_seconds, job_ttl_seconds ON background_inquiry_route
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_route_immutable();

-- Private rows leave only with their epoch: Clear/Reset advance it first, then erase.
CREATE FUNCTION background_inquiry_erase_after_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM universe WHERE id = OLD.universe_id AND privacy_epoch = OLD.privacy_epoch) THEN
  RAISE EXCEPTION '% rows are erased only after their privacy epoch ends', TG_TABLE_NAME;
 END IF;
 RETURN OLD;
END $$;

-- A request is written once; it must come from a live session of its own universe and epoch.
CREATE FUNCTION background_inquiry_consent_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Consent requests are immutable'; END IF;
 IF NOT EXISTS (SELECT 1 FROM device_session s JOIN universe u ON u.id = s.universe_id AND u.privacy_epoch = s.privacy_epoch
   WHERE s.id = NEW.session_id AND s.universe_id = NEW.universe_id AND s.privacy_epoch = NEW.privacy_epoch
     AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()) THEN
  RAISE EXCEPTION 'A consent request needs a live session of its universe and current epoch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER background_inquiry_consent_request_guard BEFORE INSERT OR UPDATE ON background_inquiry_consent_request
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_consent_request_guard();
CREATE TRIGGER background_inquiry_consent_request_erase BEFORE DELETE ON background_inquiry_consent_request
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_erase_after_epoch();

-- Consent changes only with a recorded request that says exactly this, one revision at a time.
CREATE FUNCTION background_inquiry_consent_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM background_inquiry_consent_request r
   WHERE r.id = NEW.request_id AND r.universe_id = NEW.universe_id AND r.privacy_epoch = NEW.privacy_epoch
     AND r.enabled = NEW.enabled AND r.daily_limit = NEW.daily_limit) THEN
  RAISE EXCEPTION 'Consent changes only with a recorded request for exactly this change';
 END IF;
 IF TG_OP = 'INSERT' AND NEW.revision <> 1 THEN RAISE EXCEPTION 'Consent starts at revision 1'; END IF;
 IF TG_OP = 'UPDATE' AND ((NEW.universe_id, NEW.privacy_epoch) IS DISTINCT FROM (OLD.universe_id, OLD.privacy_epoch)
   OR NEW.request_id = OLD.request_id OR NEW.revision <> OLD.revision + 1) THEN
  RAISE EXCEPTION 'A consent change is a new request and the next revision';
 END IF;
 NEW.changed_at := clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER background_inquiry_consent_guard BEFORE INSERT OR UPDATE ON background_inquiry_consent
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_consent_guard();
CREATE TRIGGER background_inquiry_consent_erase BEFORE DELETE ON background_inquiry_consent
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_erase_after_epoch();

-- An inquiry is created pending; it moves pending -> queued (the Job's identity, then its request
-- bytes once) -> one terminal outcome, or pending -> nothing_to_ask | withdrawn | failed. Nothing else.
CREATE FUNCTION background_inquiry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.status <> 'pending' THEN RAISE EXCEPTION 'An inquiry starts pending'; END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id, NEW.universe_id, NEW.privacy_epoch, NEW.kind, NEW.first_mail_at)
   IS DISTINCT FROM (OLD.id, OLD.universe_id, OLD.privacy_epoch, OLD.kind, OLD.first_mail_at) THEN
  RAISE EXCEPTION 'An inquiry keeps its identity';
 END IF;
 IF OLD.status NOT IN ('pending','queued') THEN RAISE EXCEPTION 'A closed inquiry does not change'; END IF;
 IF OLD.status = 'pending' THEN
  IF NEW.status = 'queued' THEN
   NEW.opened_at := clock_timestamp();
   RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('nothing_to_ask','withdrawn','failed') THEN RAISE EXCEPTION 'Illegal inquiry transition from pending'; END IF;
 ELSE
  IF (NEW.policy_version, NEW.job_id, NEW.step_id, NEW.context_id, NEW.request_id, NEW.job_bucket_id, NEW.through_sequence, NEW.pairs, NEW.opened_at)
    IS DISTINCT FROM (OLD.policy_version, OLD.job_id, OLD.step_id, OLD.context_id, OLD.request_id, OLD.job_bucket_id, OLD.through_sequence, OLD.pairs, OLD.opened_at) THEN
   RAISE EXCEPTION 'An opened inquiry keeps its Job';
  END IF;
  IF (NEW.request_hash, NEW.input_bytes) IS DISTINCT FROM (OLD.request_hash, OLD.input_bytes) AND OLD.request_hash IS NOT NULL THEN
   RAISE EXCEPTION 'An inquiry''s request bytes are recorded once';
  END IF;
  IF NEW.status = 'queued' THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('admitted','rejected','none','failed','withdrawn') OR NEW.request_hash IS NULL AND NEW.status IN ('admitted','rejected','none') THEN
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
 NEW.closed_at := clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER background_inquiry_guard BEFORE INSERT OR UPDATE ON background_inquiry
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_guard();
CREATE TRIGGER background_inquiry_erase BEFORE DELETE ON background_inquiry
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_erase_after_epoch();

-- Nothing is mailed without consent, while paused, or for a change another transaction made: mail
-- joins a pending inquiry of its universe and epoch, for a planet/region formed in this transaction.
CREATE FUNCTION inquiry_mail_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
 IF NOT EXISTS (SELECT 1 FROM atlas_delta d WHERE d.id = NEW.cause_delta_id AND d.universe_id = NEW.universe_id
   AND d.kind = 'place_formed' AND d.after->>'kind' IN ('planet','region') AND d.txid = pg_current_xact_id()) THEN
  RAISE EXCEPTION 'Inquiry mail is caused by a place formed in this transaction';
 END IF;
 IF (SELECT count(*) FROM inquiry_mail WHERE inquiry_id = NEW.inquiry_id) >= 16 THEN
  RAISE EXCEPTION 'An inquiry holds at most 16 causes';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inquiry_mail_guard BEFORE INSERT OR UPDATE ON inquiry_mail FOR EACH ROW EXECUTE FUNCTION inquiry_mail_guard();
CREATE TRIGGER inquiry_mail_erase BEFORE DELETE ON inquiry_mail FOR EACH ROW EXECUTE FUNCTION background_inquiry_erase_after_epoch();

-- The inquiry context family is used only by its own queued background Job, and such a Job uses no
-- other family (the ADR-0017 family routing, extended; cf. migration 0010).
CREATE FUNCTION reasoning_inquiry_context_family_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM reasoning_job WHERE id = NEW.job_id FOR UPDATE;
 IF NEW.source_policy_version = 'inquiry-bridge-between-places-v1' THEN
  IF NOT EXISTS (SELECT 1 FROM reasoning_job j JOIN background_inquiry i ON i.job_id = j.id
    WHERE j.id = NEW.job_id AND j.universe_id = NEW.universe_id AND j.privacy_epoch = NEW.privacy_epoch
      AND j.class = 'background_inquiry' AND j.wake_kind = 'dirty' AND j.status = 'queued'
      AND i.status = 'queued' AND i.context_id = NEW.id AND i.universe_id = NEW.universe_id AND i.privacy_epoch = NEW.privacy_epoch) THEN
   RAISE EXCEPTION 'An inquiry context belongs to its own queued background Job';
  END IF;
 ELSIF EXISTS (SELECT 1 FROM background_inquiry WHERE job_id = NEW.job_id) THEN
  RAISE EXCEPTION 'An inquiry Job cannot change context family';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_inquiry_context_family_guard BEFORE INSERT ON reasoning_context
 FOR EACH ROW EXECUTE FUNCTION reasoning_inquiry_context_family_guard();

-- ADR-0018 withdrawal, extended to idle background inquiry Jobs. They have no session: a Job is
-- cancelled only after its inquiry has recorded why it closed (consent off, pause, a stale context,
-- a stopped worker), in the same transaction, and expires only past its own deadline. The fenced
-- live-worker and session-bound idle branches (migration 0011) are unchanged.
CREATE OR REPLACE FUNCTION reasoning_withdrawal_clock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 legacy_authorized boolean;
 idle_authorized boolean;
 background_authorized boolean;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'Withdrawal time cannot be supplied on creation'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.withdrawn_at IS NOT NULL THEN
  IF NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
  THEN RAISE EXCEPTION 'Withdrawn Job cannot reactivate or change its retention clock'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.withdrawn_at IS NOT NULL THEN
  legacy_authorized := OLD.status IN ('running','waiting')
    AND OLD.lease_owner IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()
    AND OLD.lease_fence>0;
  idle_authorized := OLD.status IN ('queued','waiting') AND OLD.wake_kind='direct'
    AND (NEW.id,NEW.universe_id,NEW.privacy_epoch,NEW.wake_kind,NEW.deadline)
      IS NOT DISTINCT FROM (OLD.id,OLD.universe_id,OLD.privacy_epoch,OLD.wake_kind,OLD.deadline)
    AND (OLD.lease_owner IS NULL OR OLD.lease_expires_at<=clock_timestamp())
    AND OLD.lease_fence<9223372036854775807
    AND NEW.lease_fence=OLD.lease_fence+1
    AND EXISTS(
      SELECT 1 FROM reasoning_context_job_session b
      JOIN device_session s ON (s.id,s.universe_id)=(b.session_id,b.universe_id)
      JOIN universe u ON u.id=b.universe_id AND u.privacy_epoch=b.privacy_epoch
      WHERE (b.job_id,b.universe_id,b.privacy_epoch)=(NEW.id,NEW.universe_id,NEW.privacy_epoch)
       AND ((NEW.status='cancelled' AND s.revoked_at IS NULL
              AND s.expires_at>clock_timestamp() AND s.privacy_epoch=u.privacy_epoch)
         OR (NEW.status='expired' AND OLD.deadline<=clock_timestamp()))
    );
  background_authorized := OLD.status IN ('queued','waiting') AND OLD.wake_kind='dirty' AND OLD.class='background_inquiry'
    AND (NEW.id,NEW.universe_id,NEW.privacy_epoch,NEW.wake_kind,NEW.class,NEW.deadline,NEW.dirty_scope,NEW.through_sequence)
      IS NOT DISTINCT FROM (OLD.id,OLD.universe_id,OLD.privacy_epoch,OLD.wake_kind,OLD.class,OLD.deadline,OLD.dirty_scope,OLD.through_sequence)
    AND (OLD.lease_owner IS NULL OR OLD.lease_expires_at<=clock_timestamp())
    AND OLD.lease_fence<9223372036854775807
    AND NEW.lease_fence=OLD.lease_fence+1
    AND EXISTS(
      SELECT 1 FROM background_inquiry i JOIN universe u ON u.id=i.universe_id AND u.privacy_epoch=i.privacy_epoch
      WHERE (i.job_id,i.universe_id,i.privacy_epoch)=(NEW.id,NEW.universe_id,NEW.privacy_epoch)
       AND ((NEW.status='cancelled' AND i.status NOT IN ('pending','queued'))
         OR (NEW.status='expired' AND OLD.deadline<=clock_timestamp()))
    );
  IF NOT (COALESCE(legacy_authorized,false) OR COALESCE(idle_authorized,false) OR COALESCE(background_authorized,false))
    OR NEW.status NOT IN ('cancelled','expired')
    OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM reasoning_fairness_ready WHERE job_id=NEW.id)
    OR EXISTS(SELECT 1 FROM reasoning_step WHERE job_id=NEW.id AND status NOT IN ('succeeded','failed','cancelled','superseded'))
    OR EXISTS(SELECT 1 FROM reasoning_attempt a LEFT JOIN reasoning_accounting ac ON ac.attempt_id=a.id
       WHERE a.job_id=NEW.id AND (a.active OR ac.attempt_id IS NULL OR ac.output_authority<>'withdrawn'
          OR ac.state NOT IN ('not_sent','unknown','responded')))
  THEN RAISE EXCEPTION 'Withdrawal retention clock requires a safely withdrawn Job'; END IF;
  NEW.withdrawn_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE INDEX reasoning_job_background_idle_candidates ON reasoning_job(id)
 WHERE wake_kind='dirty' AND class='background_inquiry' AND status IN ('queued','waiting') AND withdrawn_at IS NULL;
