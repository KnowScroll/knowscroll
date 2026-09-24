-- ADR-0037 (#131/#134): foundation Stars. A planet or region may be load-bearing; the flag changes
-- only with a `foundation_recognised` / `foundation_withdrawn` delta in the same transaction (the
-- existing deferred trigger), and never on a sighting.
ALTER TABLE atlas_place ADD COLUMN load_bearing boolean NOT NULL DEFAULT false;
ALTER TABLE atlas_place ADD CONSTRAINT atlas_place_foundation_kind CHECK (NOT load_bearing OR kind IN ('planet','region'));
ALTER TABLE atlas_delta DROP CONSTRAINT atlas_delta_kind_check;
ALTER TABLE atlas_delta ADD CONSTRAINT atlas_delta_kind_check CHECK (kind IN (
 'place_formed','sighting_appeared','sighting_promoted','sighting_retired','place_rejected','place_released',
 'foundation_recognised','foundation_withdrawn'));
