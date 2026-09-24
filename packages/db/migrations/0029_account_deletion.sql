-- ADR-0035 (#135): deleting the owner account. In one transaction: everything Reset erases, every
-- session, every sign-in token, the dated privacy receipts and the account row itself. What stays:
-- the empty universe (a later sign-in adopts it and starts clean), minimal content-free reasoning
-- accounting under its existing retention, and this tombstone. The tombstone keeps no address.
CREATE TABLE account_deletion_receipt (
 id uuid PRIMARY KEY,
 universe_id uuid NOT NULL REFERENCES universe(id),
 /** The deleted account's opaque id; deliberately not a foreign key, since that row is gone. */
 account_id uuid NOT NULL,
 request_id uuid NOT NULL,
 epoch_before integer NOT NULL CHECK (epoch_before >= 0),
 epoch_after integer NOT NULL CHECK (epoch_after = epoch_before + 1),
 sessions_deleted integer NOT NULL CHECK (sessions_deleted >= 1),
 deleted_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (universe_id, request_id)
);
CREATE FUNCTION account_deletion_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Account deletion receipts are immutable';
END $$;
CREATE TRIGGER account_deletion_receipt_immutable BEFORE UPDATE OR DELETE ON account_deletion_receipt
 FOR EACH ROW EXECUTE FUNCTION account_deletion_receipt_immutable();

-- True only inside the transaction that wrote the account's deletion receipt: `now()` is that
-- transaction's start, which is the receipt's `deleted_at`.
CREATE FUNCTION account_deletion_in_progress(target_universe uuid, target_account uuid) RETURNS boolean
 LANGUAGE sql STABLE AS $$
 SELECT EXISTS (SELECT 1 FROM account_deletion_receipt
  WHERE deleted_at = now()
   AND (target_universe IS NULL OR universe_id = target_universe)
   AND (target_account IS NULL OR account_id = target_account))
$$;

-- A universe stays with the account that adopted it, except while that account is being deleted.
CREATE OR REPLACE FUNCTION universe_account_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
  IF NEW.account_id IS NULL AND account_deletion_in_progress(NEW.id, OLD.account_id) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'A universe stays with the account that adopted it';
 END IF;
 RETURN NEW;
END $$;

-- Sign-in tokens are never deleted, except with their account.
CREATE OR REPLACE FUNCTION sign_in_token_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  IF account_deletion_in_progress(NULL, OLD.account_id) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'Sign-in tokens are expired or consumed, never deleted';
 END IF;
 IF (NEW.id, NEW.account_id, NEW.token_hash, NEW.purpose, NEW.created_at, NEW.expires_at, NEW.requester_fingerprint)
  IS DISTINCT FROM
    (OLD.id, OLD.account_id, OLD.token_hash, OLD.purpose, OLD.created_at, OLD.expires_at, OLD.requester_fingerprint)
 THEN RAISE EXCEPTION 'A sign-in token''s identity and lifetime are immutable'; END IF;
 IF OLD.consumed_at IS NOT NULL THEN
  RAISE EXCEPTION 'A sign-in token is consumed exactly once';
 END IF;
 RETURN NEW;
END $$;

-- Privacy receipts are immutable, and dated: they go with the account that made them.
CREATE OR REPLACE FUNCTION privacy_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' AND account_deletion_in_progress(OLD.universe_id, NULL) THEN RETURN OLD; END IF;
 RAISE EXCEPTION '% receipts are immutable', TG_TABLE_NAME;
END $$;
