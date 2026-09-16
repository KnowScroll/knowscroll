-- #55: private ready work and retained minimal fairness accounting are separate.
-- Canonical shared resource namespace: scheduler (policy version), then bucket UUID.
CREATE TABLE reasoning_fairness_policy (
 version reasoning_label PRIMARY KEY,
 policy_hash text NOT NULL CHECK(policy_hash ~ '^[0-9a-f]{64}$'),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object')
);
CREATE FUNCTION reasoning_fairness_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Fairness policy identity is immutable'; END $$;
CREATE TRIGGER reasoning_fairness_policy_guard BEFORE UPDATE OR DELETE ON reasoning_fairness_policy
 FOR EACH ROW EXECUTE FUNCTION reasoning_fairness_policy_guard();
CREATE TABLE reasoning_fairness_scheduler (
 policy_version reasoning_label PRIMARY KEY REFERENCES reasoning_fairness_policy(version),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),
 class_cursor integer NOT NULL DEFAULT 0 CHECK(class_cursor BETWEEN 0 AND 4),
 visit_generation bigint NOT NULL DEFAULT 0 CHECK(visit_generation>=0),
 inner_generation bigint NOT NULL DEFAULT 0 CHECK(inner_generation>=0),
 paused boolean NOT NULL DEFAULT false
);
CREATE TABLE reasoning_fairness_class (
 policy_version reasoning_label NOT NULL REFERENCES reasoning_fairness_scheduler(policy_version),
 class text NOT NULL CHECK(class IN ('interactive','active_continuity','accumulated_interpretation','background_inquiry','housekeeping')),
 credit bigint NOT NULL DEFAULT 0 CHECK(credit BETWEEN -9007199254740991 AND 9007199254740991),
 universe_cursor uuid,
 remaining reasoning_count,
 visit_generation bigint NOT NULL DEFAULT 0 CHECK(visit_generation>=0),
 open_universe_id uuid,
 universe_remaining reasoning_count NOT NULL DEFAULT 0,
 inner_generation bigint NOT NULL DEFAULT 0 CHECK(inner_generation>=0),
 PRIMARY KEY(policy_version,class)
);
CREATE TABLE reasoning_fairness_universe (
 policy_version reasoning_label NOT NULL,
 class text NOT NULL CHECK(class IN ('interactive','active_continuity','accumulated_interpretation','background_inquiry','housekeeping')),
 universe_id uuid NOT NULL REFERENCES universe(id),
 credit bigint NOT NULL DEFAULT 0 CHECK(credit BETWEEN -9007199254740991 AND 9007199254740991),
 candidate_cursor bigint NOT NULL DEFAULT 0 CHECK(candidate_cursor>=0),
 ready_count reasoning_count NOT NULL DEFAULT 0,
 PRIMARY KEY(policy_version,class,universe_id),
 FOREIGN KEY(policy_version,class) REFERENCES reasoning_fairness_class(policy_version,class)
);
CREATE INDEX reasoning_fairness_universe_ready_ring ON reasoning_fairness_universe(policy_version,class,universe_id) WHERE ready_count>0;
CREATE TABLE reasoning_fairness_ready (
 job_id uuid PRIMARY KEY REFERENCES reasoning_job(id) ON DELETE CASCADE,
 step_id uuid NOT NULL UNIQUE,
 context_id uuid NOT NULL,
 universe_id uuid NOT NULL,
 privacy_epoch integer NOT NULL CHECK(privacy_epoch>=0),
 seq bigserial NOT NULL UNIQUE,
 class text NOT NULL CHECK(class IN ('interactive','active_continuity','accumulated_interpretation','background_inquiry','housekeeping')),
 policy_version reasoning_label NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 input_tokens_upper_bound reasoning_count NOT NULL CHECK(input_tokens_upper_bound>0),
 max_output_tokens reasoning_count NOT NULL CHECK(max_output_tokens>0),
 cost_ceiling_micro_usd reasoning_count CHECK(cost_ceiling_micro_usd>0),
 deadline timestamptz NOT NULL,
 permit_ttl_ms integer NOT NULL CHECK(permit_ttl_ms BETWEEN 1 AND 60000),
 charge reasoning_count NOT NULL CHECK(charge>0),
 FOREIGN KEY(step_id,job_id,context_id,universe_id,privacy_epoch)
   REFERENCES reasoning_step(id,job_id,context_id,universe_id,privacy_epoch) ON DELETE CASCADE,
 FOREIGN KEY(policy_version,class,universe_id)
   REFERENCES reasoning_fairness_universe(policy_version,class,universe_id)
);
CREATE INDEX reasoning_fairness_ready_ring ON reasoning_fairness_ready(policy_version,class,universe_id,seq);
ALTER TABLE reasoning_accounting ADD CONSTRAINT reasoning_accounting_attempt_universe UNIQUE(attempt_id,universe_id);
CREATE TABLE reasoning_fairness_attempt (
 attempt_id uuid PRIMARY KEY,
 policy_version reasoning_label NOT NULL,
 class text NOT NULL CHECK(class IN ('interactive','active_continuity','accumulated_interpretation','background_inquiry','housekeeping')),
 universe_id uuid NOT NULL,
 reserved_charge reasoning_count NOT NULL CHECK(reserved_charge>0),
 recognized_charge reasoning_count NOT NULL,
 FOREIGN KEY(attempt_id,universe_id) REFERENCES reasoning_accounting(attempt_id,universe_id) ON DELETE CASCADE,
 FOREIGN KEY(policy_version,class,universe_id)
   REFERENCES reasoning_fairness_universe(policy_version,class,universe_id)
);
CREATE FUNCTION reasoning_fairness_attempt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.attempt_id,NEW.policy_version,NEW.class,NEW.universe_id,NEW.reserved_charge)
 IS DISTINCT FROM (OLD.attempt_id,OLD.policy_version,OLD.class,OLD.universe_id,OLD.reserved_charge)
 THEN RAISE EXCEPTION 'Fairness accounting binding is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_fairness_attempt_guard BEFORE UPDATE ON reasoning_fairness_attempt
 FOR EACH ROW EXECUTE FUNCTION reasoning_fairness_attempt_guard();
CREATE TABLE reasoning_fairness_delta (
 attempt_id uuid NOT NULL REFERENCES reasoning_fairness_attempt(attempt_id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision>=0),
 prior_charge reasoning_count NOT NULL,
 recognized_charge reasoning_count NOT NULL,
 class_delta bigint NOT NULL CHECK(class_delta BETWEEN -9007199254740991 AND 9007199254740991),
 universe_delta bigint NOT NULL CHECK(universe_delta BETWEEN -9007199254740991 AND 9007199254740991),
 class_refund_discarded reasoning_count NOT NULL,
 universe_refund_discarded reasoning_count NOT NULL,
 PRIMARY KEY(attempt_id,revision)
);
CREATE TRIGGER reasoning_fairness_delta_guard BEFORE UPDATE OR DELETE ON reasoning_fairness_delta
 FOR EACH ROW EXECUTE FUNCTION reasoning_evidence_guard();
