-- #483 Social: whether a person shares their read position with the other person of a direct
-- conversation (SEEN, D-066 and D-150).
--
-- Owner: social. Authoritative. It is a third setting on the row that already holds the audience and
-- the availability choice (0059), with its own revision, so the three commands never fence each other.
-- No new tracking is written: the read position itself (`conversation_members.read_through_sequence`,
-- 0056) already moves for every reader, and this setting only decides whether the other person is told.
-- Query shapes: unchanged. A direct conversation read looks up both people's row by account id (the
-- primary key); the Account page reads the caller's own.
-- Locking: written under the owner's personal root, as the other settings are. A conversation read
-- takes no lock on the other person's row: it reads what is committed, so a change shows from the
-- other side's next read.
-- Growth: none. The columns sit on the existing one row per person who ever changed a setting.
-- Retention: account-keyed and kept by Clear (it is a choice, not exploration history); deleting the
-- account deletes the row (D-047). The export names it in words.
-- Rollout: additive. A person with no row, and every existing row, shares by default (D-066: on by
-- default), so older writers that insert a row without the new columns keep the default.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table social.visibility_settings
  add column share_read_state boolean not null default true,
  add column read_state_revision bigint not null default 1
    check (read_state_revision between 1 and 9007199254740991);
