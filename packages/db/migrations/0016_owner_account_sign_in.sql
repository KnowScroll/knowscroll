-- ADR-0026: one owner account, email magic link. Sessions keep ADR-0009's shape, expiry,
-- revocation and privacy epoch; sign-in only creates one. Nothing here erases or reveals history.

CREATE TABLE account (
 id uuid PRIMARY KEY,
 /** Normalised (trimmed, lowercased) by the caller; the database only insists it looks like one
   * address and stays unique. No name, no profile, nothing else about a person. */
 email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' AND length(email) BETWEEN 6 AND 320),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 disabled_at timestamptz
);
/** v1 is single-user: exactly one account can exist. Widening this is a later migration and a
  * deliberate decision, not a configuration flag. */
CREATE UNIQUE INDEX account_single_user_v1 ON account ((true));

/** A universe belongs to the account that adopted it. The development universe is adopted on the
  * owner's first sign-in, so existing history becomes theirs rather than an orphan. */
ALTER TABLE universe ADD COLUMN account_id uuid REFERENCES account(id);

CREATE FUNCTION universe_account_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.account_id IS NOT NULL AND NEW.account_id IS DISTINCT FROM OLD.account_id THEN
  RAISE EXCEPTION 'A universe stays with the account that adopted it';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER universe_account_binding_guard BEFORE UPDATE ON universe
 FOR EACH ROW EXECUTE FUNCTION universe_account_binding_guard();

CREATE TABLE sign_in_token (
 id uuid PRIMARY KEY,
 account_id uuid NOT NULL REFERENCES account(id),
 /** SHA-256 of the 32 random bytes handed to the person, exactly as device sessions store theirs.
   * The secret itself is never stored, logged or recorded in any receipt. */
 token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
 purpose text NOT NULL CHECK (purpose = 'sign_in'),
 /** A coarse, salted fingerprint of the requester, for rate limiting only. Never an address. */
 requester_fingerprint text CHECK (requester_fingerprint IS NULL OR requester_fingerprint ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 consumed_at timestamptz,
 consumed_session_id uuid REFERENCES device_session(id),
 CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
 CHECK (consumed_at IS NULL OR consumed_at >= created_at),
 CHECK ((consumed_at IS NULL) = (consumed_session_id IS NULL))
);
CREATE INDEX sign_in_token_live ON sign_in_token(account_id, created_at) WHERE consumed_at IS NULL;
CREATE INDEX sign_in_token_requester ON sign_in_token(requester_fingerprint, created_at)
 WHERE requester_fingerprint IS NOT NULL AND consumed_at IS NULL;

/** A token is consumed once, never revived, and never re-pointed at another session or account. */
CREATE FUNCTION sign_in_token_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Sign-in tokens are expired or consumed, never deleted'; END IF;
 IF (NEW.id, NEW.account_id, NEW.token_hash, NEW.purpose, NEW.created_at, NEW.expires_at, NEW.requester_fingerprint)
  IS DISTINCT FROM
    (OLD.id, OLD.account_id, OLD.token_hash, OLD.purpose, OLD.created_at, OLD.expires_at, OLD.requester_fingerprint)
 THEN RAISE EXCEPTION 'A sign-in token''s identity and lifetime are immutable'; END IF;
 IF OLD.consumed_at IS NOT NULL THEN
  RAISE EXCEPTION 'A sign-in token is consumed exactly once';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sign_in_token_guard BEFORE UPDATE OR DELETE ON sign_in_token
 FOR EACH ROW EXECUTE FUNCTION sign_in_token_guard();

/** Where a session came from, so a signed-in session is distinguishable from the development
  * token's. Existing rows are development sessions, which is what they are. */
ALTER TABLE device_session ADD COLUMN origin text NOT NULL DEFAULT 'development'
 CHECK (origin IN ('development','magic_link'));
ALTER TABLE device_session ADD COLUMN account_id uuid REFERENCES account(id);
ALTER TABLE device_session ADD CONSTRAINT device_session_origin_account
 CHECK (origin = 'development' OR account_id IS NOT NULL);
