-- ADR-0032 (#131, #133): attention accounts, revisable personal hypotheses, encounter feedback, and
-- the recorded, replayable `composer-semantic-v3`. Accounts, hypotheses and feedback are private
-- history (erased by Clear/Reset, exported). Decision records cascade with their decision, as
-- decision_signal already does (ADR-0029 §6). composer-signals-v2 stays registered and immutable.

-- Attention accounts -----------------------------------------------------------------------------

CREATE TABLE attention_account (
 universe_id uuid NOT NULL REFERENCES universe(id),
 concept_id uuid NOT NULL REFERENCES concept(id),
 policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9.-]{3,64}$'),
 mass double precision NOT NULL CHECK (mass >= 0 AND mass < 'Infinity'::float8),
 mass_at timestamptz NOT NULL,
 episodes integer NOT NULL CHECK (episodes >= 1),
 voluntary integer NOT NULL CHECK (voluntary >= 0),
 returns integer NOT NULL CHECK (returns >= 0),
 days_active integer NOT NULL CHECK (days_active >= 0),
 span_days integer NOT NULL CHECK (span_days >= 0),
 source_families integer NOT NULL CHECK (source_families >= 0),
 exposure_share double precision NOT NULL CHECK (exposure_share BETWEEN 0 AND 1),
 negatives integer NOT NULL CHECK (negatives >= 0),
 state text NOT NULL CHECK (state IN ('seen','anchored','dormant')),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
 computed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (universe_id, concept_id),
 -- A voluntary count can never exceed what episodes could carry (3 distinct kinds, any number of
 -- repeats is still bounded below by zero): the one cheap structural sanity check a reader can rely on.
 CHECK (days_active <= voluntary OR voluntary = 0)
);

CREATE TABLE attention_transition (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 concept_id uuid NOT NULL REFERENCES concept(id),
 from_state text CHECK (from_state IN ('seen','anchored','dormant')),
 to_state text NOT NULL CHECK (to_state IN ('seen','anchored','dormant')),
 policy_version text NOT NULL,
 at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (from_state IS DISTINCT FROM to_state)
);
CREATE INDEX attention_transition_universe ON attention_transition(universe_id, at);
CREATE TRIGGER attention_transition_no_update BEFORE UPDATE ON attention_transition FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- Hypotheses ------------------------------------------------------------------------------------

CREATE TABLE personal_hypothesis (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 kind text NOT NULL CHECK (kind IN ('direction','open_question')),
 concept_id uuid NOT NULL REFERENCES concept(id),
 proposer_kind text NOT NULL CHECK (proposer_kind IN ('rule','model')),
 rule_version text NOT NULL,
 statement text NOT NULL CHECK (length(btrim(statement)) BETWEEN 8 AND 280),
 confidence_label text NOT NULL CHECK (confidence_label IN ('low','medium')),
 status text NOT NULL CHECK (status IN ('active','contested','decayed')),
 permitted_uses text[] NOT NULL CHECK (permitted_uses <@ ARRAY['composer.family_prior','composer.continuity','steward.context','chronicle.wording']::text[]),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array' AND jsonb_array_length(evidence) >= 1),
 alternatives jsonb NOT NULL CHECK (jsonb_typeof(alternatives) = 'array' AND jsonb_array_length(alternatives) >= 1),
 counterevidence jsonb NOT NULL CHECK (jsonb_typeof(counterevidence) = 'array'),
 decay jsonb NOT NULL CHECK (jsonb_typeof(decay) = 'object'),
 revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 revised_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (universe_id, kind, concept_id),
 -- Only an active hypothesis may be used; only a rule-proposed direction may shape ranking.
 CHECK (status = 'active' OR permitted_uses = '{}'::text[]),
 CHECK (NOT ('composer.family_prior' = ANY(permitted_uses)) OR (proposer_kind = 'rule' AND kind = 'direction'))
);

-- Encounter feedback (journey G) ---------------------------------------------------------------

CREATE TABLE encounter_feedback (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 client_key uuid NOT NULL,
 decision_id uuid NOT NULL,
 asset_id uuid NOT NULL REFERENCES asset(id),
 kind text NOT NULL CHECK (kind IN ('less_like_this','wrong_connection')),
 family text NOT NULL,
 concept_id uuid REFERENCES concept(id),
 bridge_id uuid REFERENCES bridge(id),
 suppress_until timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (universe_id, client_key),
 FOREIGN KEY (decision_id, universe_id) REFERENCES decision(id, universe_id),
 CHECK (kind <> 'wrong_connection' OR bridge_id IS NOT NULL)
);
CREATE INDEX encounter_feedback_universe ON encounter_feedback(universe_id, suppress_until);
-- One correction of a kind per served encounter, whatever key a client retries with.
CREATE UNIQUE INDEX encounter_feedback_once ON encounter_feedback(universe_id, decision_id, asset_id, kind);
CREATE TRIGGER encounter_feedback_no_update BEFORE UPDATE ON encounter_feedback FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- composer-semantic-v3 --------------------------------------------------------------------------

-- Which record a policy writes. Existing rows keep the ADR-0029 decision_signal contract.
ALTER TABLE composer_policy ADD COLUMN record_kind text NOT NULL DEFAULT 'decision_signal'
 CHECK (record_kind IN ('decision_signal','decision_candidate'));

INSERT INTO composer_policy(version, weights, slate_size, max_per_source, record_kind) VALUES (
 'composer-semantic-v3',
 '{"maxPerConcept":1,"weights":{"continuity":1,"useful":1,"depth":1,"novelty":1,"returnRelevance":1,"prior":1,"redundancy":1,"fatigue":1,"seen":1},"familyDepth":{"continue":0.3,"deepen":0.8,"bridge":1.2,"challenge":0.7,"revisit":0.2,"frontier":0.4,"seed":0.3,"fallback":0},"continuityWindowHours":72,"explorationEvery":3,"fatigueWindow":5,"redundancyWindowDays":30,"revisitMinGapDays":3,"usefulSaturation":{"exposureShare":0.8,"cap":0.5},"terms":{"continuity":0.3,"questionContinuity":0.2,"novelty":0.5,"returnRelevance":0.3,"prior":0.1,"redundancy":0.6,"redundancyShare":0.5,"fatigueStep":0.15,"usefulScale":4,"parentMassShare":0.5,"seenPerShowing":10,"maxMarks":50}}'::jsonb,
 3, 2, 'decision_candidate'
);

CREATE TABLE composer_reason_template (
 explanation_key text PRIMARY KEY CHECK (explanation_key ~ '^v3_[a-z_]{3,40}$'),
 policy_version text NOT NULL REFERENCES composer_policy(version),
 template text NOT NULL CHECK (
  length(template) BETWEEN 1 AND 280
  AND composer_template_placeholders(template) <@ ARRAY['conceptName','markVerb','markTitle','fromName','relationPhrase','toName','parentName','domainName']
 )
);
CREATE TRIGGER composer_reason_template_immutable BEFORE UPDATE OR DELETE ON composer_reason_template FOR EACH ROW EXECUTE FUNCTION generation_immutable();
INSERT INTO composer_reason_template(explanation_key, policy_version, template) VALUES
 ('v3_continue', 'composer-semantic-v3', 'Continues {{conceptName}}: you {{markVerb}} “{{markTitle}}”.'),
 ('v3_question', 'composer-semantic-v3', 'Near a question you asked about {{conceptName}}.'),
 ('v3_deepen', 'composer-semantic-v3', 'Goes deeper into {{parentName}}: {{conceptName}}.'),
 ('v3_bridge', 'composer-semantic-v3', 'A sourced connection from “{{markTitle}}”: {{fromName}} {{relationPhrase}} {{toName}}.'),
 ('v3_challenge', 'composer-semantic-v3', 'A source that tests a common idea near {{conceptName}}.'),
 ('v3_revisit', 'composer-semantic-v3', 'Back to {{conceptName}}: you {{markVerb}} “{{markTitle}}” since you last saw this.'),
 ('v3_frontier', 'composer-semantic-v3', 'Something outside what you have explored so far: {{domainName}}.'),
 ('v3_seed', 'composer-semantic-v3', 'A first door into {{domainName}}.'),
 ('v3_fallback', 'composer-semantic-v3', 'Not yet mapped to anything you have done; offered so nothing in the library stays hidden.');

-- Every candidate the policy considered, selected or gated, with its family, terms and facts.
CREATE TABLE decision_candidate (
 id uuid PRIMARY KEY,
 decision_id uuid NOT NULL,
 universe_id uuid NOT NULL,
 asset_id uuid NOT NULL REFERENCES asset(id),
 family text NOT NULL CHECK (family IN ('continue','deepen','bridge','challenge','revisit','frontier','seed','fallback')),
 concept_id uuid REFERENCES concept(id),
 bridge_id uuid REFERENCES bridge(id),
 gate text CHECK (gate IN ('kept','suppressed_by_person','current_encounter')),
 terms jsonb NOT NULL CHECK (jsonb_typeof(terms) = 'object'),
 score double precision NOT NULL CHECK (score > '-Infinity'::float8 AND score < 'Infinity'::float8),
 rank integer CHECK (rank >= 1),
 explanation_key text NOT NULL REFERENCES composer_reason_template(explanation_key),
 facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
 UNIQUE (decision_id, asset_id, family),
 UNIQUE (decision_id, rank),
 FOREIGN KEY (decision_id, universe_id) REFERENCES decision(id, universe_id) ON DELETE CASCADE,
 CHECK (rank IS NULL OR gate IS NULL)
);
CREATE INDEX decision_candidate_decision ON decision_candidate(decision_id) WHERE rank IS NOT NULL;
CREATE TRIGGER decision_candidate_no_update BEFORE UPDATE ON decision_candidate FOR EACH ROW EXECUTE FUNCTION decision_signal_immutable();

CREATE TABLE decision_context (
 decision_id uuid PRIMARY KEY,
 universe_id uuid NOT NULL,
 policy_version text NOT NULL REFERENCES composer_policy(version),
 seed text NOT NULL,
 -- The clock the policy composed against (terms such as decay and windows depend on it).
 composed_at timestamptz NOT NULL,
 served_window jsonb NOT NULL CHECK (jsonb_typeof(served_window) = 'array'),
 quotas jsonb NOT NULL CHECK (jsonb_typeof(quotas) = 'array'),
 exploration_due boolean NOT NULL,
 FOREIGN KEY (decision_id, universe_id) REFERENCES decision(id, universe_id) ON DELETE CASCADE
);
CREATE TRIGGER decision_context_no_update BEFORE UPDATE ON decision_context FOR EACH ROW EXECUTE FUNCTION decision_signal_immutable();

-- ADR-0029's coverage check applies to decision_signal policies only; v3 has its own, below.
CREATE OR REPLACE FUNCTION composer_signal_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; d_ranking_version text; d_candidates jsonb; kind text; candidate_ids uuid[]; signal_ids uuid[];
BEGIN
 IF TG_TABLE_NAME = 'decision' THEN target := COALESCE(NEW.id, OLD.id);
 ELSE target := COALESCE(NEW.decision_id, OLD.decision_id);
 END IF;
 SELECT d.ranking_version, d.candidates, p.record_kind INTO d_ranking_version, d_candidates, kind
  FROM decision d LEFT JOIN composer_policy p ON p.version = d.ranking_version WHERE d.id = target;
 IF NOT FOUND OR d_ranking_version IS NULL OR kind <> 'decision_signal' THEN RETURN NULL; END IF;
 SELECT COALESCE(array_agg((c->>'assetId')::uuid ORDER BY (c->>'assetId')::uuid), '{}'::uuid[])
  INTO candidate_ids FROM jsonb_array_elements(d_candidates) c;
 SELECT COALESCE(array_agg(asset_id ORDER BY asset_id), '{}'::uuid[])
  INTO signal_ids FROM decision_signal WHERE decision_id = target;
 IF candidate_ids IS DISTINCT FROM signal_ids THEN
  RAISE EXCEPTION 'A ranked decision must record exactly one signal row per candidate it returned';
 END IF;
 RETURN NULL;
END $$;

-- v3 invariants at commit: the selected (ranked) records are exactly the decision's returned
-- candidates, ranks are dense from 1, nothing gated is selected, the source cap holds, a context
-- row exists, and after the head the recorded scores never increase (the head may differ only
-- when the context records the quota that chose it).
CREATE FUNCTION composer_candidate_invariants() RETURNS trigger LANGUAGE plpgsql AS $$
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
 -- or the adjacent-repeat rule (which names no family).
 IF head_score IS NOT NULL AND head_score < best
    AND NOT (ctx.quotas ? ('exploration_floor:' || head_family) OR ctx.quotas ? 'no_adjacent_repeat') THEN
  RAISE EXCEPTION 'A v3 head that is not the best-scoring candidate must record the quota that chose it';
 END IF;
 RETURN NULL;
END $$;
-- Every invariant above reads ranked rows only, so an unranked (gated or unchosen) candidate can
-- neither break nor repair one: checking per ranked row keeps a library-sized record cheap.
CREATE CONSTRAINT TRIGGER decision_candidate_invariants AFTER INSERT ON decision_candidate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.rank IS NOT NULL) EXECUTE FUNCTION composer_candidate_invariants();
CREATE CONSTRAINT TRIGGER decision_candidate_delete_invariants AFTER DELETE ON decision_candidate
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (OLD.rank IS NOT NULL) EXECUTE FUNCTION composer_candidate_invariants();
-- A recorded decision stays consistent for its whole life: an edited decision row or a removed context
-- is checked like a new one (a decision deleted in the same transaction, as Clear does, is skipped).
CREATE CONSTRAINT TRIGGER decision_context_invariants AFTER INSERT OR DELETE ON decision_context
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION composer_candidate_invariants();
CREATE CONSTRAINT TRIGGER decision_v3_invariants AFTER INSERT OR UPDATE ON decision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION composer_candidate_invariants();
