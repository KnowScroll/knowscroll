-- ADR-0025: a gated Reel becomes inventory addressed like any other encounter. Exposures, keeps,
-- Traces and Accounts keep pointing at asset(id); nothing about Scroll rows changes.

-- An editorial order belongs to the editorial Scroll library. A generated Reel has none.
ALTER TABLE asset ALTER COLUMN editorial_order DROP NOT NULL;

ALTER TABLE asset ADD COLUMN media_sha256 text REFERENCES media_object(sha256);
ALTER TABLE asset ADD COLUMN generated_reel_id uuid UNIQUE REFERENCES generated_reel(id);
/** True exactly when the bytes came from stand-in providers, carried so no surface can present
  * simulated media as real (ADR-0024's marker, kept with the inventory identity). */
ALTER TABLE asset ADD COLUMN simulated boolean NOT NULL DEFAULT false;
ALTER TABLE asset ADD COLUMN withdrawn_at timestamptz;

-- A Scroll is still exactly what it was; a Reel is media plus lineage and never an editorial order.
ALTER TABLE asset ADD CONSTRAINT asset_kind_shape CHECK (
 (kind = 'Scroll' AND editorial_order IS NOT NULL AND media_sha256 IS NULL AND generated_reel_id IS NULL
  AND length(body) > 0 AND length(source_title) > 0 AND length(source_url) > 0 AND simulated = false)
 OR
 (kind = 'Reel' AND editorial_order IS NULL AND media_sha256 IS NOT NULL AND generated_reel_id IS NOT NULL
  AND truth_state = 'synthesis')
);

/** A Reel asset exists only for a generated Reel its gates actually cleared, and carries that
  * Reel's provenance. In the owner's database a stand-in Reel can never be eligible (ADR-0024),
  * so it can never be minted here either. */
CREATE FUNCTION asset_reel_provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE reel record;
BEGIN
 IF NEW.kind <> 'Reel' THEN RETURN NEW; END IF;
 SELECT availability, provider_mode, truth_state, media_sha256 INTO reel
  FROM generated_reel WHERE id = NEW.generated_reel_id;
 IF reel IS NULL THEN RAISE EXCEPTION 'A Reel asset names no generated Reel'; END IF;
 IF reel.availability NOT IN ('eligible','test_eligible') THEN
  RAISE EXCEPTION 'A Reel asset needs a generated Reel its gates cleared, not one that is %', reel.availability;
 END IF;
 IF NEW.media_sha256 IS DISTINCT FROM reel.media_sha256 THEN
  RAISE EXCEPTION 'A Reel asset must carry its generated Reel''s own media';
 END IF;
 IF NEW.simulated IS DISTINCT FROM (reel.provider_mode = 'standin') THEN
  RAISE EXCEPTION 'A Reel asset''s simulated flag must match its provenance';
 END IF;
 IF NEW.truth_state IS DISTINCT FROM reel.truth_state THEN
  RAISE EXCEPTION 'A Reel asset must carry its generated Reel''s truth state';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_reel_provenance_guard BEFORE INSERT OR UPDATE ON asset
 FOR EACH ROW EXECUTE FUNCTION asset_reel_provenance_guard();

/** Inventory identity and provenance are immutable; only withdrawal changes, once. An asset is
  * never deleted: exposures, keeps and Traces point at it, and history is not rewritten. */
CREATE FUNCTION asset_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Inventory assets are withdrawn, never deleted'; END IF;
 IF (NEW.id, NEW.revision, NEW.kind, NEW.title, NEW.summary, NEW.body, NEW.source_title, NEW.source_url,
     NEW.truth_state, NEW.editorial_order, NEW.media_sha256, NEW.generated_reel_id, NEW.simulated)
  IS DISTINCT FROM
    (OLD.id, OLD.revision, OLD.kind, OLD.title, OLD.summary, OLD.body, OLD.source_title, OLD.source_url,
     OLD.truth_state, OLD.editorial_order, OLD.media_sha256, OLD.generated_reel_id, OLD.simulated)
 THEN RAISE EXCEPTION 'An inventory asset''s identity and provenance are immutable'; END IF;
 IF OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at THEN
  RAISE EXCEPTION 'A withdrawn asset stays withdrawn';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_identity_guard BEFORE UPDATE OR DELETE ON asset
 FOR EACH ROW EXECUTE FUNCTION asset_identity_guard();

CREATE INDEX asset_offerable ON asset(kind) WHERE withdrawn_at IS NULL;
