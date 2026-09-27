-- ADR-0040 (#160): what a universe's last personal-model refresh had seen of the correction log, so
-- the worker can refresh the places of a reader who is away once a source correction lands.
-- `semantic_correction` is append-only, so its row count only grows: a refresh records the count it
-- read at its start (never a time: a correction's time is taken before it commits). Part of the
-- personal model: Clear, Reset and account deletion erase it (erasePersonalModel); export leaves it out.
CREATE TABLE correction_catch_up (
 universe_id uuid PRIMARY KEY REFERENCES universe(id),
 corrections_seen integer NOT NULL CHECK (corrections_seen >= 0),
 refreshed_at timestamptz NOT NULL
);
