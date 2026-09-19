-- ADR-0019: a completed/failed private graph gets a database-authoritative clock.
-- Legacy rows remain NULL; no terminal time is inferred or backfilled.
ALTER TABLE reasoning_job ADD COLUMN finished_at timestamptz;
ALTER TABLE reasoning_job ADD CONSTRAINT reasoning_job_retirement_clock_kind CHECK (
 finished_at IS NULL OR (status IN ('completed','failed') AND withdrawn_at IS NULL)
);
CREATE INDEX reasoning_job_finished_retirement_candidates ON reasoning_job(id)
 WHERE finished_at IS NOT NULL;

CREATE FUNCTION reasoning_finished_clock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.finished_at IS NOT NULL THEN RAISE EXCEPTION 'Finish time cannot be supplied on creation'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.finished_at IS NOT NULL THEN
  IF NEW.finished_at IS DISTINCT FROM OLD.finished_at OR NEW.status IS DISTINCT FROM OLD.status
    OR NEW.lease_fence IS DISTINCT FROM OLD.lease_fence
    OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL
  THEN RAISE EXCEPTION 'Finished Job cannot reactivate or change its retention clock or fence'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.status IN ('completed','failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
  IF OLD.status NOT IN ('running','waiting')
    OR OLD.lease_owner IS NULL OR OLD.lease_expires_at IS NULL OR OLD.lease_expires_at<=clock_timestamp()
    OR OLD.lease_fence<=0 OR NEW.lease_fence IS DISTINCT FROM OLD.lease_fence
    OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NOT NULL
    OR NEW.lease_owner IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
    OR EXISTS(SELECT 1 FROM reasoning_fairness_ready WHERE job_id=NEW.id)
    OR EXISTS(SELECT 1 FROM reasoning_step WHERE job_id=NEW.id AND status NOT IN ('succeeded','failed','cancelled','superseded'))
    OR EXISTS(SELECT 1 FROM reasoning_attempt a LEFT JOIN reasoning_accounting ac ON ac.attempt_id=a.id
      WHERE a.job_id=NEW.id AND (a.active OR ac.attempt_id IS NULL OR ac.output_authority<>'withdrawn'
        OR ac.state NOT IN ('not_sent','unknown','responded')))
  THEN RAISE EXCEPTION 'Finish retention clock requires a safely terminal Job'; END IF;
  -- Clock is assigned even when the application supplies NULL or a backdated value.
  NEW.finished_at:=clock_timestamp();
 ELSIF NEW.finished_at IS NOT NULL THEN
  RAISE EXCEPTION 'Finish retention clock requires a new safe terminal transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_finished_clock_guard BEFORE INSERT OR UPDATE ON reasoning_job
 FOR EACH ROW EXECUTE FUNCTION reasoning_finished_clock_guard();
