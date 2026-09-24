-- ADR-0036 (#134): the reader's places and the deltas that are the only way they change.
-- Private history: Clear/Reset erase both tables; export carries them.
CREATE TABLE atlas_place (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 anchor_concept_id uuid NOT NULL REFERENCES concept(id),
 kind text NOT NULL CHECK (kind IN ('planet','region','sighting')),
 parent_place_id uuid REFERENCES atlas_place(id),
 state text NOT NULL DEFAULT 'live' CHECK (state IN ('live','promoted','rejected','retired')),
 /** A sighting's relation: {from,to,kind,ref:{claimId}|{bridgeId}}. */
 basis jsonb CHECK (basis IS NULL OR jsonb_typeof(basis) = 'object'),
 policy_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((kind = 'planet') = (parent_place_id IS NULL)),
 CHECK ((kind = 'sighting') = (basis IS NOT NULL)),
 CHECK (parent_place_id IS DISTINCT FROM id),
 CHECK (state IN ('live','rejected') OR kind = 'sighting' OR state = 'retired')
);
CREATE UNIQUE INDEX atlas_place_one_live_anchor ON atlas_place(universe_id, anchor_concept_id) WHERE state = 'live';
CREATE INDEX atlas_place_parent ON atlas_place(parent_place_id);

CREATE TABLE atlas_delta (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 place_id uuid NOT NULL REFERENCES atlas_place(id),
 kind text NOT NULL CHECK (kind IN ('place_formed','sighting_appeared','sighting_promoted','sighting_retired','place_rejected','place_released')),
 causal_class text NOT NULL CHECK (causal_class IN ('personal_exploration','substrate_neighbourhood','source_correction','reader_correction')),
 policy_version text NOT NULL,
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
 before jsonb,
 after jsonb NOT NULL,
 txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX atlas_delta_universe ON atlas_delta(universe_id, created_at DESC);
CREATE INDEX atlas_delta_place ON atlas_delta(place_id);

CREATE FUNCTION atlas_delta_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Atlas deltas are immutable';
END $$;
CREATE TRIGGER atlas_delta_no_update BEFORE UPDATE ON atlas_delta FOR EACH ROW EXECUTE FUNCTION atlas_delta_immutable();

-- A place keeps its identity; its state only moves forward, and only a region can be released
-- into a free planet.
CREATE FUNCTION atlas_place_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id, NEW.universe_id, NEW.anchor_concept_id, NEW.policy_version, NEW.created_at, NEW.basis)
    IS DISTINCT FROM (OLD.id, OLD.universe_id, OLD.anchor_concept_id, OLD.policy_version, OLD.created_at, OLD.basis) THEN
  RAISE EXCEPTION 'A place keeps its identity';
 END IF;
 IF OLD.state <> 'live' THEN RAISE EXCEPTION 'A place that is no longer live does not change'; END IF;
 IF NEW.kind IS DISTINCT FROM OLD.kind AND NOT (OLD.kind = 'region' AND NEW.kind = 'planet' AND NEW.state = 'live') THEN
  RAISE EXCEPTION 'Only a region can be released as a planet';
 END IF;
 NEW.changed_at := clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER atlas_place_guard BEFORE UPDATE ON atlas_place FOR EACH ROW EXECUTE FUNCTION atlas_place_guard();

-- Every visible change has a typed cause: a place is inserted or changed only together with a
-- delta for it written by the same transaction.
CREATE FUNCTION atlas_place_has_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM atlas_place WHERE id = NEW.id) THEN RETURN NULL; END IF; -- erased in this transaction
 IF NOT EXISTS (SELECT 1 FROM atlas_delta WHERE place_id = NEW.id AND txid = pg_current_xact_id()) THEN
  RAISE EXCEPTION 'A place changes only with a delta that says why';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER atlas_place_has_delta AFTER INSERT OR UPDATE ON atlas_place
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION atlas_place_has_delta();
