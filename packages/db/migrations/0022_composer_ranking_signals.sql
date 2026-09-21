-- ADR-0028: a real Composer contract. This migration adds nothing that ranks anything yet — the
-- bootstrap policy in packages/core/src/composer.ts is untouched and `decision.ranking_version`
-- stays NULL for every decision it makes. It gives a *future* real ranking implementation exactly
-- one way to record itself: a versioned, immutable policy; one signal row per candidate it
-- returned, holding only facts this schema already knows how to record; and an explanation that
-- can only be built from a registered template citing those same recorded facts. No consumer of
-- this schema is added or changed here.

-- 1. Versioned ranking policy. Weights are data, not code constants (packages/core/AGENTS.md:
-- "changing ranking requires policy versions"). Immutable once created, like publication_policy —
-- a policy version means the same weights forever, which is what makes a recorded ranking
-- reproducible later.
CREATE TABLE composer_policy (
 version text PRIMARY KEY CHECK (version ~ '^[a-z0-9.-]{1,64}$'),
 weights jsonb NOT NULL CHECK (jsonb_typeof(weights) = 'object' AND weights <> '{}'::jsonb),
 slate_size integer NOT NULL CHECK (slate_size >= 1),
 max_per_source integer NOT NULL CHECK (max_per_source >= 1 AND max_per_source <= slate_size),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER composer_policy_immutable BEFORE UPDATE OR DELETE ON composer_policy
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- 2. A decision may now name the composer_policy version that ranked it. NULL means "not ranked
-- by this contract" — every decision made before this migration, and every bootstrap-policy
-- decision made after it, is unaffected and stays NULL forever (nothing rewrites history).
ALTER TABLE decision ADD COLUMN ranking_version text REFERENCES composer_policy(version);

-- 3. The explanation vocabulary. A reason shown to a person is a registered template rendered
-- against the same recorded signal snapshot that produced the ranking — never bespoke per-item
-- prose. `composer_template_placeholders` extracts every `{{token}}` in a template; the check
-- below refuses a template that names a placeholder outside the fixed set of facts this schema
-- actually records, so a future template cannot be written to claim something never captured.
CREATE FUNCTION composer_template_placeholders(tmpl text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
 SELECT COALESCE(array_agg(DISTINCT m[1]), '{}'::text[])
 FROM regexp_matches(tmpl, '\{\{([a-zA-Z0-9_]+)\}\}', 'g') AS m
$$;

CREATE TABLE composer_explanation_template (
 explanation_key text PRIMARY KEY CHECK (explanation_key ~ '^[a-z_]{3,64}$'),
 -- Kept in sync by hand with decision_signal's required `inputs` keys plus the one optional
 -- passthrough (`sourceTitle`, copied verbatim from asset.source_title — never invented).
 template text NOT NULL CHECK (
  length(template) BETWEEN 1 AND 280
  AND composer_template_placeholders(template) <@ ARRAY[
   'exposureCount','lastExposedAt','unread','sourceKey','recencyDays','sourceRankInSlate','sourceTitle'
  ]
 ),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER composer_explanation_template_immutable BEFORE UPDATE OR DELETE ON composer_explanation_template
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

-- 4. One signal row per candidate a ranked decision returned. `inputs` is the exact recorded
-- snapshot the score, the rank and the rendered explanation were computed from — exposure count
-- and recency come from the `exposure` table, `unread` is their absence, `sourceKey` and
-- `sourceRankInSlate` come from the candidate's own asset row and its position among same-source
-- picks in this slate. Nothing here may name a belief or an inferred interest (AGENTS.md: behavior
-- is evidence, not proof of belief); it is what was recorded and what followed.
CREATE TABLE decision_signal (
 id uuid PRIMARY KEY,
 decision_id uuid NOT NULL,
 universe_id uuid NOT NULL,
 asset_id uuid NOT NULL REFERENCES asset(id),
 rank integer NOT NULL CHECK (rank >= 1),
 -- PostgreSQL defines NaN as equal to itself, so a plain self-equality check would not catch it;
 -- reject non-finite scores explicitly so "higher score" stays a total, comparable order.
 retrieval_score double precision NOT NULL CHECK (retrieval_score > '-Infinity'::float8 AND retrieval_score < 'Infinity'::float8),
 inputs jsonb NOT NULL CHECK (
  jsonb_typeof(inputs) = 'object'
  AND inputs ?& ARRAY['exposureCount','lastExposedAt','unread','sourceKey','recencyDays','sourceRankInSlate']
  AND jsonb_typeof(inputs->'exposureCount') = 'number' AND (inputs->>'exposureCount')::numeric >= 0
  AND jsonb_typeof(inputs->'unread') = 'boolean'
  AND jsonb_typeof(inputs->'sourceKey') = 'string' AND length(inputs->>'sourceKey') BETWEEN 1 AND 512
  AND jsonb_typeof(inputs->'sourceRankInSlate') = 'number' AND (inputs->>'sourceRankInSlate')::numeric >= 0
  AND (inputs->'lastExposedAt' = 'null'::jsonb OR jsonb_typeof(inputs->'lastExposedAt') = 'string')
  AND (inputs->'recencyDays' = 'null'::jsonb OR (jsonb_typeof(inputs->'recencyDays') = 'number' AND (inputs->>'recencyDays')::numeric >= 0))
  -- Honesty, structurally: a row cannot claim "unread" while also recording when it was last
  -- exposed, and cannot claim a prior exposure while recording no recency. The database refuses
  -- the self-contradiction rather than trusting the caller to keep the two fields in step.
  AND (inputs->>'unread')::boolean = (inputs->'lastExposedAt' = 'null'::jsonb)
  AND (inputs->>'unread')::boolean = (inputs->'recencyDays' = 'null'::jsonb)
 ),
 explanation_key text NOT NULL REFERENCES composer_explanation_template(explanation_key),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (decision_id, asset_id),
 UNIQUE (decision_id, rank),
 FOREIGN KEY (decision_id, universe_id) REFERENCES decision(id, universe_id) ON DELETE CASCADE
);
CREATE INDEX decision_signal_asset ON decision_signal(asset_id, created_at);

-- Content is immutable (a corrected ranking is a new decision, not an edit to one already shown).
-- Deletion is not blocked: it happens only as a side effect of ADR-0010 Clear Scroll History
-- hard-deleting the parent `decision` row (privacy.ts already does this; the cascade above means
-- no privacy-erasure code has to know decision_signal exists for erasure to stay correct).
CREATE FUNCTION decision_signal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'decision_signal rows are immutable; a corrected ranking is a new decision';
END $$;
CREATE TRIGGER decision_signal_no_update BEFORE UPDATE ON decision_signal
 FOR EACH ROW EXECUTE FUNCTION decision_signal_immutable();

-- 5. Three invariants the database checks at commit (DEFERRED, so within one transaction a caller
-- may insert the decision and its signal rows in either order, but never leave a ranked decision
-- inconsistent with its own recorded evidence).

-- 5a. Recorded rank cannot contradict recorded score: a candidate ranked ahead of another must
-- not have recorded a strictly lower retrieval_score. This is what makes "the same ordering can be
-- reproduced and argued with" a checkable claim rather than a promise.
CREATE FUNCTION composer_rank_score_consistent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid; contradictions integer;
BEGIN
 affected := COALESCE(NEW.decision_id, OLD.decision_id);
 SELECT count(*) INTO contradictions
 FROM decision_signal a JOIN decision_signal b ON a.decision_id = b.decision_id
  AND a.rank < b.rank AND a.retrieval_score < b.retrieval_score
 WHERE a.decision_id = affected;
 IF contradictions > 0 THEN
  RAISE EXCEPTION 'A decision''s recorded rank order must not contradict its recorded retrieval score';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER decision_signal_rank_score_consistent
 AFTER INSERT OR UPDATE OR DELETE ON decision_signal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION composer_rank_score_consistent();

-- 5b. Diversity: no source may exceed the ranking policy's own max_per_source within one slate.
-- If the decision names no composer_policy (bootstrap decisions, ranking_version NULL) there is
-- nothing to check — this contract adds no constraint to the policy it does not touch.
CREATE FUNCTION composer_diversity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid; cap integer; worst integer;
BEGIN
 affected := COALESCE(NEW.decision_id, OLD.decision_id);
 SELECT p.max_per_source INTO cap FROM decision d JOIN composer_policy p ON p.version = d.ranking_version
 WHERE d.id = affected;
 IF cap IS NULL THEN RETURN NULL; END IF;
 SELECT max(cnt) INTO worst FROM (
  SELECT count(*) AS cnt FROM decision_signal WHERE decision_id = affected GROUP BY inputs->>'sourceKey'
 ) per_source;
 IF worst > cap THEN
  RAISE EXCEPTION 'A decision may not let one source exceed its ranking policy''s per-source cap';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER decision_signal_diversity_guard
 AFTER INSERT OR UPDATE OR DELETE ON decision_signal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION composer_diversity_guard();

-- 5c. Coverage: a decision that names a composer_policy must record exactly one signal row per
-- candidate it returned — the same set of asset ids, no more, no fewer. No ranked item may be
-- shown without a recorded reason, and no orphaned signal may outlive the candidate it explained.
CREATE FUNCTION composer_signal_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; d_ranking_version text; d_candidates jsonb; candidate_ids uuid[]; signal_ids uuid[];
BEGIN
 IF TG_TABLE_NAME = 'decision' THEN target := COALESCE(NEW.id, OLD.id);
 ELSE target := COALESCE(NEW.decision_id, OLD.decision_id);
 END IF;
 SELECT ranking_version, candidates INTO d_ranking_version, d_candidates FROM decision WHERE id = target;
 IF NOT FOUND OR d_ranking_version IS NULL THEN RETURN NULL; END IF;
 SELECT COALESCE(array_agg((c->>'assetId')::uuid ORDER BY (c->>'assetId')::uuid), '{}'::uuid[])
  INTO candidate_ids FROM jsonb_array_elements(d_candidates) c;
 SELECT COALESCE(array_agg(asset_id ORDER BY asset_id), '{}'::uuid[])
  INTO signal_ids FROM decision_signal WHERE decision_id = target;
 IF candidate_ids IS DISTINCT FROM signal_ids THEN
  RAISE EXCEPTION 'A ranked decision must record exactly one signal row per candidate it returned';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER decision_signal_coverage_from_signal
 AFTER INSERT OR UPDATE OR DELETE ON decision_signal
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION composer_signal_coverage();
CREATE CONSTRAINT TRIGGER decision_coverage_from_decision
 AFTER INSERT OR UPDATE ON decision
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION composer_signal_coverage();
