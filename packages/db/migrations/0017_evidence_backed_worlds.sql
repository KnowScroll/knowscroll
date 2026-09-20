-- ADR-0028: evidence-backed semantic worlds. A world is derived from recorded asset evidence,
-- never asserted; a system groups the worlds one universe's reader has actually encountered.
-- No feed, selection, ranking or consumer surface is added here. Contract only.

CREATE TABLE world_derivation_method (
 method text PRIMARY KEY CHECK (method ~ '^[a-z0-9_]{3,64}$'),
 /** What the method computes and from which rows, so a later, better method can be added
  * alongside it without touching rows this one already produced. */
 description text NOT NULL CHECK (length(btrim(description)) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- The only method this contract defines: an asset's own recorded source_title/source_url is its
-- evidence, so a world is exactly the set of asset rows sharing one source. Nothing is inferred.
INSERT INTO world_derivation_method(method, description) VALUES (
 'shared_source_v1',
 'A world is the set of asset rows carrying one identical (source_title, source_url) pair. ' ||
 'Recomputed by scanning asset rows only; carries no inference beyond what each asset already records.'
);

CREATE TABLE world (
 id uuid PRIMARY KEY,
 derivation_method text NOT NULL REFERENCES world_derivation_method(method),
 source_title text NOT NULL CHECK (length(btrim(source_title)) BETWEEN 1 AND 500),
 source_url text NOT NULL CHECK (length(btrim(source_url)) BETWEEN 1 AND 2000),
 /** Recorded, not asserted: the guard below refuses any value but the live count of Scroll-kind
  * world_member rows for this world. */
 scroll_count integer NOT NULL DEFAULT 0 CHECK (scroll_count >= 0),
 computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- One world per distinct source per method: re-running the derivation finds the existing row by
 -- this key instead of duplicating it, which is what makes recomputation idempotent.
 UNIQUE (derivation_method, source_url)
);

-- Membership is the traceable link from a world to the exact asset rows that justify it.
CREATE TABLE world_member (
 world_id uuid NOT NULL REFERENCES world(id),
 asset_id uuid NOT NULL REFERENCES asset(id),
 PRIMARY KEY (world_id, asset_id)
);
CREATE INDEX world_member_asset ON world_member(asset_id);

/** A member's asset must actually carry the source recorded on its world: membership can never
  * assert a link the evidence does not show, and the pair stays checkable at any time by
  * re-reading the asset row named here. */
CREATE FUNCTION world_member_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w record; a record;
BEGIN
 SELECT source_title, source_url INTO w FROM world WHERE id = NEW.world_id;
 IF w IS NULL THEN RAISE EXCEPTION 'A world member must name an existing world'; END IF;
 SELECT source_title, source_url INTO a FROM asset WHERE id = NEW.asset_id;
 IF a IS NULL THEN RAISE EXCEPTION 'A world member must name an existing asset'; END IF;
 -- A source is identified by its URL. Its title is a human label that legitimately varies for the
 -- same source -- typography, a later edit, a curly apostrophe where an earlier row had a straight
 -- one. Requiring the title to match too makes a world undrawable the moment one Scroll spells its
 -- source differently, which is a data accident, not missing evidence.
 IF a.source_url IS DISTINCT FROM w.source_url THEN
  RAISE EXCEPTION 'A world member''s asset must carry the same source URL as its world';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER world_member_evidence_guard BEFORE INSERT ON world_member
 FOR EACH ROW EXECUTE FUNCTION world_member_evidence_guard();

/** A world's identity (which method, which source) is immutable -- a changed source is a
 * different world under this method, found or created fresh by the UNIQUE key above, not an
 * edit in place. scroll_count and computed_at are the one thing a recompute is allowed to
 * refresh, and only to the value this trigger itself verifies: the live count of Scroll-kind
 * world_member rows naming this world. This is what keeps "the count of Scrolls behind it"
 * something the database refuses to get wrong, not a number an application merely asserts. */
CREATE FUNCTION world_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actual integer;
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.id, NEW.derivation_method, NEW.source_title, NEW.source_url)
   IS DISTINCT FROM (OLD.id, OLD.derivation_method, OLD.source_title, OLD.source_url)
 THEN RAISE EXCEPTION 'A world''s evidence identity is immutable; a changed source is a different world'; END IF;
 SELECT count(*) INTO actual FROM world_member m JOIN asset a ON a.id = m.asset_id
  WHERE m.world_id = NEW.id AND a.kind = 'Scroll';
 IF NEW.scroll_count <> actual THEN
  RAISE EXCEPTION 'A world''s scroll_count must equal its actual Scroll evidence (recorded %, actual %)', NEW.scroll_count, actual;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER world_guard BEFORE INSERT OR UPDATE ON world
 FOR EACH ROW EXECUTE FUNCTION world_guard();
CREATE TRIGGER world_no_delete BEFORE DELETE ON world
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

/** The database refuses a world that names no evidence. Deferred to the end of the transaction,
 * because the ordinary way to create a world inserts the world row and its members in the same
 * transaction (the world row must exist first, since world_member's foreign key requires it). */
CREATE FUNCTION world_requires_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE missing uuid;
BEGIN
 SELECT w.id INTO missing FROM world w
  WHERE NOT EXISTS (SELECT 1 FROM world_member m WHERE m.world_id = w.id)
  LIMIT 1;
 IF missing IS NOT NULL THEN
  RAISE EXCEPTION 'A world must name at least one asset as its evidence (world %)', missing;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER world_requires_evidence_on_world
 AFTER INSERT OR UPDATE ON world DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION world_requires_evidence();
CREATE CONSTRAINT TRIGGER world_requires_evidence_on_member_delete
 AFTER DELETE ON world_member DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION world_requires_evidence();

-- A system groups the worlds one universe's reader has actually encountered. Worlds are a
-- shared, universe-independent catalog derived from the asset table; a system is the
-- universe-scoped view of which of them this reader's own exposures have actually reached.
CREATE TABLE world_system (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 derivation_method text NOT NULL REFERENCES world_derivation_method(method),
 computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 -- One system per universe per method, for the same recomputation-finds-the-existing-row reason
 -- as world's UNIQUE key.
 UNIQUE (universe_id, derivation_method)
);
CREATE INDEX world_system_universe ON world_system(universe_id);

CREATE TABLE world_system_member (
 system_id uuid NOT NULL REFERENCES world_system(id),
 world_id uuid NOT NULL REFERENCES world(id),
 /** How many of this world's Scrolls this system's universe has actually been exposed to.
  * Membership itself requires at least one, which is the literal database expression of
  * "a system is the worlds a reader has actually encountered" -- a world with zero exposures in
  * this universe is not a member, not a member with a zero shown on it. */
 seen_count integer NOT NULL CHECK (seen_count >= 1),
 computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (system_id, world_id)
);
CREATE INDEX world_system_member_world ON world_system_member(world_id);

/** seen_count is traced to the exposure and ledger event rows that justify it, not asserted: it
  * must equal the count of this world's Scroll-kind assets that this system's own universe has
  * an exposure row for. exposure.event_id is itself a ledger row, so this is one join away from
  * the causation-carrying event, matching ADR-0004's lineage requirement rather than restating it. */
CREATE FUNCTION world_system_member_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE u_id uuid; actual integer;
BEGIN
 SELECT universe_id INTO u_id FROM world_system WHERE id = NEW.system_id;
 IF u_id IS NULL THEN RAISE EXCEPTION 'A system member must name an existing system'; END IF;
 SELECT count(DISTINCT m.asset_id) INTO actual
  FROM world_member m JOIN asset a ON a.id = m.asset_id
  JOIN exposure e ON e.asset_id = m.asset_id AND e.universe_id = u_id
  WHERE m.world_id = NEW.world_id AND a.kind = 'Scroll';
 IF NEW.seen_count <> actual THEN
  RAISE EXCEPTION 'A system member''s seen_count must equal this universe''s actual exposures (recorded %, actual %)', NEW.seen_count, actual;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER world_system_member_guard BEFORE INSERT OR UPDATE ON world_system_member
 FOR EACH ROW EXECUTE FUNCTION world_system_member_guard();

CREATE FUNCTION world_system_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND (NEW.id, NEW.universe_id, NEW.derivation_method)
   IS DISTINCT FROM (OLD.id, OLD.universe_id, OLD.derivation_method)
 THEN RAISE EXCEPTION 'A system''s identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER world_system_guard BEFORE UPDATE ON world_system
 FOR EACH ROW EXECUTE FUNCTION world_system_guard();
CREATE TRIGGER world_system_no_delete BEFORE DELETE ON world_system
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

/** The mirror of world_requires_evidence, one level up: the database refuses a system that
  * groups no world, so an empty system row can never be read back as if it meant something. */
CREATE FUNCTION world_system_requires_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE missing uuid;
BEGIN
 SELECT s.id INTO missing FROM world_system s
  WHERE NOT EXISTS (SELECT 1 FROM world_system_member m WHERE m.system_id = s.id)
  LIMIT 1;
 IF missing IS NOT NULL THEN
  RAISE EXCEPTION 'A system must group at least one encountered world (system %)', missing;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER world_system_requires_member_on_system
 AFTER INSERT OR UPDATE ON world_system DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION world_system_requires_member();
CREATE CONSTRAINT TRIGGER world_system_requires_member_on_member_delete
 AFTER DELETE ON world_system_member DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION world_system_requires_member();
