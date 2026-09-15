CREATE TABLE universe (id uuid PRIMARY KEY, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0));
CREATE TABLE asset (
 id uuid PRIMARY KEY, revision integer NOT NULL CHECK (revision > 0), kind text NOT NULL CHECK (kind IN ('Reel','Scroll')),
 title text NOT NULL, summary text NOT NULL, body text NOT NULL, source_title text NOT NULL, source_url text NOT NULL,
 truth_state text NOT NULL CHECK (truth_state IN ('documented','synthesis','interpretation','disputed','modelled','counterfactual','fictional')),
 editorial_order integer NOT NULL UNIQUE
);
CREATE TABLE accounts (universe_id uuid PRIMARY KEY REFERENCES universe(id), revision integer NOT NULL DEFAULT 0, kept_asset_ids uuid[] NOT NULL DEFAULT '{}');
CREATE TABLE decision (id uuid PRIMARY KEY, universe_id uuid NOT NULL REFERENCES universe(id), account_revision integer NOT NULL, policy_version text NOT NULL, candidates jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ledger (
 seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, id uuid NOT NULL UNIQUE, universe_id uuid NOT NULL REFERENCES universe(id),
 kind text NOT NULL CHECK (kind IN ('exposure','keep')), client_key uuid NOT NULL, causation_id uuid REFERENCES ledger(id),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(universe_id,kind,client_key)
);
CREATE TABLE exposure (id uuid PRIMARY KEY, universe_id uuid NOT NULL REFERENCES universe(id), decision_id uuid NOT NULL REFERENCES decision(id),
 asset_id uuid NOT NULL REFERENCES asset(id), event_id uuid NOT NULL UNIQUE REFERENCES ledger(id), client_key uuid NOT NULL, UNIQUE(universe_id,client_key));
CREATE TABLE job (id uuid PRIMARY KEY, universe_id uuid NOT NULL REFERENCES universe(id), event_id uuid NOT NULL UNIQUE REFERENCES ledger(id),
 kind text NOT NULL CHECK(kind='project_keep'), status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, last_error text);
CREATE INDEX job_ready ON job(available_at) WHERE status='pending';
CREATE TABLE trace (universe_id uuid NOT NULL REFERENCES universe(id), asset_id uuid NOT NULL REFERENCES asset(id),
 event_id uuid NOT NULL REFERENCES ledger(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(universe_id,asset_id));
CREATE TABLE worker_heartbeat (worker_id text PRIMARY KEY, last_seen timestamptz NOT NULL);
