-- #480 (v3 S-9) Challenge a friend (D-245): a card sent into a direct conversation that asks the friend to call a
-- Scroll's question, with each person's own pick hidden until the friend has called too.
--
-- Owner: social. The one change is a nullable column on `social.messages`: a content message with `challenge_stop`
-- set is a challenge, and the value names the stop (a Call it or the Final call) of the exact Scroll revision the card
-- is for. Nothing else is stored for a challenge: the question and the options are read from that immutable revision,
-- the right answer is never stored, and each person's pick is a row of `social.thread_calls` (0083), keyed by this
-- direct conversation, the revision and the stop. That table's key is a conversation and its member, so it serves a
-- direct conversation as well as a thread, and every rule that removes a pick (Clear, account deletion, export, the wall
-- around it) already covers it. One challenge per call per conversation: the picks are keyed that way.
-- Query shapes: the messages of a conversation are read by (conversation, sequence) as before and now carry the column;
-- a page's challenges read the two people's picks by (conversation, asset, revision, stop).
-- Locking: unchanged. The challenge is sent under the friendship's pair row like any message; a pick is locked under the
-- same row, after the actor's personal root and account gate.
-- Constraints: only a content message may be a challenge (an asset and no text). Account erasure turns a message into a
-- tombstone and clears the column with the asset (the same statement), so the check cannot stop an erasure.
-- Growth: none beyond the messages themselves. Retention: with the message; the picks follow the rules of 0083.
-- Rollout: additive. The new column is nullable, so older writers keep working and read nothing different.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table social.messages add column challenge_stop text;
alter table social.messages
  add constraint messages_challenge_stop_shape check (
    challenge_stop is null
    or (challenge_stop ~ '^[a-z][a-z0-9-]{1,39}$' and asset_id is not null and body_text is null)
  ) not valid;
-- Every existing row has a null column, so validating takes no real time (the squawk-ignore comment says so, as in 0075).
-- squawk-ignore constraint-missing-not-valid
alter table social.messages validate constraint messages_challenge_stop_shape;
