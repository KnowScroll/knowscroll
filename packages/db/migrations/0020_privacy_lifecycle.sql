-- ADR-0030: privacy lifecycle contract (pause, export, reset), extending ADR-0009's epoch fence
-- and ADR-0010's Clear boundary. Schema only; no HTTP route or TypeScript caller is added here.

-- Pause -----------------------------------------------------------------------------------
-- A universe-wide, server-authoritative toggle. NULL means recording is active (the default,
-- so every existing and newly bootstrapped universe is unaffected until someone pauses it).
ALTER TABLE universe ADD COLUMN recording_paused_at timestamptz;

-- The database itself refuses new exposure/keep/ask facts while paused: this is not merely a
-- promise kept by application code. Reads, browsing, decisions (the served candidate feed) and
-- processing of history recorded before the pause are untouched -- only new Ledger rows for this
-- universe are blocked. A paused universe's already-queued reasoning/jobs still run to their
-- existing completion; nothing here withdraws or discards prior work.
CREATE FUNCTION privacy_pause_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM universe WHERE id=NEW.universe_id AND recording_paused_at IS NOT NULL) THEN
  RAISE EXCEPTION 'Recording is paused for this universe';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER ledger_pause_guard BEFORE INSERT ON ledger
 FOR EACH ROW EXECUTE FUNCTION privacy_pause_guard();

-- One receipt per confirmed pause/resume attempt, keyed for exact retry the same way Clear's
-- receipt is. `privacy_epoch` is recorded for audit only -- pausing and resuming never advance it,
-- because nothing is erased or invalidated and no client cache needs purging.
CREATE TABLE privacy_recording_receipt (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 request_id uuid NOT NULL,
 action text NOT NULL CHECK (action IN ('pause','resume')),
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 applied_at timestamptz NOT NULL,
 -- The action belongs in the replay key. Keyed on the request id alone, a client that reused an
 -- id it had already spent on `resume` would get that resume's receipt handed back for a `pause`:
 -- HTTP 200, a body saying resumed, and recording never actually stopping. A privacy control that
 -- silently does nothing while reporting success is the worst failure this table can have.
 UNIQUE (universe_id, request_id, action)
);

-- A receipt can only ever describe the transition that actually happened: the caller must set
-- universe.recording_paused_at (or clear it) in the SAME transaction, before inserting the
-- receipt row. This makes "the receipt says paused" and "the universe is paused" the same fact,
-- enforced by the schema rather than trusted from application code.
CREATE FUNCTION privacy_recording_receipt_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.action='pause' AND NOT EXISTS(
  SELECT 1 FROM universe WHERE id=NEW.universe_id AND recording_paused_at IS NOT NULL
 ) THEN RAISE EXCEPTION 'A pause receipt requires the universe to already be marked paused'; END IF;
 IF NEW.action='resume' AND EXISTS(
  SELECT 1 FROM universe WHERE id=NEW.universe_id AND recording_paused_at IS NOT NULL
 ) THEN RAISE EXCEPTION 'A resume receipt requires the universe to already be marked active'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_recording_receipt_guard BEFORE INSERT ON privacy_recording_receipt
 FOR EACH ROW EXECUTE FUNCTION privacy_recording_receipt_guard();
CREATE FUNCTION privacy_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION '% receipts are immutable', TG_TABLE_NAME;
END $$;
CREATE TRIGGER privacy_recording_receipt_no_update BEFORE UPDATE OR DELETE ON privacy_recording_receipt
 FOR EACH ROW EXECUTE FUNCTION privacy_receipt_immutable();

-- Export ------------------------------------------------------------------------------------
-- Export is non-destructive and reads current rows live; the receipt is a manifest (a row-count
-- audit that an export happened), never a stored second copy of the exported content. Storing the
-- content itself here would recreate exactly the "retained audit copy defeats erasure" problem
-- ADR-0010 already rejected for Clear -- a copy sitting in this receipt would need its own erasure
-- rule under Reset, and would let an export outlive the data it was drawn from.
CREATE TABLE privacy_export_receipt (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 request_id uuid NOT NULL,
 privacy_epoch integer NOT NULL CHECK (privacy_epoch >= 0),
 exported_at timestamptz NOT NULL,
 row_counts jsonb NOT NULL CHECK (jsonb_typeof(row_counts) = 'object'),
 UNIQUE (universe_id, request_id)
);
CREATE TRIGGER privacy_export_receipt_no_update BEFORE UPDATE OR DELETE ON privacy_export_receipt
 FOR EACH ROW EXECUTE FUNCTION privacy_receipt_immutable();

-- Reset -------------------------------------------------------------------------------------
-- Same shape as history_clear_receipt (0003), plus how many device sessions Reset ended -- always
-- at least the caller's own, which is the one concrete difference from Clear (Clear rolls the
-- calling session forward so it keeps working; Reset does not keep any session alive).
CREATE TABLE privacy_reset_receipt (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 request_id uuid NOT NULL,
 epoch_before integer NOT NULL CHECK (epoch_before >= 0),
 epoch_after integer NOT NULL CHECK (epoch_after >= 0 AND epoch_after = epoch_before + 1),
 sessions_revoked integer NOT NULL CHECK (sessions_revoked >= 1),
 reset_at timestamptz NOT NULL,
 UNIQUE (universe_id, request_id)
);
CREATE TRIGGER privacy_reset_receipt_no_update BEFORE UPDATE OR DELETE ON privacy_reset_receipt
 FOR EACH ROW EXECUTE FUNCTION privacy_receipt_immutable();
