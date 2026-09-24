-- ADR-0044 (#165): typed Relics — a place, a passage of a Scroll and an answer to the reader's own
-- Ask — and the reader's "seems wrong" on a passage or an answer. Private history like the
-- connection Relic (ADR-0039): written in the universe's current epoch, never while recording is
-- paused, never edited; Clear/Reset/deletion erase it, export carries it. Provenance is recorded by
-- the server at keep time; the state is derived when read.

-- What each kind keeps. `cited_claim_keys` is what the Relic rests on: the claims a connection was
-- admitted on, a passage's claim, the claims an answer's Scroll presented with current support.
ALTER TABLE relic
 DROP CONSTRAINT relic_kind_check,
 ADD CONSTRAINT relic_kind_check CHECK (kind IN ('connection','place','passage','answer')),
 ALTER COLUMN bridge_id DROP NOT NULL,
 ALTER COLUMN validator_version DROP NOT NULL,
 DROP CONSTRAINT relic_cited_claim_keys_check,
 ADD CONSTRAINT relic_cited_claim_keys_check CHECK (jsonb_typeof(cited_claim_keys) = 'array' AND jsonb_array_length(cited_claim_keys) <= 100),
 ADD COLUMN place_id uuid REFERENCES atlas_place(id),
 ADD COLUMN place_kind text CHECK (place_kind IN ('planet','region','sighting')),
 ADD COLUMN formation_delta_id uuid REFERENCES atlas_delta(id),
 ADD COLUMN asset_id uuid REFERENCES asset(id),
 ADD COLUMN asset_revision integer CHECK (asset_revision > 0),
 ADD COLUMN scroll_title text CHECK (length(scroll_title) BETWEEN 1 AND 300),
 ADD COLUMN exposure_id uuid,
 ADD COLUMN claim_id uuid REFERENCES claim(id),
 ADD COLUMN ask_id uuid REFERENCES ask_answer(ask_id),
 ADD CONSTRAINT relic_exposure_scope_fkey FOREIGN KEY (exposure_id, universe_id) REFERENCES exposure(id, universe_id),
 ADD CONSTRAINT relic_kind_shape CHECK (CASE kind
  WHEN 'connection' THEN num_nonnulls(bridge_id, validator_version) = 2 AND jsonb_array_length(cited_claim_keys) BETWEEN 1 AND 12
   AND num_nonnulls(place_id, place_kind, formation_delta_id, asset_id, asset_revision, scroll_title, exposure_id, claim_id, ask_id) = 0
  WHEN 'place' THEN num_nonnulls(place_id, place_kind, formation_delta_id) = 3 AND jsonb_array_length(cited_claim_keys) = 0
   AND num_nonnulls(bridge_id, inquiry_id, validator_version, asset_id, asset_revision, scroll_title, exposure_id, claim_id, ask_id) = 0
  WHEN 'passage' THEN num_nonnulls(asset_id, asset_revision, scroll_title, exposure_id, claim_id) = 5 AND jsonb_array_length(cited_claim_keys) = 1
   AND num_nonnulls(bridge_id, inquiry_id, validator_version, place_id, place_kind, formation_delta_id, ask_id) = 0
  WHEN 'answer' THEN num_nonnulls(ask_id, asset_id, asset_revision, scroll_title) = 4
   AND num_nonnulls(bridge_id, inquiry_id, validator_version, place_id, place_kind, formation_delta_id, exposure_id, claim_id) = 0
 END);

-- One Relic per thing per epoch (a connection's is migration 0033's unique bridge).
CREATE UNIQUE INDEX relic_one_place ON relic(universe_id, privacy_epoch, place_id) WHERE kind = 'place';
CREATE UNIQUE INDEX relic_one_passage ON relic(universe_id, privacy_epoch, asset_id, asset_revision, claim_id) WHERE kind = 'passage';
CREATE UNIQUE INDEX relic_one_answer ON relic(universe_id, privacy_epoch, ask_id) WHERE kind = 'answer';
CREATE INDEX relic_place ON relic(place_id) WHERE place_id IS NOT NULL;
CREATE INDEX relic_exposure ON relic(exposure_id) WHERE exposure_id IS NOT NULL;
-- So Clear, Reset and deletion check these foreign keys without scanning every universe's Relics.
CREATE INDEX relic_formation_delta ON relic(formation_delta_id) WHERE formation_delta_id IS NOT NULL;
CREATE INDEX relic_ask ON relic(ask_id) WHERE ask_id IS NOT NULL;

-- The reader's "seems wrong" on one claim of a Scroll they read, or on an answer to their own Ask.
-- Personal, never a retraction of shared knowledge; erased only with its epoch (Clear/Reset/deletion).
CREATE TABLE reader_objection (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 client_request_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('passage','answer')),
 asset_id uuid REFERENCES asset(id),
 claim_id uuid REFERENCES claim(id),
 ask_id uuid REFERENCES ask_answer(ask_id),
 objected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (universe_id, client_request_id),
 CHECK (CASE kind WHEN 'passage' THEN num_nonnulls(asset_id, claim_id) = 2 AND ask_id IS NULL
  ELSE ask_id IS NOT NULL AND num_nonnulls(asset_id, claim_id) = 0 END)
);
CREATE UNIQUE INDEX reader_objection_one_passage ON reader_objection(universe_id, privacy_epoch, asset_id, claim_id) WHERE kind = 'passage';
CREATE INDEX reader_objection_ask ON reader_objection(ask_id) WHERE ask_id IS NOT NULL;
CREATE UNIQUE INDEX reader_objection_one_answer ON reader_objection(universe_id, privacy_epoch, ask_id) WHERE kind = 'answer';

-- An objection names a claim of a Scroll this universe read in this epoch, or an answer of its own.
CREATE FUNCTION reader_objection_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind = 'passage' AND NOT EXISTS (SELECT 1 FROM exposure e JOIN ledger l ON l.id = e.event_id AND l.universe_id = e.universe_id
   JOIN asset_claim ac ON ac.asset_id = e.asset_id
   WHERE e.universe_id = NEW.universe_id AND e.asset_id = NEW.asset_id AND l.privacy_epoch = NEW.privacy_epoch AND ac.claim_id = NEW.claim_id) THEN
  RAISE EXCEPTION 'An objection to a passage names a claim of a Scroll this universe read';
 END IF;
 IF NEW.kind = 'answer' AND NOT EXISTS (SELECT 1 FROM ask_answer a WHERE a.ask_id = NEW.ask_id AND a.universe_id = NEW.universe_id
   AND a.privacy_epoch = NEW.privacy_epoch AND a.status = 'answered') THEN
  RAISE EXCEPTION 'An objection to an answer names an answered Ask of its own universe and epoch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER reader_objection_1_history BEFORE INSERT OR UPDATE ON reader_objection FOR EACH ROW EXECUTE FUNCTION return_history_guard();
CREATE TRIGGER reader_objection_2_target BEFORE INSERT ON reader_objection FOR EACH ROW EXECUTE FUNCTION reader_objection_guard();
CREATE TRIGGER reader_objection_erase BEFORE DELETE ON reader_objection FOR EACH ROW EXECUTE FUNCTION background_inquiry_erase_after_epoch();

-- Each kind keeps only what it names, as it stands when kept, and never what the reader doubted.
CREATE OR REPLACE FUNCTION relic_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.kind = 'connection' THEN
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
 ELSIF NEW.kind = 'place' THEN
  IF NOT EXISTS (SELECT 1 FROM atlas_place p WHERE p.id = NEW.place_id AND p.universe_id = NEW.universe_id AND p.state = 'live'
    AND p.kind = NEW.place_kind) THEN
   RAISE EXCEPTION 'A place Relic keeps one of this universe''s live places, as it is';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM atlas_delta d WHERE d.id = NEW.formation_delta_id AND d.place_id = NEW.place_id
    AND d.kind IN ('place_formed','sighting_appeared')) THEN
   RAISE EXCEPTION 'A place Relic records the delta that formed it';
  END IF;
 ELSIF NEW.kind = 'passage' THEN
  IF NOT EXISTS (SELECT 1 FROM exposure e JOIN ledger l ON l.id = e.event_id AND l.universe_id = e.universe_id
    WHERE e.id = NEW.exposure_id AND e.universe_id = NEW.universe_id AND e.asset_id = NEW.asset_id AND l.privacy_epoch = NEW.privacy_epoch) THEN
   RAISE EXCEPTION 'A passage Relic keeps a Scroll this universe read in this epoch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM asset a JOIN asset_claim ac ON ac.asset_id = a.id JOIN claim c ON c.id = ac.claim_id
    WHERE a.id = NEW.asset_id AND a.kind = 'Scroll' AND a.revision = NEW.asset_revision AND c.id = NEW.claim_id
      AND NEW.cited_claim_keys = jsonb_build_array(c.key) AND claim_is_supported(c.id)) THEN
   RAISE EXCEPTION 'A passage Relic keeps a supported claim of the Scroll''s current revision';
  END IF;
  IF EXISTS (SELECT 1 FROM reader_objection o WHERE o.universe_id = NEW.universe_id AND o.privacy_epoch = NEW.privacy_epoch
    AND o.kind = 'passage' AND o.asset_id = NEW.asset_id AND o.claim_id = NEW.claim_id) THEN
   RAISE EXCEPTION 'A passage marked "seems wrong" is not kept';
  END IF;
 ELSIF NEW.kind = 'answer' THEN
  IF NOT EXISTS (SELECT 1 FROM ask_answer a WHERE a.ask_id = NEW.ask_id AND a.universe_id = NEW.universe_id
    AND a.privacy_epoch = NEW.privacy_epoch AND a.status = 'answered') THEN
   RAISE EXCEPTION 'An answer Relic keeps an answered Ask of its own universe and epoch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM explicit_ask q JOIN exposure e ON e.id = q.exposure_id AND e.universe_id = q.universe_id
    JOIN asset a ON a.id = e.asset_id
    WHERE q.id = NEW.ask_id AND a.id = NEW.asset_id AND a.kind = 'Scroll' AND a.revision = NEW.asset_revision) THEN
   RAISE EXCEPTION 'An answer Relic keeps the current revision of the Scroll its Ask was about';
  END IF;
  IF NEW.cited_claim_keys IS DISTINCT FROM (SELECT coalesce(jsonb_agg(c.key ORDER BY c.key), '[]') FROM asset_claim ac JOIN claim c ON c.id = ac.claim_id
      WHERE ac.asset_id = NEW.asset_id)
    OR EXISTS (SELECT 1 FROM asset_claim ac WHERE ac.asset_id = NEW.asset_id AND NOT claim_is_supported(ac.claim_id)) THEN
   RAISE EXCEPTION 'An answer Relic rests on every claim its Scroll presents, each supported';
  END IF;
  IF EXISTS (SELECT 1 FROM reader_objection o WHERE o.universe_id = NEW.universe_id AND o.privacy_epoch = NEW.privacy_epoch
    AND o.kind = 'answer' AND o.ask_id = NEW.ask_id) THEN
   RAISE EXCEPTION 'An answer marked "seems wrong" is not kept';
  END IF;
 END IF;
 RETURN NEW;
END $$;
