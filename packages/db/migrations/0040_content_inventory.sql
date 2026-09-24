-- ADR-0046 (#164): inventory v1. A reader's real reading records a need (a demand) in the
-- transaction that observed it; the Quartermaster decides, deterministically, to reuse a Scroll they
-- were never shown, to join or fund a shared request to write one, or why the need cannot be met.
-- Supply is shared library: routes, material candidates and requests name no universe, and no
-- privacy operation erases them. Demands, waiters and bindings are private history of one universe
-- and epoch: Clear/Reset/deletion erase them after the epoch advances, export carries them, and
-- nothing is written while recording is paused except the cancellations pausing causes.

-- A Scroll is eligible while every claim it rests on is still supported (ADR-0031): a source
-- correction that takes one away takes the Scroll out of inventory.
CREATE FUNCTION scroll_is_eligible(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM asset WHERE id = target AND kind = 'Scroll' AND withdrawn_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM asset_claim x WHERE x.asset_id = target AND NOT claim_is_supported(x.claim_id))
$$;

-- True when `later` is `earlier` with zero or more elements appended.
CREATE FUNCTION jsonb_array_extends(later jsonb, earlier jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_array_length(later) >= jsonb_array_length(earlier)
  AND COALESCE((SELECT jsonb_agg(e ORDER BY i) FROM jsonb_array_elements(later) WITH ORDINALITY AS t(e, i)
   WHERE i <= jsonb_array_length(earlier)), '[]'::jsonb) = earlier
$$;

-- Shared supply -----------------------------------------------------------------------------------

-- The operator's writing route, like ADR-0038's: its request cap is a route bucket (route_quota,
-- requests), so admission, not goodwill, stops it (supply_request_budget below). Nothing is enabled
-- implicitly; disabling the route is the operator's stop.
CREATE TABLE scroll_writing_route (
 id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9.-]{2,63}$'),
 transport text NOT NULL CHECK (transport IN ('fixture','minimax')),
 model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 request_bucket_id uuid NOT NULL UNIQUE REFERENCES reasoning_bucket(id),
 enabled boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX scroll_writing_route_one_enabled ON scroll_writing_route((true)) WHERE enabled;

CREATE FUNCTION scroll_writing_route_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' OR (to_jsonb(NEW) - 'enabled') IS DISTINCT FROM (to_jsonb(OLD) - 'enabled') THEN
  RAISE EXCEPTION 'A writing route is only ever enabled or disabled';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scroll_writing_route_guard BEFORE UPDATE OR DELETE ON scroll_writing_route
 FOR EACH ROW EXECUTE FUNCTION scroll_writing_route_guard();

-- Allowlisted material and the concepts it may be written for: ADR-0041's plan item, installed.
CREATE TABLE scroll_material_candidate (
 id uuid PRIMARY KEY,
 url text NOT NULL UNIQUE CHECK (url ~ '^https://' AND length(url) <= 2000),
 concept_codes text[] NOT NULL CHECK (cardinality(concept_codes) BETWEEN 1 AND 8),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION scroll_material_candidate_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (SELECT count(DISTINCT code) FROM concept WHERE code = ANY(NEW.concept_codes)) <> cardinality(NEW.concept_codes) THEN
  RAISE EXCEPTION 'Material names distinct concepts the substrate holds';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scroll_material_candidate_guard BEFORE INSERT ON scroll_material_candidate
 FOR EACH ROW EXECUTE FUNCTION scroll_material_candidate_guard();
CREATE TRIGGER scroll_material_candidate_immutable BEFORE UPDATE OR DELETE ON scroll_material_candidate
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- One shared attempt to write a Scroll about a concept. It carries the concept, the modality, the
-- rights policy and the chosen material, never anything from a reader's universe (target §2, §7).
-- `sending` is committed before the one request goes out, so a request is never sent twice.
CREATE TABLE supply_request (
 id uuid PRIMARY KEY,
 concept_id uuid NOT NULL REFERENCES concept(id),
 modality text NOT NULL CHECK (modality = 'scroll'),
 rights_policy text NOT NULL CHECK (rights_policy = 'material-hosts-v1'),
 route_id text NOT NULL REFERENCES scroll_writing_route(id),
 candidate_id uuid NOT NULL REFERENCES scroll_material_candidate(id),
 -- The material's concepts inside the requested concept's subtree, as offered to the writer.
 offered_codes text[] NOT NULL CHECK (cardinality(offered_codes) BETWEEN 1 AND 8),
 status text NOT NULL CHECK (status IN ('open','sending','fulfilled','refused','failed','cancelled')),
 reasons jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reasons) = 'array' AND jsonb_array_length(reasons) <= 24),
 writing_id uuid REFERENCES scroll_writing(id),
 asset_id uuid REFERENCES asset(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 sent_at timestamptz,
 settled_at timestamptz,
 UNIQUE (candidate_id, concept_id),
 CHECK ((status = 'fulfilled') = (asset_id IS NOT NULL)),
 CHECK ((status IN ('open','sending')) = (settled_at IS NULL)),
 CHECK (status NOT IN ('sending','failed') OR sent_at IS NOT NULL),
 CHECK (status <> 'open' OR sent_at IS NULL),
 CHECK ((status IN ('refused','failed','cancelled')) = (jsonb_array_length(reasons) > 0))
);
CREATE UNIQUE INDEX supply_request_one_open ON supply_request(concept_id, modality) WHERE status IN ('open','sending');
CREATE INDEX supply_request_queue ON supply_request(created_at, id) WHERE status = 'open';

CREATE FUNCTION supply_request_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Supply requests are shared history, never deleted'; END IF;
 IF TG_OP = 'INSERT' THEN
  IF NEW.status <> 'open' OR NOT EXISTS (SELECT 1 FROM scroll_material_candidate WHERE id = NEW.candidate_id AND NEW.offered_codes <@ concept_codes) THEN
   RAISE EXCEPTION 'A supply request opens offering only its material''s concepts';
  END IF;
  RETURN NEW;
 END IF;
 IF (NEW.id, NEW.concept_id, NEW.modality, NEW.rights_policy, NEW.route_id, NEW.candidate_id, NEW.offered_codes, NEW.created_at)
   IS DISTINCT FROM (OLD.id, OLD.concept_id, OLD.modality, OLD.rights_policy, OLD.route_id, OLD.candidate_id, OLD.offered_codes, OLD.created_at) THEN
  RAISE EXCEPTION 'A supply request''s need and material never change';
 END IF;
 IF OLD.status NOT IN ('open','sending') THEN RAISE EXCEPTION 'A settled supply request is closed'; END IF;
 IF OLD.status = 'sending' AND NEW.status IN ('open','cancelled') THEN
  RAISE EXCEPTION 'A request that may have been sent is never reopened or cancelled';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supply_request_guard BEFORE INSERT OR UPDATE OR DELETE ON supply_request
 FOR EACH ROW EXECUTE FUNCTION supply_request_guard();

-- The route's bucket holds one unit for each request from the moment it is funded: a request opens
-- only while a unit is left, its unit is consumed when it is sent and released when it settles
-- unsent. So a reader never waits on a request the route cannot pay for.
CREATE FUNCTION supply_request_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE bucket uuid;
BEGIN
 SELECT request_bucket_id INTO bucket FROM scroll_writing_route WHERE id = NEW.route_id;
 IF TG_OP = 'INSERT' THEN
  UPDATE reasoning_bucket SET reserved = reserved + 1 WHERE id = bucket AND reserved + consumed + 1 <= capacity;
  IF NOT FOUND THEN RAISE EXCEPTION 'The writing route has no budget left for another request'; END IF;
 ELSIF OLD.status = 'open' AND NEW.status = 'sending' THEN
  UPDATE reasoning_bucket SET reserved = reserved - 1, consumed = consumed + 1 WHERE id = bucket;
 ELSIF OLD.status = 'open' AND NEW.status <> 'open' THEN
  UPDATE reasoning_bucket SET reserved = reserved - 1 WHERE id = bucket;
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER supply_request_budget AFTER INSERT OR UPDATE OF status ON supply_request
 FOR EACH ROW EXECUTE FUNCTION supply_request_budget();

-- Private demand ----------------------------------------------------------------------------------

-- A need with an owner and a cause. Its public face is a concept code; it never holds the reader's
-- words. `causes` and `decisions` (the Quartermaster's, each with its version) are only appended.
CREATE TABLE content_demand (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 concept_id uuid NOT NULL REFERENCES concept(id),
 modality text NOT NULL CHECK (modality = 'scroll'),
 status text NOT NULL CHECK (status IN ('open','waiting','bound','cannot_meet','cancelled')),
 decision text CHECK (decision IN ('reuse','join','fund','cannot_meet')),
 reason text CHECK (reason ~ '^[a-z][a-z_]{1,63}$'),
 causes jsonb NOT NULL CHECK (jsonb_typeof(causes) = 'array' AND jsonb_array_length(causes) BETWEEN 1 AND 8),
 decisions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(decisions) = 'array'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (id, universe_id, privacy_epoch),
 CHECK (status <> 'open' OR (decision IS NULL AND reason IS NULL)),
 CHECK (status <> 'bound' OR decision = 'reuse'),
 CHECK (status <> 'waiting' OR decision IN ('join','fund')),
 CHECK (status <> 'cannot_meet' OR decision = 'cannot_meet'),
 CHECK ((status IN ('cannot_meet','cancelled')) = (reason IS NOT NULL))
);
-- One live demand per scope, concept and modality: a later cause joins it.
CREATE UNIQUE INDEX content_demand_one_live ON content_demand(universe_id, privacy_epoch, concept_id, modality) WHERE status <> 'cancelled';

-- A demand's wait on a shared request. Cancelling one never touches another universe's waiter or the request.
CREATE TABLE demand_waiter (
 id uuid PRIMARY KEY,
 demand_id uuid NOT NULL,
 universe_id uuid NOT NULL,
 privacy_epoch integer NOT NULL,
 request_id uuid NOT NULL REFERENCES supply_request(id),
 status text NOT NULL CHECK (status IN ('waiting','bound','released','cancelled')),
 reason text CHECK (reason ~ '^[a-z][a-z_]{1,63}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 settled_at timestamptz,
 FOREIGN KEY (demand_id, universe_id, privacy_epoch) REFERENCES content_demand(id, universe_id, privacy_epoch),
 CHECK ((status = 'waiting') = (settled_at IS NULL)),
 CHECK ((status = 'cancelled') = (reason IS NOT NULL))
);
CREATE UNIQUE INDEX demand_waiter_one_waiting ON demand_waiter(demand_id) WHERE status = 'waiting';
CREATE INDEX demand_waiter_request ON demand_waiter(request_id) WHERE status = 'waiting';

-- A private binding of one eligible Scroll to one demand. A continuation's gap keeps its origin, so
-- the Scroll can open as the continuation it was needed for.
CREATE TABLE encounter_binding (
 id uuid PRIMARY KEY,
 demand_id uuid NOT NULL,
 universe_id uuid NOT NULL,
 privacy_epoch integer NOT NULL,
 asset_id uuid NOT NULL REFERENCES asset(id),
 place_id uuid REFERENCES atlas_place(id),
 origin_bridge_id uuid REFERENCES bridge(id),
 origin_exposure_id uuid REFERENCES exposure(id),
 status text NOT NULL CHECK (status IN ('active','withdrawn')),
 withdrawn_reason text CHECK (withdrawn_reason = 'source_correction'),
 bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 withdrawn_at timestamptz,
 FOREIGN KEY (demand_id, universe_id, privacy_epoch) REFERENCES content_demand(id, universe_id, privacy_epoch),
 CHECK ((status = 'withdrawn') = (withdrawn_at IS NOT NULL) AND (status = 'withdrawn') = (withdrawn_reason IS NOT NULL)),
 CHECK ((origin_bridge_id IS NULL) = (origin_exposure_id IS NULL))
);
CREATE INDEX encounter_binding_demand ON encounter_binding(demand_id, bound_at DESC);
CREATE INDEX encounter_binding_active ON encounter_binding(universe_id) WHERE status = 'active';

-- Written in the universe's current epoch; while it is paused, only cancellation. Each table's own
-- rules follow.
CREATE FUNCTION content_inventory_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paused boolean;
BEGIN
 SELECT recording_paused_at IS NOT NULL INTO paused FROM universe WHERE id = NEW.universe_id AND privacy_epoch = NEW.privacy_epoch;
 IF NOT FOUND THEN RAISE EXCEPTION '% rows belong to their universe''s current privacy epoch', TG_TABLE_NAME; END IF;
 IF paused AND (TG_OP = 'INSERT' OR TG_TABLE_NAME = 'encounter_binding' OR NEW.status <> 'cancelled') THEN
  RAISE EXCEPTION 'Recording is paused';
 END IF;
 IF TG_OP = 'INSERT' THEN
  -- Each table's columns are named only inside its own branch (PL/pgSQL plans a whole expression).
  IF TG_TABLE_NAME = 'encounter_binding' THEN
   IF NEW.status <> 'active' OR NOT scroll_is_eligible(NEW.asset_id) THEN RAISE EXCEPTION 'A binding is made only to an eligible Scroll'; END IF;
  END IF;
  RETURN NEW;
 END IF;
 IF TG_TABLE_NAME = 'content_demand' THEN
  IF (NEW.id, NEW.universe_id, NEW.privacy_epoch, NEW.concept_id, NEW.modality, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.universe_id, OLD.privacy_epoch, OLD.concept_id, OLD.modality, OLD.created_at) THEN
   RAISE EXCEPTION 'A demand''s owner and need never change';
  END IF;
  IF OLD.status = 'cancelled' THEN RAISE EXCEPTION 'A cancelled demand is closed'; END IF;
  IF NOT jsonb_array_extends(NEW.causes, OLD.causes) OR NOT jsonb_array_extends(NEW.decisions, OLD.decisions) THEN
   RAISE EXCEPTION 'A demand''s causes and decisions are only ever appended';
  END IF;
 ELSIF TG_TABLE_NAME = 'demand_waiter' THEN
  IF OLD.status <> 'waiting' OR (to_jsonb(NEW) - 'status' - 'reason' - 'settled_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'reason' - 'settled_at') THEN
   RAISE EXCEPTION 'A waiter only ever settles, once';
  END IF;
 ELSIF OLD.status <> 'active' OR NEW.status <> 'withdrawn'
   OR (to_jsonb(NEW) - 'status' - 'withdrawn_reason' - 'withdrawn_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'withdrawn_reason' - 'withdrawn_at') THEN
  RAISE EXCEPTION 'A binding is only ever withdrawn, once';
 END IF;
 RETURN NEW;
END $$;
-- Row triggers fire in name order: the epoch/pause guard speaks first.
CREATE TRIGGER content_demand_1_history BEFORE INSERT OR UPDATE ON content_demand FOR EACH ROW EXECUTE FUNCTION content_inventory_guard();
CREATE TRIGGER demand_waiter_1_history BEFORE INSERT OR UPDATE ON demand_waiter FOR EACH ROW EXECUTE FUNCTION content_inventory_guard();
CREATE TRIGGER encounter_binding_1_history BEFORE INSERT OR UPDATE ON encounter_binding FOR EACH ROW EXECUTE FUNCTION content_inventory_guard();
CREATE TRIGGER content_demand_erase BEFORE DELETE ON content_demand FOR EACH ROW EXECUTE FUNCTION background_inquiry_erase_after_epoch();
CREATE TRIGGER demand_waiter_erase BEFORE DELETE ON demand_waiter FOR EACH ROW EXECUTE FUNCTION background_inquiry_erase_after_epoch();
CREATE TRIGGER encounter_binding_erase BEFORE DELETE ON encounter_binding FOR EACH ROW EXECUTE FUNCTION background_inquiry_erase_after_epoch();

-- The Composer serves a bound Scroll first --------------------------------------------------------

-- A new reason for composer-semantic-v3; the released templates are untouched.
INSERT INTO composer_reason_template(explanation_key, policy_version, template) VALUES
 ('v3_demand_bound', 'composer-semantic-v3', 'More about {{conceptName}}: you had already seen everything here.');

-- Migration 0027's v3 invariants, unchanged but for one more quota that may choose the head: a
-- Scroll bound to the reader's own need (`demand_bound`, ADR-0046 §2).
CREATE OR REPLACE FUNCTION composer_candidate_invariants() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; d record; kind text; returned uuid[]; ranked uuid[]; max_rank integer; ranked_count integer;
  ctx record; cap integer; worst integer; inversions integer; head_score double precision; best double precision; head_family text;
BEGIN
 IF TG_TABLE_NAME = 'decision' THEN target := COALESCE(NEW.id, OLD.id);
 ELSIF TG_TABLE_NAME = 'decision_context' THEN target := COALESCE(NEW.decision_id, OLD.decision_id);
 ELSE target := COALESCE(NEW.decision_id, OLD.decision_id);
 END IF;
 SELECT dd.id, dd.candidates, dd.ranking_version INTO d FROM decision dd WHERE dd.id = target;
 IF d.id IS NULL THEN RETURN NULL; END IF;
 SELECT record_kind, max_per_source INTO kind, cap FROM composer_policy WHERE version = d.ranking_version;
 IF kind IS DISTINCT FROM 'decision_candidate' THEN RETURN NULL; END IF;
 SELECT COALESCE(array_agg((c->>'assetId')::uuid ORDER BY (c->>'assetId')::uuid), '{}'::uuid[]) INTO returned FROM jsonb_array_elements(d.candidates) c;
 SELECT COALESCE(array_agg(asset_id ORDER BY asset_id), '{}'::uuid[]), COALESCE(max(rank), 0), count(*)
  INTO ranked, max_rank, ranked_count FROM decision_candidate WHERE decision_id = target AND rank IS NOT NULL;
 IF returned IS DISTINCT FROM ranked OR max_rank <> ranked_count THEN
  RAISE EXCEPTION 'A v3 decision must rank exactly the candidates it returned, densely from 1';
 END IF;
 SELECT * INTO ctx FROM decision_context WHERE decision_id = target;
 IF ctx.decision_id IS NULL THEN RAISE EXCEPTION 'A v3 decision must record its served window and quotas'; END IF;
 SELECT max(n) INTO worst FROM (SELECT count(*) AS n FROM decision_candidate dc JOIN asset a ON a.id = dc.asset_id
  WHERE dc.decision_id = target AND dc.rank IS NOT NULL GROUP BY a.source_url) s;
 IF worst > cap THEN RAISE EXCEPTION 'A v3 decision may not let one source exceed its policy cap'; END IF;
 SELECT count(*) INTO inversions FROM decision_candidate x JOIN decision_candidate y ON x.decision_id = y.decision_id
  WHERE x.decision_id = target AND x.rank >= 2 AND y.rank > x.rank AND y.score > x.score;
 IF inversions > 0 THEN RAISE EXCEPTION 'After the head, a v3 decision''s recorded ranks must not contradict its scores'; END IF;
 SELECT score, family INTO head_score, head_family FROM decision_candidate WHERE decision_id = target AND rank = 1;
 SELECT max(score) INTO best FROM decision_candidate WHERE decision_id = target AND rank IS NOT NULL;
 -- The quota must be the one that could have chosen this head: the exploration floor for its family,
 -- the adjacent-repeat rule (which names no family), or a bound Scroll, served as a continuation.
 IF head_score IS NOT NULL AND head_score < best
    AND NOT (ctx.quotas ? ('exploration_floor:' || head_family) OR ctx.quotas ? 'no_adjacent_repeat'
      OR (ctx.quotas ? 'demand_bound' AND head_family = 'continue')) THEN
  RAISE EXCEPTION 'A v3 head that is not the best-scoring candidate must record the quota that chose it';
 END IF;
 RETURN NULL;
END $$;
