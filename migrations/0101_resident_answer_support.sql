-- #620 (v3) A resident's answer passes the support check before it is posted (D-298).
--
-- Owner: rooms (`rooms.ai_turns`).
-- Before: a resident's answer rested on nothing but the model, and the turn's row said who asked, which cap decided it and
-- which attempt wrote it, but not what the words rested on.
-- After: a turn carries `answer_support`, how its answer came out: the passages of the library it cited (asset, revision and
-- stop IDs, never a word), whether the first draft cleared or the one rewrite did, or that the library did not cover the
-- question. It is written when the turn is settled, or when a checked answer is held back for someone typing.
--
-- Query shapes: the column is read with its row, by turn ID, and never searched. No index.
-- Constraints: the value is a JSON object of at most 1,024 bytes, or null (every turn before this, and every turn that made no
-- answer). The shape inside it is code's: it is written by one function and read through a schema.
-- Access: the room's lock, as the rest of the row. It names public content only, no person and no message.
-- Growth, retention, erasure: one small value on a row that already exists; kept with the turn, which a Clear and a deletion
-- keep (D-042), and it holds nothing a person wrote.
-- Rollout: additive. An older process never writes it and never reads it.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table rooms.ai_turns
  add column answer_support jsonb
    check (answer_support is null or (jsonb_typeof(answer_support) = 'object' and octet_length(answer_support::text) <= 1024));
