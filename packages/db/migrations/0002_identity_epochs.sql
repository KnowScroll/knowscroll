ALTER TABLE universe
 ADD COLUMN privacy_epoch integer NOT NULL DEFAULT 0 CHECK (privacy_epoch >= 0);

ALTER TABLE decision
 ADD COLUMN privacy_epoch integer NOT NULL DEFAULT 0 CHECK (privacy_epoch >= 0),
 ADD CONSTRAINT decision_id_universe_id_key UNIQUE (id, universe_id);

ALTER TABLE ledger
 ADD COLUMN privacy_epoch integer NOT NULL DEFAULT 0 CHECK (privacy_epoch >= 0),
 ADD CONSTRAINT ledger_id_universe_id_key UNIQUE (id, universe_id);

ALTER TABLE job
 ADD COLUMN privacy_epoch integer NOT NULL DEFAULT 0 CHECK (privacy_epoch >= 0),
 ADD COLUMN discarded_at timestamptz,
 DROP CONSTRAINT job_status_check,
 ADD CONSTRAINT job_status_check CHECK(status IN ('pending','completed','failed','discarded')),
 ADD CONSTRAINT job_terminal_timestamps_check CHECK (
   (status = 'completed' AND completed_at IS NOT NULL AND discarded_at IS NULL)
   OR (status = 'discarded' AND discarded_at IS NOT NULL AND completed_at IS NULL)
   OR (status IN ('pending','failed') AND completed_at IS NULL AND discarded_at IS NULL)
 );

CREATE TABLE device_session (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL,
 device_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 revoked_at timestamptz,
 FOREIGN KEY (universe_id) REFERENCES universe(id),
 CHECK (expires_at > created_at),
 CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

ALTER TABLE exposure DROP CONSTRAINT exposure_decision_id_fkey;
ALTER TABLE exposure DROP CONSTRAINT exposure_event_id_fkey;
ALTER TABLE ledger DROP CONSTRAINT ledger_causation_id_fkey;
ALTER TABLE job DROP CONSTRAINT job_event_id_fkey;
ALTER TABLE trace DROP CONSTRAINT trace_event_id_fkey;

ALTER TABLE exposure
 ADD CONSTRAINT exposure_decision_scope_fkey FOREIGN KEY (decision_id, universe_id) REFERENCES decision(id, universe_id),
 ADD CONSTRAINT exposure_event_scope_fkey FOREIGN KEY (event_id, universe_id) REFERENCES ledger(id, universe_id);

ALTER TABLE ledger
 ADD CONSTRAINT ledger_causation_scope_fkey FOREIGN KEY (causation_id, universe_id) REFERENCES ledger(id, universe_id);

ALTER TABLE job
 ADD CONSTRAINT job_event_scope_fkey FOREIGN KEY (event_id, universe_id) REFERENCES ledger(id, universe_id);

ALTER TABLE trace
 ADD CONSTRAINT trace_event_scope_fkey FOREIGN KEY (event_id, universe_id) REFERENCES ledger(id, universe_id);
