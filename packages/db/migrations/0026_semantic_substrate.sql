-- ADR-0031 (#131): the semantic substrate. Sources and their snapshots, evidence families,
-- concepts, claims with exact quoted support, typed substrate relations, conceptual bridges that
-- only a validated proposal can create, deterministic corrections, and the first personal consumers
-- (branch opens and connection feedback). Shared rows are editorial/research knowledge beyond any
-- universe; universe-scoped rows are private history erased by Clear/Reset.
--
-- The database enforces the structural minimum the validator (packages/core/src/semantic) relies
-- on: an admitted bridge must cite current support for both sides and its mechanism, a source
-- snapshot only moves forward (current -> corrected | revoked), and knowledge rows are immutable
-- (a changed statement is a new claim, never an edit to one someone already read).

-- Knowledge ------------------------------------------------------------------------------------

CREATE TABLE evidence_family (
 id uuid PRIMARY KEY,
 key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_.-]{2,79}$'),
 kind text NOT NULL CHECK (kind IN ('publisher','author','dataset')),
 description text NOT NULL CHECK (length(btrim(description)) BETWEEN 8 AND 400),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE semantic_source (
 id uuid PRIMARY KEY,
 key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_.-]{2,79}$'),
 url text NOT NULL UNIQUE CHECK (url ~ '^https://' AND length(url) <= 2000),
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 300),
 publisher text NOT NULL CHECK (length(btrim(publisher)) BETWEEN 2 AND 120),
 family_id uuid NOT NULL REFERENCES evidence_family(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A snapshot is the exact text a set of quotes was verified against. Correction never edits it:
-- the snapshot's status moves forward and a re-verified revision is a new row.
CREATE TABLE source_snapshot (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES semantic_source(id),
 revision integer NOT NULL CHECK (revision >= 1),
 retrieved_on date NOT NULL,
 content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
 status text NOT NULL DEFAULT 'current' CHECK (status IN ('current','corrected','revoked')),
 status_reason text CHECK (status_reason IS NULL OR length(btrim(status_reason)) BETWEEN 8 AND 400),
 status_changed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (source_id, revision),
 CHECK ((status = 'current') = (status_reason IS NULL AND status_changed_at IS NULL))
);
CREATE UNIQUE INDEX source_snapshot_one_current ON source_snapshot(source_id) WHERE status = 'current';

CREATE FUNCTION source_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Source snapshots are history; correct them, never delete them'; END IF;
 IF (NEW.id, NEW.source_id, NEW.revision, NEW.retrieved_on, NEW.content_sha256, NEW.created_at)
   IS DISTINCT FROM (OLD.id, OLD.source_id, OLD.revision, OLD.retrieved_on, OLD.content_sha256, OLD.created_at)
 THEN RAISE EXCEPTION 'A source snapshot''s identity and content hash are immutable'; END IF;
 IF OLD.status <> 'current' THEN RAISE EXCEPTION 'A corrected or revoked snapshot cannot change again'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER source_snapshot_guard BEFORE UPDATE OR DELETE ON source_snapshot
 FOR EACH ROW EXECUTE FUNCTION source_snapshot_guard();

CREATE TABLE concept (
 id uuid PRIMARY KEY,
 code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,5}$'),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
 description text NOT NULL CHECK (length(btrim(description)) BETWEEN 8 AND 400),
 kind text NOT NULL CHECK (kind IN ('phenomenon','mechanism','law','quantity','object','process','idea')),
 parent_id uuid REFERENCES concept(id),
 created_by text NOT NULL CHECK (created_by IN ('editorial','research','model_proposal')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX concept_parent ON concept(parent_id);

CREATE TABLE claim (
 id uuid PRIMARY KEY,
 key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9_.-]{2,79}$'),
 statement text NOT NULL CHECK (length(btrim(statement)) BETWEEN 12 AND 400),
 truth_state text NOT NULL CHECK (truth_state IN ('documented','synthesis','interpretation','disputed','modelled','counterfactual','fictional')),
 created_by text NOT NULL CHECK (created_by IN ('editorial','research','model_proposal')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE claim_concept (
 claim_id uuid NOT NULL REFERENCES claim(id),
 concept_id uuid NOT NULL REFERENCES concept(id),
 role text NOT NULL CHECK (role IN ('subject','object','mechanism','context')),
 PRIMARY KEY (claim_id, concept_id, role)
);
CREATE INDEX claim_concept_concept ON claim_concept(concept_id);

CREATE TABLE claim_support (
 id uuid PRIMARY KEY,
 claim_id uuid NOT NULL REFERENCES claim(id),
 snapshot_id uuid NOT NULL REFERENCES source_snapshot(id),
 quote text NOT NULL CHECK (length(btrim(quote)) BETWEEN 12 AND 400),
 support_kind text NOT NULL CHECK (support_kind IN ('supports','qualifies','contradicts')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (claim_id, snapshot_id, quote)
);
CREATE INDEX claim_support_snapshot ON claim_support(snapshot_id);

-- The one definition of "currently supported": a `supports` quote on a current snapshot.
CREATE FUNCTION claim_is_supported(target uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS (
  SELECT 1 FROM claim_support s JOIN source_snapshot ss ON ss.id = s.snapshot_id
  WHERE s.claim_id = target AND s.support_kind = 'supports' AND ss.status = 'current'
 )
$$;

CREATE TABLE concept_relation (
 id uuid PRIMARY KEY,
 from_concept_id uuid NOT NULL REFERENCES concept(id),
 to_concept_id uuid NOT NULL REFERENCES concept(id),
 kind text NOT NULL CHECK (kind IN ('narrower_than','part_of','prerequisite_for','explains','contradicts','analogous_in','applies_to')),
 claim_id uuid NOT NULL REFERENCES claim(id),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
 status_reason text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (from_concept_id, to_concept_id, kind),
 CHECK (from_concept_id <> to_concept_id),
 CHECK ((status = 'active') = (status_reason IS NULL))
);

CREATE FUNCTION concept_relation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Substrate relations are revoked, never deleted'; END IF;
 IF (NEW.id, NEW.from_concept_id, NEW.to_concept_id, NEW.kind, NEW.claim_id, NEW.created_at)
   IS DISTINCT FROM (OLD.id, OLD.from_concept_id, OLD.to_concept_id, OLD.kind, OLD.claim_id, OLD.created_at)
 THEN RAISE EXCEPTION 'A substrate relation''s identity is immutable'; END IF;
 IF OLD.status = 'revoked' THEN RAISE EXCEPTION 'A revoked substrate relation cannot change again'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER concept_relation_guard BEFORE UPDATE OR DELETE ON concept_relation
 FOR EACH ROW EXECUTE FUNCTION concept_relation_guard();

-- What each editorial asset is about and which claims it presents. Annotations follow the asset:
-- a changed annotation belongs to a new asset revision, not an edit to what a reader already saw.
CREATE TABLE asset_concept (
 asset_id uuid NOT NULL REFERENCES asset(id),
 concept_id uuid NOT NULL REFERENCES concept(id),
 role text NOT NULL CHECK (role IN ('primary','secondary','mentioned')),
 PRIMARY KEY (asset_id, concept_id)
);
CREATE UNIQUE INDEX asset_concept_one_primary ON asset_concept(asset_id) WHERE role = 'primary';
CREATE INDEX asset_concept_concept ON asset_concept(concept_id);

CREATE TABLE asset_claim (
 asset_id uuid NOT NULL REFERENCES asset(id),
 claim_id uuid NOT NULL REFERENCES claim(id),
 PRIMARY KEY (asset_id, claim_id)
);

-- Which editorial substrate versions were loaded, when, and what they contained.
CREATE TABLE semantic_seed_load (
 version text PRIMARY KEY CHECK (version ~ '^editorial-substrate-\d{4}-\d{2}-\d{2}(\.\d+)?$'),
 content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
 counts jsonb NOT NULL CHECK (jsonb_typeof(counts) = 'object'),
 loaded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER evidence_family_immutable BEFORE UPDATE OR DELETE ON evidence_family FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER semantic_source_immutable BEFORE UPDATE OR DELETE ON semantic_source FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER concept_immutable BEFORE UPDATE OR DELETE ON concept FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER claim_immutable BEFORE UPDATE OR DELETE ON claim FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER claim_concept_immutable BEFORE UPDATE OR DELETE ON claim_concept FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER claim_support_immutable BEFORE UPDATE OR DELETE ON claim_support FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER asset_concept_immutable BEFORE UPDATE OR DELETE ON asset_concept FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER asset_claim_immutable BEFORE UPDATE OR DELETE ON asset_claim FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER semantic_seed_load_immutable BEFORE UPDATE OR DELETE ON semantic_seed_load FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- Proposals and bridges -------------------------------------------------------------------------

-- Every proposal is decided in the transaction that submits it and kept as history: the payload,
-- the read set it was judged against, and the validator's decision. `shared` proposals are
-- substrate knowledge; `universe` proposals belong to one person and follow their privacy epoch.
CREATE TABLE semantic_proposal (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('bridge_candidate')),
 scope_kind text NOT NULL CHECK (scope_kind IN ('shared','universe')),
 universe_id uuid REFERENCES universe(id),
 privacy_epoch integer CHECK (privacy_epoch >= 0),
 proposer_kind text NOT NULL CHECK (proposer_kind IN ('editorial','rule','model','person')),
 proposer_ref text NOT NULL CHECK (length(btrim(proposer_ref)) BETWEEN 3 AND 200),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
 payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
 read_set jsonb NOT NULL CHECK (jsonb_typeof(read_set) = 'object'),
 status text NOT NULL CHECK (status IN ('admitted','rejected')),
 decision jsonb NOT NULL CHECK (jsonb_typeof(decision) = 'object'),
 validator_version text NOT NULL CHECK (validator_version ~ '^[a-z0-9.-]{3,64}$'),
 decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((scope_kind = 'shared' AND universe_id IS NULL AND privacy_epoch IS NULL)
     OR (scope_kind = 'universe' AND universe_id IS NOT NULL AND privacy_epoch IS NOT NULL)),
 -- The recorded decision is the authority for the status; a row cannot claim an admission its
 -- own decision does not record.
 CHECK (decision->>'outcome' = status AND decision->>'validatorVersion' = validator_version)
);
-- Replay identity is per scope: the same proposer ref and payload in another universe is another
-- proposal, never a replay of this one.
CREATE UNIQUE INDEX semantic_proposal_replay ON semantic_proposal(proposer_kind, proposer_ref, payload_sha256,
 COALESCE(universe_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX semantic_proposal_universe ON semantic_proposal(universe_id) WHERE universe_id IS NOT NULL;

CREATE TABLE bridge (
 id uuid PRIMARY KEY,
 proposal_id uuid NOT NULL UNIQUE REFERENCES semantic_proposal(id),
 scope_kind text NOT NULL CHECK (scope_kind IN ('shared','universe')),
 universe_id uuid REFERENCES universe(id),
 privacy_epoch integer CHECK (privacy_epoch >= 0),
 from_concept_id uuid NOT NULL REFERENCES concept(id),
 to_concept_id uuid NOT NULL REFERENCES concept(id),
 relation_type text NOT NULL CHECK (relation_type IN ('analogous_in','applies_to','prerequisite_for','explains','compares_mechanism')),
 mechanism text NOT NULL CHECK (length(btrim(mechanism)) BETWEEN 40 AND 600),
 prerequisites jsonb NOT NULL CHECK (jsonb_typeof(prerequisites) = 'array' AND jsonb_array_length(prerequisites) BETWEEN 1 AND 5),
 limitations jsonb NOT NULL CHECK (jsonb_typeof(limitations) = 'array' AND jsonb_array_length(limitations) BETWEEN 1 AND 5),
 counterevidence jsonb NOT NULL CHECK (jsonb_typeof(counterevidence) = 'object'),
 validator_version text NOT NULL,
 status text NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted','revoked','superseded')),
 status_reason jsonb,
 status_changed_at timestamptz,
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (from_concept_id <> to_concept_id),
 CHECK ((status = 'admitted') = (status_reason IS NULL AND status_changed_at IS NULL)),
 CHECK ((scope_kind = 'shared' AND universe_id IS NULL AND privacy_epoch IS NULL)
     OR (scope_kind = 'universe' AND universe_id IS NOT NULL AND privacy_epoch IS NOT NULL))
);
CREATE UNIQUE INDEX bridge_one_admitted ON bridge(from_concept_id, to_concept_id, relation_type,
 COALESCE(universe_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'admitted';
CREATE INDEX bridge_from ON bridge(from_concept_id) WHERE status = 'admitted';
CREATE INDEX bridge_to ON bridge(to_concept_id) WHERE status = 'admitted';

CREATE TABLE bridge_evidence (
 bridge_id uuid NOT NULL REFERENCES bridge(id) ON DELETE CASCADE,
 claim_id uuid NOT NULL REFERENCES claim(id),
 supports text NOT NULL CHECK (supports IN ('from','to','mechanism','limitation')),
 PRIMARY KEY (bridge_id, claim_id, supports)
);
CREATE INDEX bridge_evidence_claim ON bridge_evidence(claim_id);

-- A bridge's content is what was validated. Only its status moves (admitted -> revoked |
-- superseded), and a shared bridge is never deleted; a universe-scoped one disappears only with
-- its universe's history (Clear/Reset delete its proposal and it together).
CREATE FUNCTION bridge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF OLD.scope_kind = 'shared' THEN RAISE EXCEPTION 'Shared bridges are revoked, never deleted'; END IF;
  RETURN OLD;
 END IF;
 IF (NEW.id, NEW.proposal_id, NEW.scope_kind, NEW.universe_id, NEW.privacy_epoch, NEW.from_concept_id, NEW.to_concept_id,
     NEW.relation_type, NEW.mechanism, NEW.prerequisites, NEW.limitations, NEW.counterevidence, NEW.validator_version, NEW.admitted_at)
   IS DISTINCT FROM (OLD.id, OLD.proposal_id, OLD.scope_kind, OLD.universe_id, OLD.privacy_epoch, OLD.from_concept_id, OLD.to_concept_id,
     OLD.relation_type, OLD.mechanism, OLD.prerequisites, OLD.limitations, OLD.counterevidence, OLD.validator_version, OLD.admitted_at)
 THEN RAISE EXCEPTION 'A bridge''s validated content is immutable; a revision is a new proposal'; END IF;
 IF OLD.status <> 'admitted' THEN RAISE EXCEPTION 'A revoked or superseded bridge cannot change again'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bridge_guard BEFORE UPDATE OR DELETE ON bridge FOR EACH ROW EXECUTE FUNCTION bridge_guard();

-- A bridge enters only through an admitted proposal of the same scope.
CREATE FUNCTION bridge_requires_admitted_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record;
BEGIN
 SELECT status, scope_kind, universe_id, privacy_epoch, kind INTO p FROM semantic_proposal WHERE id = NEW.proposal_id;
 IF p IS NULL OR p.status <> 'admitted' OR p.kind <> 'bridge_candidate' THEN
  RAISE EXCEPTION 'A bridge requires an admitted bridge_candidate proposal';
 END IF;
 IF (p.scope_kind, p.universe_id, p.privacy_epoch) IS DISTINCT FROM (NEW.scope_kind, NEW.universe_id, NEW.privacy_epoch) THEN
  RAISE EXCEPTION 'A bridge must have exactly its proposal''s scope';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bridge_requires_admitted_proposal BEFORE INSERT ON bridge
 FOR EACH ROW EXECUTE FUNCTION bridge_requires_admitted_proposal();

-- The structural minimum, checked at commit: an admitted bridge cites currently supported
-- evidence for its from side, its to side and its mechanism. The full rules live in the pure
-- validator; this makes the one thing that must never happen -- an admitted, unevidenced
-- connection -- impossible to commit.
CREATE FUNCTION bridge_admitted_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; b record; missing text;
BEGIN
 -- IF, not CASE: PL/pgSQL plans a CASE expression against both row types, and `bridge` has no
 -- bridge_id column (the same reason migration 0022's coverage trigger branches this way).
 IF TG_TABLE_NAME = 'bridge' THEN target := COALESCE(NEW.id, OLD.id);
 ELSE target := COALESCE(NEW.bridge_id, OLD.bridge_id);
 END IF;
 SELECT id, status INTO b FROM bridge WHERE id = target;
 IF b IS NULL OR b.status <> 'admitted' THEN RETURN NULL; END IF;
 SELECT string_agg(side, ', ') INTO missing FROM unnest(ARRAY['from','to','mechanism']) AS side
  WHERE NOT EXISTS (SELECT 1 FROM bridge_evidence e WHERE e.bridge_id = target AND e.supports = side AND claim_is_supported(e.claim_id));
 IF missing IS NOT NULL THEN
  RAISE EXCEPTION 'An admitted bridge needs currently supported evidence for: %', missing;
 END IF;
 RETURN NULL;
END $$;
-- Evidence is part of what was validated: never edited, and removed only with its bridge (the
-- ON DELETE CASCADE from a universe bridge's erasure, when the parent row is already gone).
CREATE FUNCTION bridge_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Bridge evidence is immutable'; END IF;
 IF EXISTS (SELECT 1 FROM bridge WHERE id = OLD.bridge_id) THEN
  RAISE EXCEPTION 'Bridge evidence is removed only with its bridge';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER bridge_evidence_guard BEFORE UPDATE OR DELETE ON bridge_evidence
 FOR EACH ROW EXECUTE FUNCTION bridge_evidence_guard();

CREATE CONSTRAINT TRIGGER bridge_admitted_evidence_on_bridge AFTER INSERT OR UPDATE ON bridge
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bridge_admitted_evidence_guard();
CREATE CONSTRAINT TRIGGER bridge_admitted_evidence_on_evidence AFTER INSERT OR UPDATE OR DELETE ON bridge_evidence
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bridge_admitted_evidence_guard();

-- A snapshot correction must be propagated in the same transaction: at commit, no admitted bridge
-- may cite (in any role) a claim that this snapshot's change left without current support. A raw
-- status UPDATE that skips revalidation is refused rather than leaving stale connections live.
CREATE FUNCTION snapshot_correction_propagated() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stale uuid;
BEGIN
 IF NEW.status = 'current' THEN RETURN NULL; END IF;
 SELECT b.id INTO stale FROM bridge b JOIN bridge_evidence e ON e.bridge_id = b.id
  WHERE b.status = 'admitted' AND NOT claim_is_supported(e.claim_id)
    AND e.claim_id IN (SELECT claim_id FROM claim_support WHERE snapshot_id = NEW.id)
  LIMIT 1;
 IF stale IS NOT NULL THEN
  RAISE EXCEPTION 'Bridge % still cites a claim this correction left unsupported; revalidate it in the same transaction', stale;
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER source_snapshot_correction_propagated AFTER UPDATE ON source_snapshot
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION snapshot_correction_propagated();

-- A proposal is history: never edited; universe-scoped proposals leave only with erasure.
CREATE FUNCTION semantic_proposal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'Semantic proposals are immutable decisions'; END IF;
 IF OLD.scope_kind = 'shared' THEN RAISE EXCEPTION 'Shared proposals are never deleted'; END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER semantic_proposal_guard BEFORE UPDATE OR DELETE ON semantic_proposal
 FOR EACH ROW EXECUTE FUNCTION semantic_proposal_guard();

-- Corrections -------------------------------------------------------------------------------------

CREATE TABLE semantic_correction (
 id uuid PRIMARY KEY,
 target_kind text NOT NULL CHECK (target_kind IN ('source_snapshot','seed_load')),
 -- A snapshot id, or NULL for a seed load (named by `reason`).
 target_id uuid,
 action text NOT NULL CHECK (action IN ('corrected','revoked','revalidated')),
 CHECK ((target_kind = 'source_snapshot') = (target_id IS NOT NULL)),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 400),
 actor_kind text NOT NULL CHECK (actor_kind IN ('editorial','operator')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Every downstream status change a correction caused, so "why did this connection disappear"
-- has an answer that names the source.
CREATE TABLE semantic_correction_effect (
 correction_id uuid NOT NULL REFERENCES semantic_correction(id),
 target_kind text NOT NULL CHECK (target_kind IN ('claim','bridge','concept_relation')),
 target_id uuid NOT NULL,
 before_status text NOT NULL,
 after_status text NOT NULL,
 reasons jsonb NOT NULL CHECK (jsonb_typeof(reasons) = 'array'),
 PRIMARY KEY (correction_id, target_kind, target_id)
);
CREATE TRIGGER semantic_correction_immutable BEFORE UPDATE OR DELETE ON semantic_correction FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER semantic_correction_effect_immutable BEFORE UPDATE OR DELETE ON semantic_correction_effect FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- Personal consumers -----------------------------------------------------------------------------

ALTER TABLE ledger DROP CONSTRAINT ledger_kind_check;
ALTER TABLE ledger ADD CONSTRAINT ledger_kind_check CHECK (kind IN ('exposure','keep','ask','branch'));

-- Taking a validated continuation is a voluntary act: a `branch` Ledger event caused by the
-- exposure it started from, plus the decision that served the target (so the target's own
-- exposure is admitted exactly like any other selection).
CREATE TABLE branch_open (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 client_key uuid NOT NULL,
 event_id uuid NOT NULL UNIQUE,
 from_exposure_id uuid NOT NULL,
 bridge_id uuid NOT NULL REFERENCES bridge(id),
 decision_id uuid NOT NULL,
 target_asset_id uuid NOT NULL REFERENCES asset(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (universe_id, client_key),
 FOREIGN KEY (event_id, universe_id) REFERENCES ledger(id, universe_id),
 FOREIGN KEY (from_exposure_id, universe_id) REFERENCES exposure(id, universe_id),
 FOREIGN KEY (decision_id, universe_id) REFERENCES decision(id, universe_id)
);
CREATE INDEX branch_open_bridge ON branch_open(bridge_id);
CREATE TRIGGER branch_open_no_update BEFORE UPDATE ON branch_open FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- "Not useful to me" / "seems wrong" is personal: it suppresses the connection for this universe
-- and is usefulness evidence, never a factual retraction of shared knowledge.
CREATE TABLE connection_feedback (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 client_key uuid NOT NULL,
 bridge_id uuid NOT NULL REFERENCES bridge(id),
 objection text NOT NULL CHECK (objection IN ('not_useful','seems_wrong')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (universe_id, client_key)
);
CREATE INDEX connection_feedback_universe ON connection_feedback(universe_id, bridge_id);
CREATE TRIGGER connection_feedback_no_update BEFORE UPDATE ON connection_feedback FOR EACH ROW EXECUTE FUNCTION generation_immutable();
