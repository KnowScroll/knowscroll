-- ADR-0039 (#134): the return marker and connection Relics. Both are private history of one
-- universe and epoch: Clear/Reset/deletion erase them after the epoch advances, and export carries
-- them. Neither is ever written while recording is paused (ADR-0030).

-- "While you were away" is everything the reader did not cause since their newest marker in this
-- epoch. A marker is written once per explicit request and only ever moves forward.
CREATE TABLE away_acknowledgement (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 client_request_id uuid NOT NULL,
 through timestamptz NOT NULL,
 acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (universe_id, client_request_id),
 CHECK (through <= acknowledged_at)
);
CREATE INDEX away_acknowledgement_newest ON away_acknowledgement(universe_id, privacy_epoch, through DESC);

-- A Relic is kept deliberately and never edited: its truth state is derived when read, from the
-- bridge it points to and the reader's own objections, so a correction is shown, never hidden.
CREATE TABLE relic (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 client_request_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind = 'connection'),
 bridge_id uuid NOT NULL REFERENCES bridge(id),
 inquiry_id uuid REFERENCES background_inquiry(id),
 validator_version text NOT NULL CHECK (length(validator_version) BETWEEN 1 AND 80),
 cited_claim_keys jsonb NOT NULL CHECK (jsonb_typeof(cited_claim_keys) = 'array'
   AND jsonb_array_length(cited_claim_keys) BETWEEN 1 AND 12),
 kept_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (universe_id, client_request_id),
 UNIQUE (universe_id, privacy_epoch, bridge_id)
);
CREATE INDEX relic_universe ON relic(universe_id, privacy_epoch, kept_at DESC);
CREATE INDEX relic_bridge ON relic(bridge_id);
CREATE INDEX relic_inquiry ON relic(inquiry_id) WHERE inquiry_id IS NOT NULL;

-- Written in the universe's current epoch, never while it is paused, never edited.
CREATE FUNCTION return_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME; END IF;
 IF NOT EXISTS (SELECT 1 FROM universe WHERE id = NEW.universe_id AND privacy_epoch = NEW.privacy_epoch) THEN
  RAISE EXCEPTION '% rows belong to their universe''s current privacy epoch', TG_TABLE_NAME;
 END IF;
 IF EXISTS (SELECT 1 FROM universe WHERE id = NEW.universe_id AND recording_paused_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Recording is paused';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION away_acknowledgement_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.through > clock_timestamp() THEN RAISE EXCEPTION 'A return cannot be acknowledged in the future'; END IF;
 IF EXISTS (SELECT 1 FROM away_acknowledgement WHERE universe_id = NEW.universe_id AND privacy_epoch = NEW.privacy_epoch
   AND through >= NEW.through) THEN
  RAISE EXCEPTION 'A return marker only moves forward';
 END IF;
 RETURN NEW;
END $$;
-- Row triggers fire in name order: the epoch/pause/immutability guard always speaks first.
CREATE TRIGGER away_acknowledgement_1_history BEFORE INSERT OR UPDATE ON away_acknowledgement
 FOR EACH ROW EXECUTE FUNCTION return_history_guard();
CREATE TRIGGER away_acknowledgement_2_forward BEFORE INSERT ON away_acknowledgement
 FOR EACH ROW EXECUTE FUNCTION away_acknowledgement_guard();
CREATE TRIGGER away_acknowledgement_erase BEFORE DELETE ON away_acknowledgement
 FOR EACH ROW EXECUTE FUNCTION background_inquiry_erase_after_epoch();

-- A connection Relic points to an admitted bridge this universe can see (shared, or its own in this
-- epoch) that the reader has not marked "seems wrong", and to an inquiry of its own when it names one.
CREATE FUNCTION relic_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM bridge b WHERE b.id = NEW.bridge_id AND b.status = 'admitted'
   AND (b.scope_kind = 'shared' OR (b.universe_id = NEW.universe_id AND b.privacy_epoch = NEW.privacy_epoch))) THEN
  RAISE EXCEPTION 'A connection Relic keeps an admitted connection this universe can see';
 END IF;
 IF EXISTS (SELECT 1 FROM connection_feedback f WHERE f.universe_id = NEW.universe_id AND f.bridge_id = NEW.bridge_id
   AND f.objection = 'seems_wrong') THEN
  RAISE EXCEPTION 'A connection marked "seems wrong" is not kept';
 END IF;
 IF NEW.inquiry_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM background_inquiry i
   WHERE i.id = NEW.inquiry_id AND i.universe_id = NEW.universe_id AND i.privacy_epoch = NEW.privacy_epoch) THEN
  RAISE EXCEPTION 'A Relic names only an inquiry of its own universe and epoch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER relic_1_history BEFORE INSERT OR UPDATE ON relic FOR EACH ROW EXECUTE FUNCTION return_history_guard();
CREATE TRIGGER relic_2_keep BEFORE INSERT ON relic FOR EACH ROW EXECUTE FUNCTION relic_guard();
