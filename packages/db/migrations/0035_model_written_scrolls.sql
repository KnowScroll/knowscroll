-- ADR-0041 (#162): model-written Scrolls. A model writes a Scroll in its own words from material
-- fetched for it. The material is kept privately as what the Scroll's claims are checked against,
-- and every decision on a writing is recorded: admitted with its Scroll, or refused with reason
-- codes and no model text. Both tables are shared library, not anyone's history: no universe owns a
-- row, so Clear, Reset, account deletion and export neither erase nor carry them, and no API route
-- reads them.

-- The page's normalized visible text, bound to the snapshot whose hash it is. A snapshot's content
-- never changes (ADR-0031), so neither does its material.
CREATE TABLE source_material (
 snapshot_id uuid PRIMARY KEY REFERENCES source_snapshot(id),
 content text NOT NULL CHECK (length(content) BETWEEN 1 AND 2000000),
 retrieved_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION source_material_matches_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM source_snapshot WHERE id = NEW.snapshot_id
   AND content_sha256 = encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex')) THEN
  RAISE EXCEPTION 'Source material must be exactly its snapshot''s text';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_material_matches_snapshot BEFORE INSERT ON source_material
 FOR EACH ROW EXECUTE FUNCTION source_material_matches_snapshot();
CREATE TRIGGER source_material_immutable BEFORE UPDATE OR DELETE ON source_material
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- One decision per material and request: a pair already decided is never sent again.
CREATE TABLE scroll_writing (
 id uuid PRIMARY KEY,
 material_sha256 text NOT NULL CHECK (material_sha256 ~ '^[0-9a-f]{64}$'),
 request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
 source_url text NOT NULL CHECK (source_url ~ '^https://' AND length(source_url) <= 2000),
 transport text NOT NULL CHECK (transport IN ('fixture','minimax')),
 model text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 80),
 versions jsonb NOT NULL CHECK (jsonb_typeof(versions) = 'object'),
 -- The owner's bound on one request (2026-09-24).
 input_bytes integer NOT NULL CHECK (input_bytes BETWEEN 1 AND 16384),
 usage jsonb NOT NULL CHECK (jsonb_typeof(usage) = 'object'),
 status text NOT NULL CHECK (status IN ('admitted','refused')),
 reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
 snapshot_id uuid REFERENCES source_snapshot(id),
 asset_id uuid UNIQUE REFERENCES asset(id),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (material_sha256, request_sha256),
 -- Admitted: a Scroll, the snapshot it was checked against, no reasons. Refused: reasons only.
 CHECK ((status = 'admitted') = (asset_id IS NOT NULL)),
 CHECK ((status = 'admitted') = (snapshot_id IS NOT NULL)),
 CHECK ((status = 'admitted') = (jsonb_array_length(reasons) = 0))
);

-- An admitted writing names a Scroll and stored material of exactly the hash it was decided on.
CREATE FUNCTION scroll_writing_admitted_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status <> 'admitted' THEN RETURN NEW; END IF;
 IF NOT EXISTS (SELECT 1 FROM source_material m JOIN source_snapshot s ON s.id = m.snapshot_id
   WHERE m.snapshot_id = NEW.snapshot_id AND s.content_sha256 = NEW.material_sha256) THEN
  RAISE EXCEPTION 'An admitted Scroll writing needs its stored material';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM asset WHERE id = NEW.asset_id AND kind = 'Scroll') THEN
  RAISE EXCEPTION 'An admitted Scroll writing names a Scroll';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scroll_writing_admitted_guard BEFORE INSERT ON scroll_writing
 FOR EACH ROW EXECUTE FUNCTION scroll_writing_admitted_guard();
CREATE TRIGGER scroll_writing_immutable BEFORE UPDATE OR DELETE ON scroll_writing
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();
