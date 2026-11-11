-- #674 (2.2) Recipes in Postgres (D-412): the explanation recipes a Scroll is written from can live in the database, and the
-- system can propose new ones for the planets and facets that already exist.
--
-- Owner: content. Authoritative. Shared content, not personal data: nothing here has a universe_id or an account column,
-- and nothing is in the erasure registry. The model's draft is never stored: only the recipe code accepted, with the
-- numbers and codes the draft checks found.
-- 1. `content.recipes`: one row per stored recipe. The key is the production job's recipe key (the shape migration 0045
--    checks, at most 64 characters). A recipe `proposal` carries the reserved prefix `gen-`, which is how code tells a stored
--    recipe from the library plan's without a lookup; a code recipe never starts with it. The asset id and the explanation
--    unit id are derived by code from the key, never chosen. `scroll_v2` is what the v2 writer is told: this slice stores
--    plain, explanation-first recipes only (D-397), so SQL pins the plan; a later slice that adds more widens the check.
--    `status`: checked (accepted, nothing sent), queued (a production job exists), produced (a Scroll was stored, held or
--    served), retired (never chosen again). `origin`: `code` is for the library plan's own recipes (a later import), `proposal`
--    for a model's draft that code accepted; a proposal names the run that proposed it.
--    Query shapes: one recipe by key (the primary key); the recipes of a planet that may still be chosen (partial index);
--    the recipes one proposing run made (partial index, the redelivery check); the recipe whose Scroll is an asset (unique).
--    Locking: a row is inserted once and afterwards only its status moves, in the production transaction that creates or
--    finishes the job; no lock order beyond the row. Growth: at most the daily growth cap of rows a day; kept for ever, since
--    a retired recipe's Scroll still belongs to its planet. Retention: none.
-- Rollout: additive. An older process never reads or writes the table and never meets a `gen-` key, because only
-- the new code stores a recipe or sends a job for one.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table content.recipes (
  key text not null,
  origin text not null,
  status text not null,
  title text not null,
  topic_id text not null,
  facet_id text not null,
  supporting_facet_id text,
  asset_id uuid not null,
  explanation_unit_id text not null,
  brief text not null,
  pages text[] not null,
  scroll_v2 jsonb not null default '{"variant": "plain", "misconception": {"kind": "none"}}'::jsonb,
  proposing_run_id uuid,
  check_results jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint recipes_pkey primary key (key),
  constraint recipes_asset_id_key unique (asset_id),
  constraint recipes_explanation_unit_id_key unique (explanation_unit_id),
  constraint recipes_key_check check (key ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$' and char_length(key) <= 64),
  constraint recipes_origin_check check (origin in ('code', 'proposal')),
  constraint recipes_status_check check (status in ('checked', 'queued', 'produced', 'retired')),
  -- A proposal has the reserved prefix and names the run that made it.
  constraint recipes_proposal_check check (origin <> 'proposal' or (key like 'gen-%' and proposing_run_id is not null)),
  constraint recipes_title_check check (char_length(title) between 8 and 90),
  constraint recipes_topic_check check (char_length(topic_id) between 1 and 160 and char_length(facet_id) between 1 and 160),
  constraint recipes_supporting_facet_check check (supporting_facet_id is null or char_length(supporting_facet_id) between 1 and 160),
  constraint recipes_unit_check check (char_length(explanation_unit_id) between 1 and 160),
  constraint recipes_brief_check check (char_length(brief) between 80 and 800),
  constraint recipes_pages_check check (cardinality(pages) between 1 and 3),
  -- Explanation first (D-397): a plain Scroll with no misconception. Widened by the slice that adds more.
  constraint recipes_plan_check
    check (scroll_v2 = '{"variant": "plain", "misconception": {"kind": "none"}}'::jsonb),
  constraint recipes_check_results_check check (jsonb_typeof(check_results) = 'object' and octet_length(check_results::text) <= 2048)
);

comment on table content.recipes is
  'Explanation recipes stored in the database: what Scroll to write for a planet and facet that exist. Shared, nonpersonal. A proposal is a model''s draft that code accepted; its Scroll is held for an operator''s read like any v2 library Scroll.';

create index recipes_planet_open on content.recipes (topic_id, facet_id) where status <> 'retired';
create index recipes_proposing_run on content.recipes (proposing_run_id) where proposing_run_id is not null;
