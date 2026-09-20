-- ADR-0024: KnowScroll's own publication gates. Eligibility is derived from recorded verdicts,
-- never set by hand, and stand-in media can only ever be eligible inside a disposable test
-- database. No feed, binding, selection or witness is added here.

CREATE TABLE publication_policy (
 version text PRIMARY KEY CHECK (version ~ '^[a-z0-9.-]{1,64}$'),
 required_gates text[] NOT NULL CHECK (array_length(required_gates,1) BETWEEN 1 AND 32),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE publication_gate_result (
 id uuid PRIMARY KEY,
 generated_reel_id uuid NOT NULL REFERENCES generated_reel(id),
 policy_version text NOT NULL REFERENCES publication_policy(version),
 gate text NOT NULL CHECK (gate ~ '^[a-z_]{3,40}$'),
 verdict text NOT NULL CHECK (verdict IN ('pass','pass_with_label','fail','unavailable')),
 /** Why, in KnowScroll's own words: what was compared and what was observed. */
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (generated_reel_id, policy_version, gate),
 /** An unavailable gate states why it could not be decided (no witness model, for example). */
 CHECK (verdict <> 'unavailable' OR evidence ? 'reason')
);
CREATE INDEX publication_gate_result_reel ON publication_gate_result(generated_reel_id, policy_version);

-- Repetition fingerprints live with the Reel so a second, near-identical one can be refused.
ALTER TABLE generated_reel ADD COLUMN template_fingerprint text
 CHECK (template_fingerprint IS NULL OR template_fingerprint ~ '^[0-9a-f]{64}$');
ALTER TABLE generated_reel ADD COLUMN argument_fingerprint text
 CHECK (argument_fingerprint IS NULL OR argument_fingerprint ~ '^[0-9a-f]{64}$');

-- Availability gains the two decided states. 'eligible' requires every required gate to pass;
-- 'test_eligible' is the stand-in fence and is impossible outside a disposable test database.
ALTER TABLE generated_reel DROP CONSTRAINT generated_reel_availability_check;
ALTER TABLE generated_reel ADD CONSTRAINT generated_reel_availability_check
 CHECK (availability IN ('imported','eligible','test_eligible','rejected','withdrawn'));
ALTER TABLE generated_reel ADD COLUMN availability_policy_version text REFERENCES publication_policy(version);
ALTER TABLE generated_reel ADD COLUMN availability_decided_at timestamptz;
ALTER TABLE generated_reel ADD CONSTRAINT generated_reel_availability_decision
 CHECK (availability = 'imported' OR (availability_policy_version IS NOT NULL AND availability_decided_at IS NOT NULL));

/** True only in a disposable test database, by name. The owner's database can never satisfy it. */
CREATE FUNCTION knowscroll_disposable_test_database() RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT current_database() LIKE 'knowscroll\_test\_%'
$$;

-- generated_reel was immutable under 0013. It now takes exactly one kind of change: a derived
-- availability decision with its fingerprints. Identity, lineage and provenance stay immutable.
DROP TRIGGER generated_reel_immutable ON generated_reel;
CREATE TRIGGER generated_reel_no_delete BEFORE DELETE ON generated_reel
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

CREATE FUNCTION generated_reel_availability_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE required text[]; decided integer; blocking integer;
BEGIN
 IF (NEW.id, NEW.attempt_id, NEW.brief_id, NEW.engine_id, NEW.cutroom_run_id, NEW.media_sha256,
     NEW.engine_path, NEW.provider_mode, NEW.truth_state, NEW.generated_label, NEW.lineage, NEW.created_at)
  IS DISTINCT FROM
    (OLD.id, OLD.attempt_id, OLD.brief_id, OLD.engine_id, OLD.cutroom_run_id, OLD.media_sha256,
     OLD.engine_path, OLD.provider_mode, OLD.truth_state, OLD.generated_label, OLD.lineage, OLD.created_at)
 THEN RAISE EXCEPTION 'A generated Reel''s identity, lineage and provenance are immutable'; END IF;

 IF OLD.availability IN ('withdrawn','rejected') AND NEW.availability IS DISTINCT FROM OLD.availability THEN
  RAISE EXCEPTION 'A withdrawn or rejected Reel does not become available again';
 END IF;
 IF (OLD.template_fingerprint IS NOT NULL AND NEW.template_fingerprint IS DISTINCT FROM OLD.template_fingerprint)
  OR (OLD.argument_fingerprint IS NOT NULL AND NEW.argument_fingerprint IS DISTINCT FROM OLD.argument_fingerprint)
 THEN RAISE EXCEPTION 'A Reel''s repetition fingerprints are written once'; END IF;

 IF NEW.availability = 'test_eligible' THEN
  IF NOT knowscroll_disposable_test_database() THEN
   RAISE EXCEPTION 'test_eligible exists only in a disposable knowscroll_test_* database';
  END IF;
  IF NEW.provider_mode <> 'standin' THEN
   RAISE EXCEPTION 'test_eligible is for stand-in provenance only';
  END IF;
 END IF;

 IF NEW.availability IN ('eligible','test_eligible') THEN
  SELECT p.required_gates INTO required FROM publication_policy p WHERE p.version = NEW.availability_policy_version;
  IF required IS NULL THEN RAISE EXCEPTION 'An availability decision names a known publication policy'; END IF;
  SELECT count(*) INTO decided FROM publication_gate_result r
   WHERE r.generated_reel_id = NEW.id AND r.policy_version = NEW.availability_policy_version
     AND r.gate = ANY(required);
  IF decided <> array_length(required,1) THEN
   RAISE EXCEPTION 'Every required gate needs a recorded verdict before an availability decision';
  END IF;
  SELECT count(*) INTO blocking FROM publication_gate_result r
   WHERE r.generated_reel_id = NEW.id AND r.policy_version = NEW.availability_policy_version
     AND r.gate = ANY(required) AND r.verdict IN ('fail','unavailable');
  -- 'eligible' needs every required gate decided in its favour. 'test_eligible' is explicitly a
  -- stand-in proof state, so it tolerates gates that no implementation can decide yet, and the
  -- database above has already refused it anywhere but a disposable test database.
  IF NEW.availability = 'eligible' AND blocking > 0 THEN
   RAISE EXCEPTION 'A Reel is eligible only when every required gate passed';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generated_reel_availability_guard BEFORE UPDATE ON generated_reel
 FOR EACH ROW EXECUTE FUNCTION generated_reel_availability_guard();

CREATE TRIGGER publication_gate_result_immutable BEFORE UPDATE OR DELETE ON publication_gate_result
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER publication_policy_immutable BEFORE UPDATE OR DELETE ON publication_policy
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- The first policy: every gate this slice defines is required, witness included, which is why no
-- generated Reel can be 'eligible' until a Visual Witness implementation exists.
INSERT INTO publication_policy(version, required_gates) VALUES (
 'publication-v1',
 ARRAY['lineage_complete','source_support','engine_record','media_conformance','truth_label','repetition','witness_alignment']
);
