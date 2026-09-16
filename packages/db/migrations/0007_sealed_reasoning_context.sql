-- ADR-0014: canonical private bytes and exact typed dependencies; no provider enablement.
CREATE TABLE reasoning_context_payload (
 context_id uuid PRIMARY KEY,
 universe_id uuid NOT NULL,
 privacy_epoch integer NOT NULL CHECK(privacy_epoch>=0),
 canonical_payload text NOT NULL CHECK(octet_length(canonical_payload) BETWEEN 1 AND 65536),
 content_hash text NOT NULL CHECK(content_hash ~ '^[0-9a-f]{64}$'),
 read_set_hash text NOT NULL CHECK(read_set_hash ~ '^[0-9a-f]{64}$'),
 FOREIGN KEY(context_id,universe_id,privacy_epoch) REFERENCES reasoning_context(id,universe_id,privacy_epoch) ON DELETE CASCADE,
 UNIQUE(context_id,universe_id,privacy_epoch)
);
CREATE TABLE reasoning_context_dependency (
 context_id uuid NOT NULL,
 universe_id uuid NOT NULL,
 privacy_epoch integer NOT NULL CHECK(privacy_epoch>=0),
 identity text NOT NULL CHECK(length(identity) BETWEEN 1 AND 192),
 canonical_dependency text NOT NULL CHECK(octet_length(canonical_dependency) BETWEEN 1 AND 8192),
 PRIMARY KEY(context_id,identity),
 FOREIGN KEY(context_id,universe_id,privacy_epoch) REFERENCES reasoning_context(id,universe_id,privacy_epoch) ON DELETE CASCADE,
 FOREIGN KEY(context_id,universe_id,privacy_epoch) REFERENCES reasoning_context_payload(context_id,universe_id,privacy_epoch) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION reasoning_context_seal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bound_hash text;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Sealed context is immutable'; END IF;
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM reasoning_context WHERE id=OLD.context_id) THEN RAISE EXCEPTION 'Sealed context erases only with its context'; END IF;
  RETURN OLD;
 END IF;
 -- Serialize publication with both typed and legacy read insertion.
 SELECT content_hash INTO bound_hash FROM reasoning_context WHERE id=NEW.context_id FOR UPDATE;
 IF TG_TABLE_NAME='reasoning_context_payload' THEN
  IF bound_hash IS DISTINCT FROM NEW.content_hash THEN RAISE EXCEPTION 'Context seal hash mismatch'; END IF;
  IF EXISTS(SELECT 1 FROM reasoning_context_read WHERE context_id=NEW.context_id)
     OR EXISTS(SELECT 1 FROM reasoning_attempt WHERE context_id=NEW.context_id)
  THEN RAISE EXCEPTION 'Legacy or used context cannot be sealed'; END IF;
 ELSE
  IF EXISTS(SELECT 1 FROM reasoning_context_payload WHERE context_id=NEW.context_id)
  THEN RAISE EXCEPTION 'Context dependencies are already sealed'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_context_payload_guard BEFORE INSERT OR UPDATE OR DELETE ON reasoning_context_payload
 FOR EACH ROW EXECUTE FUNCTION reasoning_context_seal_guard();
CREATE TRIGGER reasoning_context_dependency_guard BEFORE INSERT OR UPDATE OR DELETE ON reasoning_context_dependency
 FOR EACH ROW EXECUTE FUNCTION reasoning_context_seal_guard();
CREATE FUNCTION reasoning_context_legacy_seal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM reasoning_context WHERE id=NEW.context_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM reasoning_context_payload WHERE context_id=NEW.context_id)
 THEN RAISE EXCEPTION 'Context is sealed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reasoning_context_legacy_seal_guard BEFORE INSERT ON reasoning_context_read
 FOR EACH ROW EXECUTE FUNCTION reasoning_context_legacy_seal_guard();
