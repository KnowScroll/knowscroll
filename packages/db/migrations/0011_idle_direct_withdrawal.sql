-- ADR-0018: trusted idle direct closure extends, never replaces, fenced withdrawal.
CREATE OR REPLACE FUNCTION reasoning_withdrawal_clock_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
 legacy_authorized boolean;
 idle_authorized boolean;
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
  IF NOT (COALESCE(legacy_authorized,false) OR COALESCE(idle_authorized,false))
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
CREATE INDEX reasoning_job_idle_expiry_candidates ON reasoning_job(id)
 WHERE wake_kind='direct' AND status IN ('queued','waiting') AND withdrawn_at IS NULL;
