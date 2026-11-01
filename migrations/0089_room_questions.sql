-- #493 (v3 R-7) The quiet room (D-241 to D-243): a question a member leaves for people, and the notice they get when a person
-- answers it. The replay of a finished Launch stores nothing and adds no table: it reads the answers 0088 already keeps for seven days.
--
-- Owner: rooms. Authoritative. A question is a topic tagged `question` (0076), started by the person who left it. Whether it is
-- still open is not stored: it is read from the messages (no person but the starter has spoken, D-168), so an answer that is
-- removed or whose author deletes their account reopens it without a write.
-- What is new is the asker's own notice state, on the discussion row because it exists only for the starter of a question:
-- `notify_answer` (they asked to be told, on by default when they leave a question) and `answer_noticed_at` (when they opened the
-- answer or dismissed the notice). The notice itself is read, never stored: the first shown message of a person other than the
-- asker whom the asker has not blocked.
-- Query shapes: a room's open questions (count, and the list through the existing topic read); a member's own questions that have a
-- person's answer they have not noticed.
-- Locking: unchanged from 0062. Leaving a question takes the room root FOR UPDATE (the ask bounds are counts), then the new
-- discussion's rows, as a topic from a message does.
-- Retention and erasure: the two columns hold no words and no person: they are the starter's, so the starter's account deletion
-- (which empties `started_by_account_id`) leaves them meaning nothing. Leaving a room and a Clear keep a question, as they keep any
-- conversation (D-042).
-- Rollout: additive. An older process neither reads nor writes the columns; a question left by this build is an ordinary
-- question topic to it.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table rooms.discussions
  add column notify_answer boolean not null default false,
  add column answer_noticed_at timestamptz,
  add constraint discussions_question_notice_check
    check (tag = 'question' or (not notify_answer and answer_noticed_at is null)) not valid;
-- The new columns are false and null for every existing row, so the check holds.
-- squawk-ignore constraint-missing-not-valid
alter table rooms.discussions validate constraint discussions_question_notice_check;

-- A room's questions: the count a room shows ("3 questions waiting") and the shelf read them by room.
-- A room has a handful of discussions at rollout; the transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create index discussions_room_questions on rooms.discussions(room_id, last_activity_at desc) where tag = 'question';
