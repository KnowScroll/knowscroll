-- #631 (v3 R-11) Flair and the sky's star moments (D-341 to D-347): a member's own choice of which flair shows beside their name in a
-- room. Nothing else is stored: flair is worked out when read, from rows that already exist and that the erasure paths already take
-- (a person's words in Today and in other people's questions, the Useful marks on the questions they left, their right taps on Spot
-- the flaw, their answers in a finished Launch).
--
-- Owner: rooms. Authoritative. One nullable column on the member's own row, as `ai_level` and `keep_out` are: a setting, no reading.
-- `flair_choice`: null shows the first flair the person has earned, `none` shows nothing (hidden), any other value shows that flair
-- when it is earned and nothing when it is not.
-- Query shapes: unchanged (the column rides on the member row every read already takes); flair itself is four bounded counts per
-- author of a page, each by an index that exists (messages by author, the room's question topics, a person's taps and answers).
-- Locking: unchanged from 0062. Choosing takes the room root FOR SHARE, as the member's other settings do.
-- Access: the member reads and writes their own value. Another member reads only the flair the value lets show, never the value.
-- Growth: none (a column on a row that exists).
-- Retention and erasure: leaving or removal keeps the value, as it keeps the AI level and the keep-out choice, so hiding is never
-- undone by leaving; a person who has left shows no flair to anyone. A Clear keeps it (a setting, not a reading). Deleting the
-- account deletes the member row and so the value. The export lists it with the person's other settings in the room.
-- Rollout: additive and nullable. An older process neither reads nor writes the column; it shows no flair, which is the default of
-- a build that has none.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table rooms.members
  add column flair_choice text,
  add constraint members_flair_choice_check
    check (flair_choice in ('none', 'first_answer', 'good_question', 'flaw_finder', 'launch_regular')) not valid;
-- The new column is null for every existing row, so the check holds.
-- squawk-ignore constraint-missing-not-valid
alter table rooms.members validate constraint members_flair_choice_check;
