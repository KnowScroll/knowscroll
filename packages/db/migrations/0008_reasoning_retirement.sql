-- ADR-0015: seven-day private retention starts only at a proven safe withdrawal.
ALTER TABLE reasoning_job ADD COLUMN withdrawn_at timestamptz;
CREATE INDEX reasoning_job_retirement_candidates ON reasoning_job(id) WHERE withdrawn_at IS NOT NULL;
CREATE INDEX reasoning_accounting_purge_candidates ON reasoning_accounting(attempt_id)
 WHERE all_duties_closed_at IS NOT NULL AND liability_state='settled' AND remote_state='released'
 AND NOT reconciliation_hold AND NOT idempotency_hold;
CREATE FUNCTION reasoning_withdrawal_clock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  IF OLD.status NOT IN ('running','waiting') OR NEW.status NOT IN ('cancelled','expired')
    OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM reasoning_fairness_ready WHERE job_id=NEW.id)
    OR EXISTS(SELECT 1 FROM reasoning_step WHERE job_id=NEW.id AND status NOT IN ('succeeded','failed','cancelled','superseded'))
    OR EXISTS(SELECT 1 FROM reasoning_attempt a LEFT JOIN reasoning_accounting ac ON ac.attempt_id=a.id
       WHERE a.job_id=NEW.id AND (a.active OR ac.attempt_id IS NULL OR ac.output_authority<>'withdrawn'
          OR ac.state NOT IN ('not_sent','unknown','responded')))
  THEN RAISE EXCEPTION 'Withdrawal retention clock requires a safely withdrawn Job'; END IF;
  -- Ignore caller time: a backdated application value must never shorten retention.
  NEW.withdrawn_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_withdrawal_clock_guard BEFORE INSERT OR UPDATE ON reasoning_job
 FOR EACH ROW EXECUTE FUNCTION reasoning_withdrawal_clock_guard();
