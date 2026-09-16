-- ADR-0012 storage only. No provider dispatch or new job consumer is enabled.
CREATE DOMAIN reasoning_label AS text CHECK (VALUE ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$');
CREATE DOMAIN reasoning_count AS bigint CHECK (VALUE BETWEEN 0 AND 9007199254740991);
CREATE DOMAIN reasoning_unit AS text CHECK (VALUE IN ('tokens','requests','slots','micro_usd'));
CREATE DOMAIN reasoning_dimension AS text CHECK (VALUE IN ('global_budget','owner_budget','provider_account','route_quota','request_rate','input_rate','output_rate','combined_rate','remote_concurrency','job_budget'));

CREATE TABLE reasoning_job (
 id uuid PRIMARY KEY, universe_id uuid NOT NULL REFERENCES universe(id), privacy_epoch integer NOT NULL CHECK (privacy_epoch>=0),
 status text NOT NULL CHECK (status IN ('queued','running','waiting','completed','failed','cancelled','expired')),
 class text NOT NULL CHECK (class IN ('interactive','active_continuity','accumulated_interpretation','background_inquiry','housekeeping')),
 budget_owner_id uuid NOT NULL CHECK (budget_owner_id=universe_id), policy_version reasoning_label NOT NULL,
 deadline timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 wake_kind text NOT NULL CHECK(wake_kind IN ('direct','dirty')), intent_id uuid, dirty_scope reasoning_label, through_sequence bigint CHECK(through_sequence>=0),
 lease_owner reasoning_label, lease_fence bigint NOT NULL DEFAULT 0 CHECK(lease_fence>=0), lease_expires_at timestamptz,
 CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_fence>0)),
 CHECK ((wake_kind='direct' AND intent_id IS NOT NULL AND dirty_scope IS NULL AND through_sequence IS NULL) OR
        (wake_kind='dirty' AND intent_id IS NULL AND dirty_scope IS NOT NULL AND through_sequence IS NOT NULL)),
 UNIQUE(id,universe_id,privacy_epoch), UNIQUE(universe_id,intent_id)
);
CREATE INDEX reasoning_job_ready ON reasoning_job(class,created_at,id) WHERE status='queued';
CREATE TABLE reasoning_context (
 id uuid PRIMARY KEY, job_id uuid NOT NULL, universe_id uuid NOT NULL, privacy_epoch integer NOT NULL,
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'), policy_version reasoning_label NOT NULL, source_policy_version reasoning_label NOT NULL,
 FOREIGN KEY(job_id,universe_id,privacy_epoch) REFERENCES reasoning_job(id,universe_id,privacy_epoch),
 UNIQUE(id,job_id,universe_id,privacy_epoch), UNIQUE(id,universe_id,privacy_epoch)
);
CREATE TABLE reasoning_context_read (
 context_id uuid NOT NULL, universe_id uuid NOT NULL, privacy_epoch integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('entity','source','permission','policy')), scope_kind text NOT NULL CHECK(scope_kind IN ('universe','public')),
 scope_universe_id uuid, entity_key reasoning_label NOT NULL, revision bigint NOT NULL CHECK(revision>=0),
 CHECK ((scope_kind='universe' AND scope_universe_id IS NOT NULL AND scope_universe_id=universe_id) OR (scope_kind='public' AND scope_universe_id IS NULL)),
 FOREIGN KEY(context_id,universe_id,privacy_epoch) REFERENCES reasoning_context(id,universe_id,privacy_epoch) ON DELETE CASCADE,
 PRIMARY KEY(context_id,kind,scope_kind,entity_key)
);
CREATE TABLE reasoning_step (
 id uuid PRIMARY KEY, job_id uuid NOT NULL, universe_id uuid NOT NULL, privacy_epoch integer NOT NULL,
 context_id uuid NOT NULL, ordinal integer NOT NULL CHECK(ordinal>0),
 status text NOT NULL CHECK(status IN ('pending','active','awaiting_reconciliation','succeeded','failed','cancelled','superseded')),
 FOREIGN KEY(job_id,universe_id,privacy_epoch) REFERENCES reasoning_job(id,universe_id,privacy_epoch),
 FOREIGN KEY(context_id,job_id,universe_id,privacy_epoch) REFERENCES reasoning_context(id,job_id,universe_id,privacy_epoch),
 UNIQUE(job_id,ordinal), UNIQUE(id,job_id,context_id,universe_id,privacy_epoch)
);

-- Retained minimal identity: deliberately no FK or content reference to the private graph.
CREATE TABLE reasoning_accounting (
 attempt_id uuid PRIMARY KEY, universe_id uuid NOT NULL REFERENCES universe(id), privacy_epoch integer NOT NULL CHECK(privacy_epoch>=0),
 request_id uuid NOT NULL UNIQUE, route_id reasoning_label NOT NULL, route_profile_version reasoning_label NOT NULL,
 max_output_tokens reasoning_count NOT NULL CHECK(max_output_tokens>0), deadline timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','dispatch_committed','unknown','responded','not_sent')),
 dispatch_id uuid UNIQUE, dispatch_committed_at timestamptz,
 output_authority text NOT NULL DEFAULT 'eligible' CHECK(output_authority IN ('eligible','withdrawn')),
 liability_state text NOT NULL DEFAULT 'held' CHECK(liability_state IN ('held','partially_settled','settled')),
 remote_state text NOT NULL DEFAULT 'held' CHECK(remote_state IN ('held','released')),
 remote_disposition text NOT NULL DEFAULT 'unconfirmed' CHECK(remote_disposition IN ('unconfirmed','terminal','not_sent')),
 reconciliation_hold boolean NOT NULL DEFAULT true, idempotency_hold boolean NOT NULL DEFAULT true,
 closure_basis text CHECK(closure_basis IN ('evidence','operator_risk')), risk_closure_id uuid,
 all_duties_closed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((state IN ('reserved','not_sent') AND dispatch_id IS NULL AND dispatch_committed_at IS NULL) OR
        (state IN ('dispatch_committed','unknown','responded') AND dispatch_id IS NOT NULL AND dispatch_committed_at IS NOT NULL)),
 CHECK(state<>'not_sent' OR (output_authority='withdrawn' AND remote_disposition='not_sent')),
 CHECK(remote_disposition<>'not_sent' OR state='not_sent'),
 CHECK ((closure_basis IS NULL AND risk_closure_id IS NULL AND all_duties_closed_at IS NULL) OR
        (closure_basis='evidence' AND risk_closure_id IS NULL AND all_duties_closed_at IS NOT NULL AND remote_disposition IN ('terminal','not_sent')) OR
        (closure_basis='operator_risk' AND risk_closure_id IS NOT NULL AND all_duties_closed_at IS NOT NULL)),
 CHECK(all_duties_closed_at IS NULL OR (liability_state='settled' AND remote_state='released' AND NOT reconciliation_hold AND NOT idempotency_hold)),
 UNIQUE(attempt_id,universe_id,privacy_epoch), UNIQUE(attempt_id,dispatch_id),
 UNIQUE(attempt_id,universe_id,privacy_epoch,request_id,dispatch_id,route_id,route_profile_version)
);
CREATE INDEX reasoning_accounting_scope ON reasoning_accounting(universe_id,attempt_id);
CREATE INDEX reasoning_accounting_cleanup ON reasoning_accounting(universe_id,all_duties_closed_at) WHERE all_duties_closed_at IS NOT NULL;
CREATE TABLE reasoning_bucket (
 id uuid PRIMARY KEY, dimension reasoning_dimension NOT NULL, unit reasoning_unit NOT NULL, window_id reasoning_label,
 capacity reasoning_count NOT NULL, reserved reasoning_count NOT NULL DEFAULT 0, consumed reasoning_count NOT NULL DEFAULT 0,
 paused boolean NOT NULL DEFAULT false,
 CHECK ((dimension NOT IN ('request_rate','input_rate','output_rate','combined_rate','remote_concurrency')) OR
        (dimension='request_rate' AND unit='requests') OR (dimension IN ('input_rate','output_rate','combined_rate') AND unit='tokens') OR
        (dimension='remote_concurrency' AND unit='slots')),
 UNIQUE(id,dimension,unit)
);
CREATE TABLE reasoning_permit (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL UNIQUE, universe_id uuid NOT NULL, privacy_epoch integer NOT NULL,
 reservation_set_id uuid NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','consumed','revoked','expired')),
 dispatch_id uuid, consumed_at timestamptz, closed_at timestamptz,
 CHECK ((state='reserved' AND dispatch_id IS NULL AND consumed_at IS NULL AND closed_at IS NULL) OR
        (state='consumed' AND dispatch_id IS NOT NULL AND consumed_at IS NOT NULL AND closed_at IS NULL) OR
        (state IN ('revoked','expired') AND dispatch_id IS NULL AND consumed_at IS NULL AND closed_at IS NOT NULL)),
 FOREIGN KEY(attempt_id,universe_id,privacy_epoch) REFERENCES reasoning_accounting(attempt_id,universe_id,privacy_epoch) ON DELETE CASCADE,
 FOREIGN KEY(attempt_id,dispatch_id) REFERENCES reasoning_accounting(attempt_id,dispatch_id) DEFERRABLE INITIALLY DEFERRED,
 UNIQUE(id,attempt_id,universe_id,privacy_epoch,reservation_set_id), UNIQUE(attempt_id,reservation_set_id)
);
CREATE TABLE reasoning_reservation (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL, reservation_set_id uuid NOT NULL, bucket_id uuid NOT NULL,
 dimension reasoning_dimension NOT NULL, unit reasoning_unit NOT NULL, amount reasoning_count NOT NULL CHECK(amount>0),
 state text NOT NULL DEFAULT 'held' CHECK(state IN ('held','accounted','released')),
 FOREIGN KEY(attempt_id,reservation_set_id) REFERENCES reasoning_permit(attempt_id,reservation_set_id) ON DELETE CASCADE,
 FOREIGN KEY(bucket_id,dimension,unit) REFERENCES reasoning_bucket(id,dimension,unit), UNIQUE(attempt_id,bucket_id)
);
CREATE TABLE reasoning_attempt (
 id uuid PRIMARY KEY, job_id uuid NOT NULL, step_id uuid NOT NULL, context_id uuid NOT NULL,
 universe_id uuid NOT NULL, privacy_epoch integer NOT NULL, ordinal integer NOT NULL CHECK(ordinal>0), previous_attempt_id uuid,
 previous_ordinal integer GENERATED ALWAYS AS (CASE WHEN ordinal>1 THEN ordinal-1 END) STORED,
 lease_fence bigint NOT NULL CHECK(lease_fence>0), request_hash text NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 permit_id uuid NOT NULL UNIQUE, reservation_set_id uuid NOT NULL, active boolean NOT NULL DEFAULT true,
 CHECK ((ordinal=1 AND previous_attempt_id IS NULL) OR (ordinal>1 AND previous_attempt_id IS NOT NULL AND previous_attempt_id<>id)),
 FOREIGN KEY(id,universe_id,privacy_epoch) REFERENCES reasoning_accounting(attempt_id,universe_id,privacy_epoch),
 FOREIGN KEY(step_id,job_id,context_id,universe_id,privacy_epoch) REFERENCES reasoning_step(id,job_id,context_id,universe_id,privacy_epoch),
 FOREIGN KEY(permit_id,id,universe_id,privacy_epoch,reservation_set_id) REFERENCES reasoning_permit(id,attempt_id,universe_id,privacy_epoch,reservation_set_id),
 UNIQUE(step_id,ordinal), UNIQUE(id,step_id,ordinal,universe_id,privacy_epoch),
 FOREIGN KEY(previous_attempt_id,step_id,previous_ordinal,universe_id,privacy_epoch) REFERENCES reasoning_attempt(id,step_id,ordinal,universe_id,privacy_epoch) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX reasoning_attempt_one_active ON reasoning_attempt(step_id) WHERE active;
CREATE TABLE reasoning_receipt (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL, universe_id uuid NOT NULL, privacy_epoch integer NOT NULL,
 request_id uuid NOT NULL, dispatch_id uuid NOT NULL, route_id reasoning_label NOT NULL, route_profile_version reasoning_label NOT NULL,
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 evidence_kind text NOT NULL CHECK(evidence_kind IN ('original_transport','provider_lookup','operator_reconciliation')),
 observed_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 remote_disposition text NOT NULL CHECK(remote_disposition IN ('terminal','unconfirmed')),
 outcome text NOT NULL CHECK(outcome IN ('success','refusal','error','unclassified')),
 http_status integer CHECK(http_status BETWEEN 100 AND 599),
 input_tokens reasoning_count, output_tokens reasoning_count, cache_read_tokens reasoning_count, cache_write_tokens reasoning_count, cost_micro_usd reasoning_count,
 FOREIGN KEY(attempt_id,universe_id,privacy_epoch,request_id,dispatch_id,route_id,route_profile_version)
   REFERENCES reasoning_accounting(attempt_id,universe_id,privacy_epoch,request_id,dispatch_id,route_id,route_profile_version) ON DELETE CASCADE,
 UNIQUE(id,attempt_id), UNIQUE(id,attempt_id,fingerprint)
);
CREATE TABLE reasoning_settlement (
 id uuid PRIMARY KEY, attempt_id uuid NOT NULL, receipt_id uuid NOT NULL, receipt_fingerprint text NOT NULL,
 revision integer NOT NULL CHECK(revision>0), supersedes_settlement_id uuid,
 previous_revision integer GENERATED ALWAYS AS (CASE WHEN revision>1 THEN revision-1 END) STORED,
 basis text NOT NULL CHECK(basis IN ('measured','conservative_closure')),
 liability text NOT NULL CHECK(liability IN ('held','partially_settled','settled')),
 remote_concurrency text NOT NULL CHECK(remote_concurrency IN ('held','released')),
 input_tokens reasoning_count, output_tokens reasoning_count, cache_read_tokens reasoning_count, cache_write_tokens reasoning_count, cost_micro_usd reasoning_count,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((revision=1 AND supersedes_settlement_id IS NULL) OR (revision>1 AND supersedes_settlement_id IS NOT NULL AND supersedes_settlement_id<>id)),
 FOREIGN KEY(receipt_id,attempt_id,receipt_fingerprint) REFERENCES reasoning_receipt(id,attempt_id,fingerprint) ON DELETE CASCADE,
 UNIQUE(attempt_id,receipt_id), UNIQUE(attempt_id,revision), UNIQUE(id,attempt_id,revision), UNIQUE(id,attempt_id),
 FOREIGN KEY(supersedes_settlement_id,attempt_id,previous_revision) REFERENCES reasoning_settlement(id,attempt_id,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE reasoning_settlement_adjustment (
 settlement_id uuid NOT NULL, attempt_id uuid NOT NULL, bucket_id uuid NOT NULL, unit reasoning_unit NOT NULL,
 delta bigint NOT NULL CHECK(delta BETWEEN -9007199254740991 AND 9007199254740991),
 FOREIGN KEY(settlement_id,attempt_id) REFERENCES reasoning_settlement(id,attempt_id) ON DELETE CASCADE,
 FOREIGN KEY(attempt_id,bucket_id) REFERENCES reasoning_reservation(attempt_id,bucket_id),
 PRIMARY KEY(settlement_id,bucket_id)
);

CREATE FUNCTION reasoning_accounting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.all_duties_closed_at IS NULL OR OLD.all_duties_closed_at > clock_timestamp()-interval '30 days'
     OR OLD.liability_state<>'settled' OR OLD.remote_state<>'released' OR OLD.reconciliation_hold OR OLD.idempotency_hold THEN
   RAISE EXCEPTION 'Reasoning accounting retention duty remains';
  END IF;
  RETURN OLD;
 END IF;
 IF (NEW.attempt_id,NEW.universe_id,NEW.privacy_epoch,NEW.request_id,NEW.route_id,NEW.route_profile_version,NEW.max_output_tokens,NEW.deadline)
   IS DISTINCT FROM (OLD.attempt_id,OLD.universe_id,OLD.privacy_epoch,OLD.request_id,OLD.route_id,OLD.route_profile_version,OLD.max_output_tokens,OLD.deadline) THEN
  RAISE EXCEPTION 'Reasoning accounting identity is immutable';
 END IF;
 IF OLD.dispatch_id IS NOT NULL AND (NEW.dispatch_id,NEW.dispatch_committed_at) IS DISTINCT FROM (OLD.dispatch_id,OLD.dispatch_committed_at) THEN
  RAISE EXCEPTION 'Reasoning dispatch identity is immutable';
 END IF;
 IF OLD.output_authority='withdrawn' AND NEW.output_authority<>'withdrawn' THEN RAISE EXCEPTION 'Reasoning output cannot regain authority'; END IF;
 IF NEW.state<>OLD.state AND NOT ((OLD.state='reserved' AND NEW.state IN ('dispatch_committed','not_sent')) OR
   (OLD.state='dispatch_committed' AND NEW.state IN ('unknown','responded')) OR (OLD.state='unknown' AND NEW.state='responded')) THEN
  RAISE EXCEPTION 'Illegal reasoning accounting transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_accounting_guard BEFORE UPDATE OR DELETE ON reasoning_accounting FOR EACH ROW EXECUTE FUNCTION reasoning_accounting_guard();
CREATE FUNCTION reasoning_permit_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.attempt_id,NEW.universe_id,NEW.privacy_epoch,NEW.reservation_set_id,NEW.expires_at)
 IS DISTINCT FROM (OLD.id,OLD.attempt_id,OLD.universe_id,OLD.privacy_epoch,OLD.reservation_set_id,OLD.expires_at) THEN
  RAISE EXCEPTION 'Reasoning permit identity is immutable';
 END IF;
 IF OLD.state<>'reserved' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Reasoning permit is already consumed or closed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_permit_guard BEFORE UPDATE ON reasoning_permit FOR EACH ROW EXECUTE FUNCTION reasoning_permit_guard();
CREATE FUNCTION reasoning_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM reasoning_accounting WHERE attempt_id=OLD.attempt_id) THEN
  RAISE EXCEPTION 'Reasoning evidence is append-only until accounting retention purge';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER reasoning_receipt_guard BEFORE UPDATE OR DELETE ON reasoning_receipt FOR EACH ROW EXECUTE FUNCTION reasoning_evidence_guard();
CREATE TRIGGER reasoning_settlement_guard BEFORE UPDATE OR DELETE ON reasoning_settlement FOR EACH ROW EXECUTE FUNCTION reasoning_evidence_guard();
CREATE TRIGGER reasoning_adjustment_guard BEFORE UPDATE OR DELETE ON reasoning_settlement_adjustment FOR EACH ROW EXECUTE FUNCTION reasoning_evidence_guard();
