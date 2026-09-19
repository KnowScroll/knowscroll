-- ADR-0023: shared generated-Reel supply. No universe scope; Clear History does not touch it.
-- Engines, editorial briefs, budget grants, one Cutroom attempt per job, stored events and
-- verified imported media. Nothing here is eligible, published or playable.

CREATE TABLE cutroom_engine (
 id uuid PRIMARY KEY,
 origin text NOT NULL CHECK (origin ~ '^http://(127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}$'),
 contract_revision text NOT NULL CHECK (contract_revision ~ '^[0-9a-f]{40}$'),
 artifact_root text NOT NULL CHECK (left(artifact_root,1)='/' AND length(artifact_root) BETWEEN 2 AND 1024),
 provider_mode text NOT NULL CHECK (provider_mode IN ('standin','live')),
 declared_by text NOT NULL CHECK (length(btrim(declared_by)) BETWEEN 1 AND 200),
 declared_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 retired_at timestamptz
);
CREATE UNIQUE INDEX cutroom_engine_one_active_origin ON cutroom_engine(origin) WHERE retired_at IS NULL;

CREATE TABLE generation_brief (
 id uuid PRIMARY KEY,
 source_asset_id uuid NOT NULL REFERENCES asset(id),
 source_asset_revision integer NOT NULL CHECK (source_asset_revision > 0),
 truth_state text NOT NULL CHECK (truth_state = 'synthesis'),
 brief jsonb NOT NULL CHECK (jsonb_typeof(brief) = 'object'),
 brief_sha256 text NOT NULL UNIQUE CHECK (brief_sha256 ~ '^[0-9a-f]{64}$'),
 authored_by text NOT NULL CHECK (length(btrim(authored_by)) BETWEEN 1 AND 200),
 review_state text NOT NULL CHECK (review_state IN ('draft','approved')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE generation_budget_grant (
 id uuid PRIMARY KEY,
 mode text NOT NULL CHECK (mode IN ('standin','live')),
 cap_cents integer NOT NULL CHECK (cap_cents > 0),
 reserved_cents integer NOT NULL DEFAULT 0 CHECK (reserved_cents >= 0),
 spent_cents integer NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
 authorization_ref text CHECK (authorization_ref IS NULL OR length(btrim(authorization_ref)) BETWEEN 1 AND 500),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (reserved_cents + spent_cents <= cap_cents),
 CHECK (mode = 'standin' OR authorization_ref IS NOT NULL)
);

CREATE TABLE generation_job (
 id uuid PRIMARY KEY,
 brief_id uuid NOT NULL REFERENCES generation_brief(id),
 engine_id uuid NOT NULL REFERENCES cutroom_engine(id),
 grant_id uuid NOT NULL REFERENCES generation_budget_grant(id),
 until text NOT NULL CHECK (until IN ('plan','stills','video')),
 budget_cents integer NOT NULL CHECK (budget_cents > 0),
 status text NOT NULL DEFAULT 'queued' CHECK (status IN
  ('queued','dispatching','following','importing','completed','refused','stopped','failed','cancelled','needs_operator')),
 status_detail text CHECK (status_detail IS NULL OR length(status_detail) <= 2000),
 cancel_requested_at timestamptz,
 lease_owner text,
 lease_expires_at timestamptz,
 fence bigint NOT NULL DEFAULT 0 CHECK (fence >= 0),
 deadline_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);
CREATE INDEX generation_job_runnable ON generation_job(created_at)
 WHERE status IN ('queued','dispatching','following','importing');

CREATE TABLE cutroom_attempt (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES generation_job(id),
 ordinal integer NOT NULL CHECK (ordinal = 1),
 request_id text NOT NULL UNIQUE CHECK (length(request_id) BETWEEN 1 AND 200),
 request_body text NOT NULL CHECK (octet_length(request_body) BETWEEN 2 AND 262144),
 body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
 contract_revision text NOT NULL CHECK (contract_revision ~ '^[0-9a-f]{40}$'),
 state text NOT NULL DEFAULT 'prepared' CHECK (state IN
  ('prepared','not_sent','dispatch_committed','accepted','refused','unknown','finished')),
 resend_count integer NOT NULL DEFAULT 0 CHECK (resend_count BETWEEN 0 AND 3),
 run_id text UNIQUE CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 1024),
 replayed boolean,
 refusal jsonb,
 last_status jsonb,
 next_since integer NOT NULL DEFAULT 0 CHECK (next_since >= 0),
 result jsonb,
 record_summary jsonb,
 reported_cost_cents integer CHECK (reported_cost_cents IS NULL OR reported_cost_cents >= 0),
 settlement text NOT NULL DEFAULT 'held' CHECK (settlement IN ('held','released','settled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 dispatch_committed_at timestamptz,
 accepted_at timestamptz,
 finished_at timestamptz,
 UNIQUE (job_id, ordinal),
 CHECK ((state IN ('accepted','finished')) = (run_id IS NOT NULL)),
 CHECK (state <> 'refused' OR refusal IS NOT NULL),
 CHECK (state <> 'finished' OR (result IS NOT NULL AND finished_at IS NOT NULL)),
 CHECK (state IN ('prepared','not_sent') OR dispatch_committed_at IS NOT NULL),
 CHECK (state NOT IN ('refused','not_sent') OR settlement = 'released'),
 CHECK (settlement <> 'settled' OR (state = 'finished' AND reported_cost_cents IS NOT NULL))
);

CREATE TABLE cutroom_event (
 attempt_id uuid NOT NULL REFERENCES cutroom_attempt(id),
 seq integer NOT NULL CHECK (seq > 0),
 event jsonb NOT NULL CHECK (jsonb_typeof(event) = 'object'),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (attempt_id, seq)
);

CREATE TABLE media_object (
 sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 536870912),
 content_type text NOT NULL CHECK (content_type = 'video/mp4'),
 probe jsonb NOT NULL CHECK (jsonb_typeof(probe) = 'object'),
 storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^sha256/[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}\.mp4$'),
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (storage_key = 'sha256/' || substr(sha256,1,2) || '/' || substr(sha256,3,2) || '/' || sha256 || '.mp4')
);

CREATE TABLE generated_reel (
 id uuid PRIMARY KEY,
 attempt_id uuid NOT NULL UNIQUE REFERENCES cutroom_attempt(id),
 brief_id uuid NOT NULL REFERENCES generation_brief(id),
 engine_id uuid NOT NULL REFERENCES cutroom_engine(id),
 cutroom_run_id text NOT NULL,
 media_sha256 text NOT NULL REFERENCES media_object(sha256),
 engine_path text NOT NULL CHECK (left(engine_path,1) = '/' AND length(engine_path) <= 4096),
 provider_mode text NOT NULL CHECK (provider_mode IN ('standin','live')),
 truth_state text NOT NULL CHECK (truth_state = 'synthesis'),
 generated_label boolean NOT NULL CHECK (generated_label),
 lineage jsonb NOT NULL CHECK (jsonb_typeof(lineage) = 'object'),
 availability text NOT NULL DEFAULT 'imported' CHECK (availability = 'imported'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Immutability. Engines may only be retired once; briefs may only move draft -> approved;
-- attempts keep their identity and bytes; events, media and generated Reels never change.
CREATE FUNCTION generation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END $$;
CREATE TRIGGER cutroom_event_immutable BEFORE UPDATE OR DELETE ON cutroom_event
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER media_object_immutable BEFORE UPDATE OR DELETE ON media_object
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();
CREATE TRIGGER generated_reel_immutable BEFORE UPDATE OR DELETE ON generated_reel
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();

CREATE FUNCTION cutroom_engine_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Cutroom engines are retired, never deleted'; END IF;
 IF OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
  OR (NEW.id, NEW.origin, NEW.contract_revision, NEW.artifact_root, NEW.provider_mode, NEW.declared_by, NEW.declared_at)
   IS DISTINCT FROM (OLD.id, OLD.origin, OLD.contract_revision, OLD.artifact_root, OLD.provider_mode, OLD.declared_by, OLD.declared_at)
 THEN RAISE EXCEPTION 'A Cutroom engine declaration can only be retired once'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cutroom_engine_guard BEFORE UPDATE OR DELETE ON cutroom_engine
 FOR EACH ROW EXECUTE FUNCTION cutroom_engine_guard();

CREATE FUNCTION generation_brief_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Generation briefs are never deleted'; END IF;
 IF NOT (OLD.review_state = 'draft' AND NEW.review_state = 'approved')
  OR (NEW.id, NEW.source_asset_id, NEW.source_asset_revision, NEW.truth_state, NEW.brief, NEW.brief_sha256, NEW.authored_by, NEW.created_at)
   IS DISTINCT FROM (OLD.id, OLD.source_asset_id, OLD.source_asset_revision, OLD.truth_state, OLD.brief, OLD.brief_sha256, OLD.authored_by, OLD.created_at)
 THEN RAISE EXCEPTION 'A generation brief can only move from draft to approved'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generation_brief_guard BEFORE UPDATE OR DELETE ON generation_brief
 FOR EACH ROW EXECUTE FUNCTION generation_brief_guard();

CREATE FUNCTION cutroom_attempt_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Cutroom attempts are never deleted'; END IF;
 IF (NEW.id, NEW.job_id, NEW.ordinal, NEW.request_id, NEW.request_body, NEW.body_sha256, NEW.contract_revision, NEW.created_at)
   IS DISTINCT FROM (OLD.id, OLD.job_id, OLD.ordinal, OLD.request_id, OLD.request_body, OLD.body_sha256, OLD.contract_revision, OLD.created_at)
  OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
  OR NEW.resend_count < OLD.resend_count
  OR NEW.next_since < OLD.next_since
  OR (OLD.dispatch_committed_at IS NOT NULL AND NEW.dispatch_committed_at IS DISTINCT FROM OLD.dispatch_committed_at)
  OR (OLD.settlement <> 'held' AND NEW.settlement IS DISTINCT FROM OLD.settlement)
  OR (NEW.state IS DISTINCT FROM OLD.state AND NOT (
       (OLD.state = 'prepared' AND NEW.state IN ('dispatch_committed','not_sent'))
    OR (OLD.state = 'dispatch_committed' AND NEW.state IN ('accepted','refused','unknown'))
    OR (OLD.state = 'unknown' AND NEW.state IN ('accepted','refused'))
    OR (OLD.state = 'accepted' AND NEW.state = 'finished')))
 THEN RAISE EXCEPTION 'Illegal Cutroom attempt transition'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cutroom_attempt_identity_guard BEFORE UPDATE OR DELETE ON cutroom_attempt
 FOR EACH ROW EXECUTE FUNCTION cutroom_attempt_identity_guard();

-- A generated Reel must come from a finished video attempt of its own job's brief and engine,
-- and carries the engine's declared provider mode.
CREATE FUNCTION generated_reel_lineage_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM cutroom_attempt a
  JOIN generation_job j ON j.id = a.job_id
  JOIN cutroom_engine e ON e.id = j.engine_id
  WHERE a.id = NEW.attempt_id AND a.state = 'finished' AND a.run_id = NEW.cutroom_run_id
   AND j.until = 'video' AND j.brief_id = NEW.brief_id AND j.engine_id = NEW.engine_id
   AND e.provider_mode = NEW.provider_mode
   AND a.result->>'status' = 'completed' AND a.result->'video'->>'path' = NEW.engine_path
 ) THEN RAISE EXCEPTION 'Generated Reel lineage does not match a finished video attempt'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generated_reel_lineage_guard BEFORE INSERT ON generated_reel
 FOR EACH ROW EXECUTE FUNCTION generated_reel_lineage_guard();

-- Live spend: owner cap of 200 cents across all live grants (2026-09-20); jobs only use an
-- engine and grant of the same mode.
CREATE FUNCTION generation_live_cap_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.mode = 'live' AND (SELECT coalesce(sum(cap_cents),0) FROM generation_budget_grant
   WHERE mode = 'live' AND id <> NEW.id) + NEW.cap_cents > 200
 THEN RAISE EXCEPTION 'Live generation grants may not exceed the owner cap of 200 cents in total'; END IF;
 IF TG_OP = 'UPDATE' AND (NEW.mode, NEW.cap_cents, NEW.authorization_ref, NEW.created_at)
   IS DISTINCT FROM (OLD.mode, OLD.cap_cents, OLD.authorization_ref, OLD.created_at)
 THEN RAISE EXCEPTION 'A grant''s mode, cap and authorization are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generation_live_cap_guard BEFORE INSERT OR UPDATE ON generation_budget_grant
 FOR EACH ROW EXECUTE FUNCTION generation_live_cap_guard();

CREATE FUNCTION generation_job_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (
  SELECT 1 FROM cutroom_engine e, generation_budget_grant g, generation_brief b
  WHERE e.id = NEW.engine_id AND g.id = NEW.grant_id AND b.id = NEW.brief_id
   AND e.provider_mode = g.mode AND b.review_state = 'approved' AND e.retired_at IS NULL
   AND g.expires_at > clock_timestamp()
 ) THEN RAISE EXCEPTION 'A generation job needs an approved brief, an active engine and an unexpired grant of the engine''s mode'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generation_job_admission_guard BEFORE INSERT ON generation_job
 FOR EACH ROW EXECUTE FUNCTION generation_job_admission_guard();

CREATE FUNCTION generation_job_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Generation jobs are never deleted'; END IF;
 IF (NEW.id, NEW.brief_id, NEW.engine_id, NEW.grant_id, NEW.until, NEW.budget_cents, NEW.deadline_at, NEW.created_at)
   IS DISTINCT FROM (OLD.id, OLD.brief_id, OLD.engine_id, OLD.grant_id, OLD.until, OLD.budget_cents, OLD.deadline_at, OLD.created_at)
  OR NEW.fence < OLD.fence
  OR (OLD.cancel_requested_at IS NOT NULL AND NEW.cancel_requested_at IS DISTINCT FROM OLD.cancel_requested_at)
  OR (OLD.status IN ('completed','refused','stopped','failed','cancelled') AND NEW.status IS DISTINCT FROM OLD.status)
 THEN RAISE EXCEPTION 'Illegal generation job update'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER generation_job_identity_guard BEFORE UPDATE OR DELETE ON generation_job
 FOR EACH ROW EXECUTE FUNCTION generation_job_identity_guard();

CREATE TRIGGER generation_budget_grant_no_delete BEFORE DELETE ON generation_budget_grant
 FOR EACH ROW EXECUTE FUNCTION generation_immutable();
