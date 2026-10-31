-- #483 Social: whether a person shares their read position with the other person of a direct
-- conversation, and how far they read while they did (SEEN, D-066 and D-150).
--
-- Owner: social. Authoritative.
-- The switch is a third setting on the row that already holds the audience and the availability
-- choice (0059), with its own revision, so the three commands never fence each other.
-- The shared position is a second number on each member row, beside `read_through_sequence` (0056).
-- `read_through_sequence` still moves for every reader, for their own unread dot. The shared position
-- moves only with it, and only while the reader's own switch is on, so it is never ahead of it. It is
-- the only position the other person can be told: what a person read while their switch was off is
-- never shown, not even after they turn it on.
-- Query shapes: unchanged. A direct conversation read looks up both people's member rows and settings
-- rows by their keys; the Account page reads the caller's own settings.
-- Locking: the settings are written under the owner's personal root, as the other settings are. The
-- shared position is written with the read position, under the friendship's lock, in the same
-- statement. A conversation read takes no lock on the other person's settings: it reads what is
-- committed, so a change shows from the other side's next read.
-- Growth: none. One more number on each existing member row; the settings columns sit on the existing
-- one row per person who ever changed a setting.
-- Retention: the settings are account-keyed and kept by Clear (a choice, not exploration history); the
-- member rows are kept by Clear too (conversations are explicit communication, D-042). Deleting the
-- account deletes both. The export names the switch in words.
-- Rollout: additive. A person with no settings row, and every existing row, shares by default (D-066:
-- on by default), so older writers that insert a row without the new columns keep the default. An older
-- writer that moves `read_through_sequence` without the shared position leaves SEEN where it was, which
-- shows less, never more. Existing direct conversations start with the shared position equal to the read
-- position: nobody could hide anything before this feature, so nothing was read while hidden.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table social.visibility_settings
  add column share_read_state boolean not null default true,
  add column read_state_revision bigint not null default 1
    check (read_state_revision between 1 and 9007199254740991);

alter table social.conversation_members
  add column shared_read_through_sequence bigint not null default 0
    check (shared_read_through_sequence between 0 and 9007199254740991);

-- Members are few and this runs once, inside the migration's transaction. Threads keep 0: a thread
-- never tells a member where another has read.
update social.conversation_members as member
  set shared_read_through_sequence = member.read_through_sequence
  from social.conversations as conversation
  where conversation.conversation_id = member.conversation_id
    and conversation.kind = 'direct';

alter table social.conversation_members
  add constraint conversation_members_shared_within_read
    check (shared_read_through_sequence <= read_through_sequence) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table social.conversation_members validate constraint conversation_members_shared_within_read;
