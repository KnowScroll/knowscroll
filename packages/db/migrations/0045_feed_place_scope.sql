-- ADR-0051 (feed scope): a feed decision records the place the reader asked from when they asked from
-- one (`GET /v1/feed?place=`), so the system remembers that it composed from that place (law 5).
-- NULL is the whole-universe feed: every decision recorded before this migration and every unscoped
-- one after it. Private history like the decision itself: Clear, Reset and account deletion delete it
-- with its decision, and export carries it (`SELECT * FROM decision`).
-- Numbered after 0042-0044, which dev and stage already carry from the #199 branch.
ALTER TABLE atlas_place ADD CONSTRAINT atlas_place_id_universe_id_key UNIQUE (id, universe_id);
ALTER TABLE decision ADD COLUMN scope_place_id uuid;
-- The place is one of the decision's own universe for the decision's whole life. Deferred because
-- erasure deletes a universe's places before its decisions, in one transaction.
ALTER TABLE decision ADD CONSTRAINT decision_scope_place_fkey
 FOREIGN KEY (scope_place_id, universe_id) REFERENCES atlas_place(id, universe_id)
 DEFERRABLE INITIALLY DEFERRED;

-- A decision is scoped only to a place the reader could ask from when it was made (a live planet or
-- region; never a sighting or a place set aside), and what was recorded never changes afterwards.
CREATE FUNCTION decision_scope_place_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN
  IF NEW.scope_place_id IS DISTINCT FROM OLD.scope_place_id THEN
   RAISE EXCEPTION 'A decision''s scope is fixed once recorded';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.scope_place_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM atlas_place WHERE id = NEW.scope_place_id AND universe_id = NEW.universe_id
   AND state = 'live' AND kind IN ('planet','region')) THEN
  RAISE EXCEPTION 'A decision is scoped only to a live planet or region of its own universe';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER decision_scope_place_guard BEFORE INSERT OR UPDATE OF scope_place_id ON decision
 FOR EACH ROW EXECUTE FUNCTION decision_scope_place_guard();
