-- ADR-0037 (#131/#134): foundation Stars. A planet or region may be load-bearing; the flag changes
-- only with a `foundation_recognised` / `foundation_withdrawn` delta for that place in the same
-- transaction, and never on a sighting.
ALTER TABLE atlas_place ADD COLUMN load_bearing boolean NOT NULL DEFAULT false;
ALTER TABLE atlas_place ADD CONSTRAINT atlas_place_foundation_kind CHECK (NOT load_bearing OR kind IN ('planet','region'));
ALTER TABLE atlas_delta DROP CONSTRAINT atlas_delta_kind_check;
ALTER TABLE atlas_delta ADD CONSTRAINT atlas_delta_kind_check CHECK (kind IN (
 'place_formed','sighting_appeared','sighting_promoted','sighting_retired','place_rejected','place_released',
 'foundation_recognised','foundation_withdrawn'));
CREATE FUNCTION atlas_place_foundation_has_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM atlas_place WHERE id = NEW.id) THEN RETURN NULL; END IF; -- erased in this transaction
 IF NOT EXISTS (SELECT 1 FROM atlas_delta WHERE place_id = NEW.id AND universe_id = NEW.universe_id AND txid = pg_current_xact_id()
     AND kind IN ('foundation_recognised','foundation_withdrawn')) THEN
  RAISE EXCEPTION 'A foundation changes only with a foundation delta that says why';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER atlas_place_foundation_has_delta AFTER UPDATE OF load_bearing ON atlas_place
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.load_bearing IS DISTINCT FROM NEW.load_bearing)
 EXECUTE FUNCTION atlas_place_foundation_has_delta();
