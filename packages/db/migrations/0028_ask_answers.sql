-- ADR-0033 (#132): authorized Scroll Ask answers. A reader's explicit request turns one recorded
-- Ask into one admitted direct Job; the worker sends exactly the reserved bytes; the reply changes
-- state only through the ask-answer-v1 validator. Requests and answers are private history.

-- The deployment's answer route. `policy_version` names the fairness policy it is scheduled under
-- and the reasoning policy it resolves to (they must be the same label, as admission requires).
-- Nothing is enabled implicitly: an operator or a test installs and enables exactly one route.
CREATE TABLE ask_answer_route (
 policy_version reasoning_label PRIMARY KEY REFERENCES reasoning_fairness_policy(version),
 route_id reasoning_label NOT NULL,
 route_profile_version reasoning_label NOT NULL,
 transport text NOT NULL CHECK (transport IN ('fixture','minimax')),
 model text NOT NULL CHECK (model ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
 max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 16384),
 max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 4096),
 global_bucket_id uuid NOT NULL REFERENCES reasoning_bucket(id),
 provider_account_bucket_id uuid NOT NULL REFERENCES reasoning_bucket(id),
 route_quota_bucket_id uuid NOT NULL REFERENCES reasoning_bucket(id),
 remote_concurrency_bucket_id uuid NOT NULL REFERENCES reasoning_bucket(id),
 owner_capacity bigint NOT NULL CHECK (owner_capacity > 0),
 job_capacity bigint NOT NULL CHECK (job_capacity > 0),
 answer_ttl_seconds integer NOT NULL CHECK (answer_ttl_seconds BETWEEN 30 AND 3600),
 enabled boolean NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX ask_answer_route_one_enabled ON ask_answer_route((true)) WHERE enabled;

-- Each universe's owner budget for a route, created with its first answer request.
CREATE TABLE ask_answer_owner_bucket (
 policy_version reasoning_label NOT NULL REFERENCES ask_answer_route(policy_version),
 universe_id uuid NOT NULL REFERENCES universe(id),
 bucket_id uuid NOT NULL UNIQUE REFERENCES reasoning_bucket(id),
 PRIMARY KEY (policy_version, universe_id)
);

-- The fresh authority: one per Ask, from the Ask's original session. It names the execution graph
-- it created without a foreign key, because the answer outlives that graph's seven-day retirement.
CREATE TABLE ask_answer_request (
 id uuid PRIMARY KEY,
 ask_id uuid NOT NULL UNIQUE REFERENCES explicit_ask(id),
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 session_id uuid NOT NULL,
 client_request_id uuid NOT NULL,
 policy_version reasoning_label NOT NULL REFERENCES ask_answer_route(policy_version),
 job_id uuid NOT NULL UNIQUE,
 step_id uuid NOT NULL,
 context_id uuid NOT NULL,
 request_id uuid NOT NULL UNIQUE,
 -- Written once, in the creating transaction, after the sealed context exists (the bytes are
 -- derived from it and the policy resolver needs this row while it is compiled).
 request_hash text CHECK (request_hash ~ '^[0-9a-f]{64}$'),
 input_bytes integer CHECK (input_bytes BETWEEN 1 AND 16384),
 CHECK ((request_hash IS NULL) = (input_bytes IS NULL)),
 job_bucket_id uuid NOT NULL UNIQUE REFERENCES reasoning_bucket(id),
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (universe_id, client_request_id)
);
CREATE INDEX ask_answer_request_universe ON ask_answer_request(universe_id, requested_at);

-- The applied outcome. Provider text survives only as a validated answer and its basis quotes; a
-- rejected or failed attempt keeps its reasons and nothing the provider said.
CREATE TABLE ask_answer (
 ask_id uuid PRIMARY KEY REFERENCES ask_answer_request(ask_id),
 universe_id uuid NOT NULL REFERENCES universe(id),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 attempt_id uuid,
 status text NOT NULL CHECK (status IN ('answered','not_in_source','rejected','failed','cancelled')),
 answer text CHECK (answer IS NULL OR length(answer) BETWEEN 1 AND 1200),
 basis jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(basis) = 'array' AND jsonb_array_length(basis) <= 4),
 limits text CHECK (limits IS NULL OR length(limits) BETWEEN 1 AND 400),
 reasons jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(reasons) = 'array'),
 validator_version text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((status = 'answered') = (answer IS NOT NULL)),
 CHECK (status IN ('answered','not_in_source') OR (jsonb_array_length(basis) = 0 AND limits IS NULL)),
 CHECK (status NOT IN ('answered','not_in_source') OR (validator_version IS NOT NULL AND limits IS NOT NULL)),
 CHECK (status <> 'answered' OR jsonb_array_length(basis) >= 1),
 CHECK (status IN ('answered','not_in_source') OR jsonb_array_length(reasons) >= 1)
);

CREATE FUNCTION ask_answer_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END $$;
-- The only permitted update fills the request bytes' hash and size once; nothing else ever changes.
CREATE FUNCTION ask_answer_request_complete_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.request_hash IS NULL AND NEW.request_hash IS NOT NULL
    AND (NEW.id, NEW.ask_id, NEW.universe_id, NEW.privacy_epoch, NEW.session_id, NEW.client_request_id, NEW.policy_version, NEW.job_id,
         NEW.step_id, NEW.context_id, NEW.request_id, NEW.job_bucket_id, NEW.requested_at)
      IS NOT DISTINCT FROM
        (OLD.id, OLD.ask_id, OLD.universe_id, OLD.privacy_epoch, OLD.session_id, OLD.client_request_id, OLD.policy_version, OLD.job_id,
         OLD.step_id, OLD.context_id, OLD.request_id, OLD.job_bucket_id, OLD.requested_at) THEN
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'ask_answer_request rows are immutable once their request bytes are recorded';
END $$;
CREATE TRIGGER ask_answer_request_no_update BEFORE UPDATE ON ask_answer_request FOR EACH ROW EXECUTE FUNCTION ask_answer_request_complete_once();
CREATE TRIGGER ask_answer_no_update BEFORE UPDATE ON ask_answer FOR EACH ROW EXECUTE FUNCTION ask_answer_immutable();
CREATE TRIGGER ask_answer_route_no_rebind BEFORE UPDATE OF policy_version, route_id, route_profile_version, transport, model,
 max_input_tokens, max_output_tokens, global_bucket_id, provider_account_bucket_id, route_quota_bucket_id, remote_concurrency_bucket_id,
 owner_capacity, job_capacity ON ask_answer_route FOR EACH ROW EXECUTE FUNCTION ask_answer_immutable();

-- An answer belongs to the scope of the request it answers.
CREATE FUNCTION ask_answer_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM ask_answer_request r WHERE r.ask_id = NEW.ask_id AND r.universe_id = NEW.universe_id AND r.privacy_epoch = NEW.privacy_epoch) THEN
  RAISE EXCEPTION 'An answer must match its request''s universe and epoch';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ask_answer_scope_guard BEFORE INSERT ON ask_answer FOR EACH ROW EXECUTE FUNCTION ask_answer_scope_guard();
