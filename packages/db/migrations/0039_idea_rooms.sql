-- ADR-0045 (#163): Idea Rooms v1. A question the reader carries becomes a room on one of their
-- places, and its inhabitants are seats of evidence access holding supported claims. Rooms,
-- inhabitants and the deltas that are the only way they change are private history of one universe
-- and epoch: Clear/Reset/deletion erase them (before the places and Asks they name), export carries
-- them. Nothing here is written while recording is paused.
CREATE TABLE room (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 place_id uuid NOT NULL REFERENCES atlas_place(id),
 /** The Ask whose words are the room's question: the latest of those that carried it. */
 question_ask_id uuid NOT NULL REFERENCES explicit_ask(id),
 /** Every Ask the room holds; it only ever gains more (a question joining it). */
 ask_ids uuid[] NOT NULL CHECK (cardinality(ask_ids) >= 2),
 state text NOT NULL DEFAULT 'opened' CHECK (state IN ('opened','arguing','set_aside','retired')),
 policy_version text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (question_ask_id = ANY (ask_ids))
);
CREATE INDEX room_universe ON room(universe_id, created_at);
CREATE INDEX room_place ON room(place_id);

CREATE TABLE room_inhabitant (
 id uuid PRIMARY KEY,
 room_id uuid NOT NULL REFERENCES room(id),
 universe_id uuid NOT NULL REFERENCES universe(id),
 role text NOT NULL CHECK (role IN ('reader_of_record','doubter','connector')),
 seated boolean NOT NULL,
 /** Its position, [{claimId, supportKind}]: one to four claims while seated, none once unseated. */
 claims jsonb NOT NULL CHECK (jsonb_typeof(claims) = 'array'
   AND CASE WHEN seated THEN jsonb_array_length(claims) BETWEEN 1 AND 4 ELSE jsonb_array_length(claims) = 0 END),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (room_id, role)
);
CREATE INDEX room_inhabitant_universe ON room_inhabitant(universe_id);

CREATE TABLE room_delta (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 room_id uuid NOT NULL REFERENCES room(id),
 /** The inhabitant a seat change is about; null for a change to the room itself. */
 role text CHECK (role IN ('reader_of_record','doubter','connector')),
 kind text NOT NULL CHECK (kind IN ('room_opened','question_joined','inhabitant_seated','position_changed','inhabitant_unseated','room_set_aside','room_retired')),
 causal_class text NOT NULL CHECK (causal_class IN ('personal_exploration','substrate_neighbourhood','source_correction','reader_correction')),
 policy_version text NOT NULL,
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
 before jsonb,
 after jsonb NOT NULL,
 txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((role IS NOT NULL) = (kind IN ('inhabitant_seated','position_changed','inhabitant_unseated')))
);
CREATE INDEX room_delta_universe ON room_delta(universe_id, created_at DESC);
CREATE INDEX room_delta_room ON room_delta(room_id);

CREATE FUNCTION room_delta_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Room deltas are immutable';
END $$;
CREATE TRIGGER room_delta_no_update BEFORE UPDATE ON room_delta FOR EACH ROW EXECUTE FUNCTION room_delta_immutable();

-- Written in the universe's current epoch, never while it is paused.
CREATE FUNCTION room_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE epoch integer;
BEGIN
 -- IF, not CASE: PL/pgSQL plans a CASE expression against both row types (migration 0026).
 IF TG_TABLE_NAME = 'room' THEN epoch := NEW.privacy_epoch;
 ELSE
  SELECT privacy_epoch INTO epoch FROM room WHERE id = NEW.room_id AND universe_id = NEW.universe_id;
  IF epoch IS NULL THEN RAISE EXCEPTION 'An inhabitant sits in a room of its own universe'; END IF;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM universe WHERE id = NEW.universe_id AND privacy_epoch = epoch) THEN
  RAISE EXCEPTION 'A room belongs to its universe''s current privacy epoch';
 END IF;
 IF EXISTS (SELECT 1 FROM universe WHERE id = NEW.universe_id AND recording_paused_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Recording is paused';
 END IF;
 RETURN NEW;
END $$;

-- A room opens on a live planet or region of its universe, within the caps, carried by that
-- universe's own Asks. It keeps its identity and question, only gains Asks, and once set aside or
-- retired it never changes again.
CREATE FUNCTION room_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NOT EXISTS (SELECT 1 FROM atlas_place WHERE id = NEW.place_id AND universe_id = NEW.universe_id AND state = 'live' AND kind IN ('planet','region')) THEN
   RAISE EXCEPTION 'A room opens only on a live planet or region of its universe';
  END IF;
  IF NEW.state NOT IN ('opened','arguing') THEN RAISE EXCEPTION 'A room opens live'; END IF;
  IF (SELECT count(*) FROM room WHERE place_id = NEW.place_id AND state IN ('opened','arguing')) >= 3 THEN
   RAISE EXCEPTION 'A place holds at most 3 live rooms';
  END IF;
  IF (SELECT count(*) FROM room WHERE universe_id = NEW.universe_id AND state IN ('opened','arguing')) >= 12 THEN
   RAISE EXCEPTION 'A universe holds at most 12 live rooms';
  END IF;
 ELSE
  IF (NEW.id, NEW.universe_id, NEW.privacy_epoch, NEW.place_id, NEW.question_ask_id, NEW.policy_version, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.universe_id, OLD.privacy_epoch, OLD.place_id, OLD.question_ask_id, OLD.policy_version, OLD.created_at) THEN
   RAISE EXCEPTION 'A room keeps its identity and its question';
  END IF;
  IF OLD.state NOT IN ('opened','arguing') THEN RAISE EXCEPTION 'A room that is no longer live does not change'; END IF;
  IF NOT NEW.ask_ids @> OLD.ask_ids THEN RAISE EXCEPTION 'A room only gains Asks'; END IF;
  NEW.changed_at := clock_timestamp();
 END IF;
 IF EXISTS (SELECT 1 FROM unnest(NEW.ask_ids) AS carried(id) WHERE NOT EXISTS (
   SELECT 1 FROM explicit_ask a WHERE a.id = carried.id AND a.universe_id = NEW.universe_id AND a.privacy_epoch = NEW.privacy_epoch)) THEN
  RAISE EXCEPTION 'A room is carried only by its own universe''s Asks';
 END IF;
 RETURN NEW;
END $$;
-- Row triggers fire in name order: the epoch/pause guard always speaks first.
CREATE TRIGGER room_1_history BEFORE INSERT OR UPDATE ON room FOR EACH ROW EXECUTE FUNCTION room_history_guard();
CREATE TRIGGER room_2_guard BEFORE INSERT OR UPDATE ON room FOR EACH ROW EXECUTE FUNCTION room_guard();

-- An inhabitant keeps its room and role, and only a live room seats anyone.
CREATE FUNCTION room_inhabitant_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.id, NEW.room_id, NEW.universe_id, NEW.role, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.room_id, OLD.universe_id, OLD.role, OLD.created_at) THEN
  RAISE EXCEPTION 'An inhabitant keeps its room and role';
 END IF;
 IF NEW.seated AND NOT EXISTS (SELECT 1 FROM room WHERE id = NEW.room_id AND state IN ('opened','arguing')) THEN
  RAISE EXCEPTION 'Only a live room seats an inhabitant';
 END IF;
 NEW.changed_at := clock_timestamp();
 RETURN NEW;
END $$;
CREATE TRIGGER room_inhabitant_1_history BEFORE INSERT OR UPDATE ON room_inhabitant FOR EACH ROW EXECUTE FUNCTION room_history_guard();
CREATE TRIGGER room_inhabitant_2_guard BEFORE INSERT OR UPDATE ON room_inhabitant FOR EACH ROW EXECUTE FUNCTION room_inhabitant_guard();

-- Every change has a typed cause: a room changes only together with a delta for it, and an
-- inhabitant only with a delta for its seat (or the room's setting aside or retirement, which unseat
-- everyone), written by the same transaction.
CREATE FUNCTION room_has_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM room WHERE id = NEW.id) THEN RETURN NULL; END IF; -- erased in this transaction
 IF NOT EXISTS (SELECT 1 FROM room_delta WHERE room_id = NEW.id AND universe_id = NEW.universe_id AND txid = pg_current_xact_id()) THEN
  RAISE EXCEPTION 'A room changes only with a delta that says why';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER room_has_delta AFTER INSERT OR UPDATE ON room
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION room_has_delta();

CREATE FUNCTION room_inhabitant_has_delta() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM room_inhabitant WHERE id = NEW.id) THEN RETURN NULL; END IF; -- erased in this transaction
 IF NOT EXISTS (SELECT 1 FROM room_delta WHERE room_id = NEW.room_id AND universe_id = NEW.universe_id AND txid = pg_current_xact_id()
     AND (role = NEW.role OR kind IN ('room_set_aside','room_retired'))) THEN
  RAISE EXCEPTION 'An inhabitant changes only with a delta that says why';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER room_inhabitant_has_delta AFTER INSERT OR UPDATE ON room_inhabitant
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION room_inhabitant_has_delta();
