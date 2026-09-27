-- Encounter-derived systems are private history, not part of the shared world catalog.
-- Migration changes no existing history. Clear/Reset remove projections in their own transaction.
CREATE FUNCTION world_system_delete_after_erasure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM exposure WHERE universe_id = OLD.universe_id) THEN
  RAISE EXCEPTION 'A system can be removed only after its universe exposures are erased';
 END IF;
 RETURN OLD;
END $$;

DROP TRIGGER world_system_no_delete ON world_system;
CREATE TRIGGER world_system_no_delete BEFORE DELETE ON world_system
 FOR EACH ROW EXECUTE FUNCTION world_system_delete_after_erasure();
