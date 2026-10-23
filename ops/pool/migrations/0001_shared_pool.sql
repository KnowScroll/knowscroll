-- #199: the shared Reel pool's own small database (knowscroll_pool), outside every world. It holds
-- one row per paid order sent to the shared Cutroom: which world ordered it, the ceiling it reserved,
-- what it cost, and the approval behind it. Every world that orders claims a request id here first, so
-- a script is ordered once and every other world only receives it. The money rule is the owner's
-- (2026-10-07, #199 Gate 2 review): $5 in total for dev and stage together. Resetting a world never
-- touches this database, so money already spent is never forgotten.
--
-- Worlds use it only through the functions below (SECURITY DEFINER); the tables are not theirs.

CREATE TABLE pool_budget (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 cap_cents integer NOT NULL CHECK (cap_cents BETWEEN 0 AND 500),
 set_by text NOT NULL CHECK (length(btrim(set_by)) BETWEEN 1 AND 200),
 set_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO pool_budget (cap_cents, set_by)
 VALUES (500, 'owner decision 2026-10-07 (#199 Gate 2 review): $5 total for dev and stage');

CREATE TABLE pool_order (
 request_id text PRIMARY KEY,
 script_digest text NOT NULL CHECK (script_digest ~ '^[0-9a-f]{64}$'),
 take integer NOT NULL CHECK (take BETWEEN 1 AND 999),
 until text NOT NULL CHECK (until IN ('plan','stills','video')),
 body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
 ordered_by text NOT NULL CHECK (ordered_by ~ '^[a-z][a-z0-9_-]{0,31}$'),
 ceiling_cents integer NOT NULL CHECK (ceiling_cents BETWEEN 1 AND 500),
 approval_ref text NOT NULL CHECK (length(btrim(approval_ref)) BETWEEN 1 AND 500),
 state text NOT NULL DEFAULT 'claimed' CHECK (state IN ('claimed','settled','released')),
 outcome text CHECK (outcome IN ('completed','refused','stopped','failed','cancelled')),
 spent_cents integer CHECK (spent_cents >= 0),
 final_run_id text CHECK (final_run_id IS NULL OR length(final_run_id) BETWEEN 1 AND 1024),
 claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 UNIQUE (script_digest, take),
 CHECK (request_id = 'ks-reel-' || left(script_digest, 32) || '-' || take::text),
 CHECK ((state = 'settled') = (outcome IS NOT NULL AND spent_cents IS NOT NULL AND settled_at IS NOT NULL)),
 CHECK (state <> 'released' OR (outcome IS NULL AND spent_cents IS NULL)),
 CHECK (outcome IS DISTINCT FROM 'completed' OR final_run_id IS NOT NULL)
);

CREATE FUNCTION pool_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
END $$;
CREATE TRIGGER pool_order_no_delete BEFORE DELETE ON pool_order FOR EACH ROW EXECUTE FUNCTION pool_immutable();
CREATE TRIGGER pool_budget_no_delete BEFORE DELETE ON pool_budget FOR EACH ROW EXECUTE FUNCTION pool_immutable();

-- A claim is identity and money; only its outcome may be filled in, once.
CREATE FUNCTION pool_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.request_id, NEW.script_digest, NEW.take, NEW.until, NEW.body_sha256, NEW.ordered_by, NEW.ceiling_cents, NEW.approval_ref, NEW.claimed_at)
   IS DISTINCT FROM (OLD.request_id, OLD.script_digest, OLD.take, OLD.until, OLD.body_sha256, OLD.ordered_by, OLD.ceiling_cents, OLD.approval_ref, OLD.claimed_at)
  OR OLD.state <> 'claimed'
 THEN RAISE EXCEPTION 'A pool order is settled or released once, and never otherwise changed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pool_order_guard BEFORE UPDATE ON pool_order FOR EACH ROW EXECUTE FUNCTION pool_order_guard();

-- Money already committed: what settled orders cost plus the full ceiling of every open one.
CREATE FUNCTION pool_committed_cents() RETURNS integer LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(CASE state WHEN 'settled' THEN spent_cents WHEN 'claimed' THEN ceiling_cents ELSE 0 END), 0)::integer
 FROM pool_order
$$;

-- The rule itself, on the table: no claim may take committed money past the cap.
CREATE FUNCTION pool_order_cap_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cap integer := (SELECT cap_cents FROM pool_budget);
BEGIN
 IF pool_committed_cents() + NEW.ceiling_cents > coalesce(cap, 0)
 THEN RAISE EXCEPTION 'The shared pool may not commit more than % cents', coalesce(cap, 0); END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pool_order_cap_guard BEFORE INSERT ON pool_order FOR EACH ROW EXECUTE FUNCTION pool_order_cap_guard();

CREATE FUNCTION pool_next_take(p_digest text) RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog, public AS $$
 SELECT coalesce(max(take), 0) + 1 FROM pool_order WHERE script_digest = p_digest
$$;

-- Claims a request id for one world. Answers 'claimed', 'already_ordered' (another order of this
-- script is open or already made the Reel; the caller only receives it), 'cap_exceeded', or
-- 'take_taken' (lost a race for this take; the caller asks for the next one).
CREATE FUNCTION pool_claim(
 p_request_id text, p_digest text, p_take integer, p_until text, p_body_sha256 text,
 p_world text, p_ceiling_cents integer, p_approval_ref text
) RETURNS TABLE (status text, request_id text, ordered_by text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE existing record;
BEGIN
 LOCK TABLE pool_order IN SHARE ROW EXCLUSIVE MODE;
 SELECT o.request_id, o.ordered_by INTO existing FROM pool_order o
  WHERE o.script_digest = p_digest AND (o.state = 'claimed' OR (o.state = 'settled' AND o.outcome = 'completed'))
  ORDER BY o.take DESC LIMIT 1;
 IF FOUND THEN RETURN QUERY SELECT 'already_ordered'::text, existing.request_id, existing.ordered_by; RETURN; END IF;
 IF EXISTS (SELECT 1 FROM pool_order o WHERE o.request_id = p_request_id OR (o.script_digest = p_digest AND o.take = p_take)) THEN
  RETURN QUERY SELECT 'take_taken'::text, NULL::text, NULL::text; RETURN;
 END IF;
 IF pool_committed_cents() + p_ceiling_cents > coalesce((SELECT cap_cents FROM pool_budget), 0) THEN
  RETURN QUERY SELECT 'cap_exceeded'::text, NULL::text, NULL::text; RETURN;
 END IF;
 INSERT INTO pool_order (request_id, script_digest, take, until, body_sha256, ordered_by, ceiling_cents, approval_ref)
  VALUES (p_request_id, p_digest, p_take, p_until, p_body_sha256, p_world, p_ceiling_cents, p_approval_ref);
 RETURN QUERY SELECT 'claimed'::text, p_request_id, p_world;
END $$;

-- Records what an order finally cost. Only the world that ordered it may settle it; settling again
-- with the same figures is a no-op. The spend is recorded even if it overshoots the cap (ADR-0012:
-- never clamp real usage); further claims are then refused by the cap rule.
CREATE FUNCTION pool_settle(
 p_request_id text, p_world text, p_outcome text, p_spent_cents integer, p_final_run_id text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE row pool_order;
BEGIN
 SELECT * INTO row FROM pool_order WHERE pool_order.request_id = p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pool_order_unknown'; END IF;
 IF row.ordered_by <> p_world THEN RAISE EXCEPTION 'pool_order_not_yours'; END IF;
 IF row.state = 'settled' THEN
  IF (row.outcome, row.spent_cents, row.final_run_id) IS NOT DISTINCT FROM (p_outcome, p_spent_cents, p_final_run_id)
  THEN RETURN 'already_settled'; END IF;
  RAISE EXCEPTION 'pool_order_settled_differently';
 END IF;
 IF row.state <> 'claimed' THEN RAISE EXCEPTION 'pool_order_not_open'; END IF;
 UPDATE pool_order SET state = 'settled', outcome = p_outcome, spent_cents = p_spent_cents,
  final_run_id = p_final_run_id, settled_at = clock_timestamp()
  WHERE pool_order.request_id = p_request_id;
 RETURN 'settled';
END $$;

-- Gives back a claim whose request was never sent.
CREATE FUNCTION pool_release(p_request_id text, p_world text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE row pool_order;
BEGIN
 SELECT * INTO row FROM pool_order WHERE pool_order.request_id = p_request_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'pool_order_unknown'; END IF;
 IF row.ordered_by <> p_world THEN RAISE EXCEPTION 'pool_order_not_yours'; END IF;
 IF row.state = 'released' THEN RETURN 'already_released'; END IF;
 IF row.state <> 'claimed' THEN RAISE EXCEPTION 'pool_order_not_open'; END IF;
 UPDATE pool_order SET state = 'released' WHERE pool_order.request_id = p_request_id;
 RETURN 'released';
END $$;

CREATE FUNCTION pool_orders() RETURNS SETOF pool_order LANGUAGE sql STABLE SECURITY DEFINER
 SET search_path = pg_catalog, public AS $$
 SELECT * FROM pool_order ORDER BY claimed_at, request_id
$$;

CREATE FUNCTION pool_budget_status() RETURNS TABLE (cap_cents integer, committed_cents integer, left_cents integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT b.cap_cents, pool_committed_cents(), greatest(b.cap_cents - pool_committed_cents(), 0) FROM pool_budget b
$$;

REVOKE ALL ON pool_order, pool_budget FROM PUBLIC;
REVOKE ALL ON FUNCTION pool_next_take(text), pool_claim(text, text, integer, text, text, text, integer, text),
 pool_settle(text, text, text, integer, text), pool_release(text, text), pool_orders(), pool_budget_status()
 FROM PUBLIC;
DO $$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ks_pool_client') THEN
  GRANT EXECUTE ON FUNCTION pool_next_take(text), pool_claim(text, text, integer, text, text, text, integer, text),
   pool_settle(text, text, text, integer, text), pool_release(text, text), pool_orders(), pool_budget_status()
   TO ks_pool_client;
 END IF;
END $$;
