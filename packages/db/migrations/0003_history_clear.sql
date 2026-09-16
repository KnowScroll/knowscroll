CREATE TABLE history_clear_receipt (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 request_id uuid NOT NULL,
 epoch_before integer NOT NULL CHECK (epoch_before >= 0),
 epoch_after integer NOT NULL CHECK (epoch_after >= 0 AND epoch_after = epoch_before + 1),
 cleared_at timestamptz NOT NULL,
 UNIQUE (universe_id, request_id)
);
