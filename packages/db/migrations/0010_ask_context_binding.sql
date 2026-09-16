-- ADR-0017: an Ask context consumes a separately authorized Job; it never creates one.
ALTER TABLE explicit_ask ADD CONSTRAINT explicit_ask_context_scope UNIQUE(id,universe_id,privacy_epoch,session_id);
ALTER TABLE reasoning_context_job_session ADD CONSTRAINT reasoning_context_job_session_scope UNIQUE(job_id,universe_id,privacy_epoch,session_id);
CREATE TABLE reasoning_context_job_ask (
 job_id uuid PRIMARY KEY,
 universe_id uuid NOT NULL,
 privacy_epoch integer NOT NULL CHECK(privacy_epoch>=0),
 session_id uuid NOT NULL,
 ask_id uuid NOT NULL,
 FOREIGN KEY(job_id,universe_id,privacy_epoch,session_id) REFERENCES reasoning_context_job_session(job_id,universe_id,privacy_epoch,session_id) ON DELETE CASCADE,
 FOREIGN KEY(ask_id,universe_id,privacy_epoch,session_id) REFERENCES explicit_ask(id,universe_id,privacy_epoch,session_id)
);
CREATE FUNCTION reasoning_context_job_ask_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Ask Job binding is immutable'; END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM reasoning_job WHERE id=OLD.job_id) THEN RAISE EXCEPTION 'Ask Job binding erases only with its Job'; END IF;
  RETURN OLD;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM reasoning_job WHERE id=NEW.job_id AND universe_id=NEW.universe_id AND privacy_epoch=NEW.privacy_epoch
  AND wake_kind='direct' AND intent_id=NEW.ask_id AND status='queued' AND deadline>clock_timestamp())
 THEN RAISE EXCEPTION 'Ask binding requires its queued direct Job'; END IF;
 IF EXISTS(SELECT 1 FROM reasoning_context WHERE job_id=NEW.job_id AND source_policy_version<>'ask-editorial-asset-pointer-v1')
 THEN RAISE EXCEPTION 'Job already uses another context family'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_context_job_ask_guard BEFORE INSERT OR UPDATE OR DELETE ON reasoning_context_job_ask
 FOR EACH ROW EXECUTE FUNCTION reasoning_context_job_ask_guard();
CREATE FUNCTION reasoning_ask_job_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM reasoning_context_job_ask WHERE job_id=OLD.id) AND
  (NEW.id,NEW.universe_id,NEW.privacy_epoch,NEW.intent_id,NEW.wake_kind) IS DISTINCT FROM (OLD.id,OLD.universe_id,OLD.privacy_epoch,OLD.intent_id,OLD.wake_kind)
 THEN RAISE EXCEPTION 'Ask Job identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_ask_job_identity_guard BEFORE UPDATE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION reasoning_ask_job_identity_guard();
CREATE FUNCTION reasoning_ask_context_family_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_policy_version='ask-editorial-asset-pointer-v1' THEN
  IF NOT EXISTS(SELECT 1 FROM reasoning_context_job_ask WHERE job_id=NEW.job_id AND universe_id=NEW.universe_id AND privacy_epoch=NEW.privacy_epoch)
  THEN RAISE EXCEPTION 'Ask context requires its immutable binding'; END IF;
 ELSIF EXISTS(SELECT 1 FROM reasoning_context_job_ask WHERE job_id=NEW.job_id) THEN
  RAISE EXCEPTION 'Ask Job cannot change context family';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_ask_context_family_guard BEFORE INSERT ON reasoning_context FOR EACH ROW EXECUTE FUNCTION reasoning_ask_context_family_guard();
