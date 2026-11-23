-- #781 (owner decision 4 on #771) Pictures for a model-proposed recipe: a stored recipe carries a document v3 plan.
-- Owner: content. Authoritative. Shared content, not personal data: nothing here has a universe_id or an account column,
-- and nothing is in the erasure registry.
--
-- Until now SQL pinned every stored recipe to the plain v2 plan (migration 0111, `recipes_plan_check`): no picture, because
-- a picture was a person's decision, one recipe at a time. The owner decided (#771, decision 4) that a proposal may carry
-- pictures: it states the `shape` of the essay and one short intent per section, and the writer picks the picture kinds from
-- the closed set by what its passages hold (a statement picture is always available). A proposal is therefore a document v3
-- recipe from now on, and this migration gives it somewhere to say so.
-- 1. `content.recipes.scroll_v3`: the plan a proposal carries, an object with exactly two keys: `shape` (`argument`,
--    `mechanism` or `story`) and `sections` (two or three strings of 1 to 120 characters, one per section, in reading
--    order). No pictures and no misconception are stored: the writer picks the former, and a proposal never has the latter
--    (code supplies `misconception: none` when it reads the row). The check is written without a subquery (PostgreSQL
--    allows none in a check) and is a chain of `when` branches, so a malformed value is refused whatever its type and never read
--    as unknown (a check that evaluates to null passes).
-- 2. `scroll_v2` becomes nullable and keeps its default. `recipes_plan_check` is replaced: a row holds either the old plain v2
--    constant with `scroll_v3` null (what a process from before this change still writes, because the default fills the
--    column), or `scroll_v3` set and `scroll_v2` null. Never both and never neither.
-- Existing rows: all stay valid (a plain v2 row, `scroll_v3` null), so nothing is rewritten and the constraints are added
-- NOT VALID and validated in the same step, which scans `content.recipes` once (a few rows a day, at most the daily growth
-- cap) under the lock the statement already holds; no statement is near the 60 s timeout.
-- Query shapes: unchanged (one recipe by key; the recipes of a planet; the recipes of a proposing run). The column is read
-- with the rest of the row and is not indexed. Locking, growth and retention: those of `content.recipes` (0111).
-- Rollout: additive for a process from before this change: it inserts `scroll_v2` by default and never names `scroll_v3`, and
-- it reads only rows that hold a plain v2 plan. A row with a v3 plan (`scroll_v2` null) is written only by the new code,
-- and an older process that reads one would find no v2 plan: run the new code first, or none, never the older code against
-- a database that holds a v3 recipe.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table content.recipes add column scroll_v3 jsonb;

-- squawk-ignore ban-drop-not-null
alter table content.recipes alter column scroll_v2 drop not null;

alter table content.recipes
  add constraint recipes_scroll_v3_check
  check (
    scroll_v3 is null
    or coalesce(
      case
        when jsonb_typeof(scroll_v3) <> 'object' then false
        when not (scroll_v3 ?& array['shape', 'sections']) or scroll_v3 - 'shape' - 'sections' <> '{}'::jsonb then false
        when jsonb_typeof(scroll_v3 -> 'shape') <> 'string' or (scroll_v3 ->> 'shape') not in ('argument', 'mechanism', 'story') then false
        when jsonb_typeof(scroll_v3 -> 'sections') <> 'array' then false
        when jsonb_array_length(scroll_v3 -> 'sections') not between 2 and 3 then false
        else
          jsonb_typeof(scroll_v3 -> 'sections' -> 0) = 'string'
          and char_length(scroll_v3 -> 'sections' ->> 0) between 1 and 120
          and jsonb_typeof(scroll_v3 -> 'sections' -> 1) = 'string'
          and char_length(scroll_v3 -> 'sections' ->> 1) between 1 and 120
          and (
            jsonb_array_length(scroll_v3 -> 'sections') = 2
            or (
              jsonb_typeof(scroll_v3 -> 'sections' -> 2) = 'string'
              and char_length(scroll_v3 -> 'sections' ->> 2) between 1 and 120
            )
          )
      end,
      false
    )
  ) not valid;
-- Every existing row has `scroll_v3` null, which the check allows; the table is a few rows.
-- squawk-ignore constraint-missing-not-valid
alter table content.recipes validate constraint recipes_scroll_v3_check;

-- squawk-ignore ban-drop-constraint
alter table content.recipes drop constraint recipes_plan_check;
alter table content.recipes
  add constraint recipes_plan_check
  check (
    (scroll_v3 is null and scroll_v2 is not null and scroll_v2 = '{"variant": "plain", "misconception": {"kind": "none"}}'::jsonb)
    or (scroll_v3 is not null and scroll_v2 is null)
  ) not valid;
-- Every existing row holds the plain v2 constant with `scroll_v3` null, the first branch.
-- squawk-ignore constraint-missing-not-valid
alter table content.recipes validate constraint recipes_plan_check;

comment on column content.recipes.scroll_v3 is
  'The document v3 plan of a proposed recipe: {shape, sections}. The writer picks the pictures from what its passages hold. Null for a recipe that holds the plain v2 plan (#781).';
