-- ADR-0016: immutable literal direct-intent source facts, no reasoning admission.
ALTER TABLE ledger DROP CONSTRAINT ledger_kind_check;
ALTER TABLE ledger ADD CONSTRAINT ledger_kind_check CHECK(kind IN ('exposure','keep','ask'));
ALTER TABLE exposure ADD CONSTRAINT exposure_id_universe_id_key UNIQUE(id,universe_id);
CREATE TABLE explicit_ask (
 id uuid PRIMARY KEY,
 event_id uuid NOT NULL UNIQUE,
 universe_id uuid NOT NULL,
 privacy_epoch integer NOT NULL CHECK(privacy_epoch>=0),
 session_id uuid NOT NULL,
 client_ask_id uuid NOT NULL,
 exposure_id uuid NOT NULL,
 UNIQUE(universe_id,session_id,client_ask_id),
 FOREIGN KEY(event_id,universe_id) REFERENCES ledger(id,universe_id) ON DELETE CASCADE,
 FOREIGN KEY(exposure_id,universe_id) REFERENCES exposure(id,universe_id) ON DELETE CASCADE,
 FOREIGN KEY(session_id,universe_id) REFERENCES device_session(id,universe_id)
);
CREATE FUNCTION explicit_ask_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Explicit Ask facts are immutable';
END $$;
CREATE TRIGGER explicit_ask_no_update BEFORE UPDATE ON explicit_ask
 FOR EACH ROW EXECUTE FUNCTION explicit_ask_immutable();
CREATE TRIGGER ask_ledger_no_update BEFORE UPDATE ON ledger
 FOR EACH ROW WHEN(OLD.kind='ask' OR NEW.kind='ask') EXECUTE FUNCTION explicit_ask_immutable();

-- Deferred pairing permits event + binding insertion and history erasure in
-- either order within one transaction, but no durable half-fact or forged link.
CREATE FUNCTION explicit_ask_pair_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_uuid uuid;
BEGIN
 IF TG_TABLE_NAME='ledger' THEN event_uuid=NEW.id;
 ELSIF TG_OP='DELETE' THEN event_uuid=OLD.event_id;
 ELSE event_uuid=NEW.event_id;
 END IF;
 IF EXISTS(SELECT 1 FROM ledger WHERE id=event_uuid AND kind='ask') AND NOT EXISTS(
  SELECT 1 FROM ledger l
  JOIN explicit_ask a ON a.event_id=l.id AND a.universe_id=l.universe_id AND a.privacy_epoch=l.privacy_epoch
  JOIN exposure e ON e.id=a.exposure_id AND e.universe_id=a.universe_id
  JOIN ledger origin ON origin.id=e.event_id AND origin.universe_id=a.universe_id AND origin.kind='exposure' AND origin.privacy_epoch=a.privacy_epoch
  JOIN decision d ON d.id=e.decision_id AND d.universe_id=a.universe_id AND d.privacy_epoch=a.privacy_epoch
  JOIN device_session s ON s.id=a.session_id AND s.universe_id=a.universe_id AND s.privacy_epoch=a.privacy_epoch
  WHERE l.id=event_uuid AND l.kind='ask' AND l.causation_id=e.event_id
   AND jsonb_typeof(origin.payload)='object'
   AND origin.payload-ARRAY['decisionId','assetId','clientExposureId','exposureId']='{}'::jsonb
   AND lower(origin.payload->>'decisionId')=e.decision_id::text
   AND lower(origin.payload->>'assetId')=e.asset_id::text
   AND lower(origin.payload->>'clientExposureId')=e.client_key::text
   AND lower(origin.payload->>'exposureId')=e.id::text
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.candidates)='array' THEN d.candidates ELSE '[]'::jsonb END) candidate
    WHERE lower(candidate->>'assetId')=e.asset_id::text AND candidate->>'kind'='Scroll')
   AND jsonb_typeof(l.payload->'question')='string'
   AND octet_length(l.payload->>'question') BETWEEN 1 AND 4096
   AND length(btrim(l.payload->>'question',U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))>0
   AND l.payload=jsonb_build_object('question',l.payload->>'question','exposureId',e.id,
    'decisionId',e.decision_id,'assetId',e.asset_id,'sessionId',a.session_id,
    'clientAskId',a.client_ask_id,'expectedPrivacyEpoch',a.privacy_epoch)
 ) THEN RAISE EXCEPTION 'Explicit Ask requires matching private source lineage'; END IF;
 IF TG_TABLE_NAME='explicit_ask' AND TG_OP<>'DELETE' AND EXISTS(
  SELECT 1 FROM explicit_ask a JOIN ledger l ON l.id=a.event_id WHERE a.event_id=event_uuid AND l.kind<>'ask'
 ) THEN RAISE EXCEPTION 'Explicit Ask requires an Ask event'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER ask_ledger_pair AFTER INSERT ON ledger
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='ask') EXECUTE FUNCTION explicit_ask_pair_guard();
CREATE CONSTRAINT TRIGGER explicit_ask_pair AFTER INSERT OR DELETE ON explicit_ask
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION explicit_ask_pair_guard();

CREATE FUNCTION ask_ledger_clear_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM universe WHERE id=OLD.universe_id AND privacy_epoch>OLD.privacy_epoch) THEN
  RAISE EXCEPTION 'Explicit Ask erasure requires an advanced privacy epoch';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER ask_ledger_clear_only BEFORE DELETE ON ledger
 FOR EACH ROW WHEN(OLD.kind='ask') EXECUTE FUNCTION ask_ledger_clear_guard();
