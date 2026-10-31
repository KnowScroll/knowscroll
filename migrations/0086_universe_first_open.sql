-- #470 (v3 U-6) The first-open animation plays once in the lifetime of an account (D-114).
--
-- Owner: identity. Authoritative.
-- `universe_first_opened_at` is set by the first request that claims it, in one conditional update, so two devices
-- opening the Universe tab at the same moment cannot both win. It is set when the animation starts, never when it
-- ends, so a crash or a closed app does not play it again. Skip and finishing both leave it as it is.
-- It is a property of the account, not of the personal universe: Clear keeps it (the person has still seen the
-- opening), and a new device or a reinstall reads the same answer.
-- Query shape: one conditional update by account id (primary key).
-- Locking: the row lock of that update only; no personal root is taken, because nothing personal is written.
-- Growth: one nullable column on the account row.
-- Retention: deleted with the account row. It names no person other than its own row and no content.
-- Export: the data export says whether the opening was shown, in words, never the time.
-- Rollout: additive and nullable. An older process neither reads nor writes it.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table identity.accounts add column universe_first_opened_at timestamptz;
