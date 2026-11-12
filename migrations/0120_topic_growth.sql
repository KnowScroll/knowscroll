-- #674 (3.4) Topic growth (D-422): new topics grow from candidates that code seeds, a model proposes where each belongs and
-- which facets it has, and code admits it through the catalogue's own admission (D-419). Nothing is served until the library
-- has released supply for it.
--
-- Owner: content. Three new tables and one value added to a check. Authoritative, shared, nonpersonal: a page address, a host,
-- a title and the page's public text are all that is held, and no person, no personal words and no private id is in any
-- of it. Nothing here is in the erasure registry, and nothing is evidence: no ranking, plan, evidence or place reads these tables.
-- 1. `content.topic_seed_sources`: one row per research page already accepted for a recipe whose links code has read, so each
--    page is read once. `outcome` is `read`, or the refusal code of the fetch; `links` is how many acceptable links the page held
--    and `candidates` how many of them became candidates (at most ten a page). A page that met a failure that may pass (the network's,
--    not the page's) is read again after a day and its row is replaced. Query shapes: the pages not to be read again (a scan of this
--    small table); one page by its address (the primary key). Growth: one row per recipe page, at most a few hundred. Retention: none.
-- 2. `content.topic_candidates`: one row per candidate page, keyed by its canonical address (https, an allow-listed host, no
--    query or fragment), which is the dedupe key. `status`: `pending` (a link code found, the page not read yet), `eligible`
--    (read, and passed every filter), `rejected` (a filter refused it; `verdict` is the code), `proposed` (a proposing run is
--    in flight; `attempt_day` pins its UTC day so a redelivery after midnight is the same request), `refused` (the model's
--    answer was not admitted, or it declined; `verdict` is the code), `admitted` (a topic was made; `topic_id`), and
--    `blocked_unknown` (an attempt of unknown outcome, never resent). `passages` is the page's extracted text as the
--    research fetch froze it (at most 8,000 characters in at most a few dozen paragraphs), kept for an eligible, proposed
--    or admitted candidate so the quotes a model gives can be checked against the page and the recipes of the new topic have
--    a page to cite; it is dropped for a rejected one. `attempts` counts failed proposing attempts (at most two) and `fetches`
--    failed reads of the page; `not_before` is the first UTC day the candidate may be proposed for again (the day after a failed attempt, or
--    after a page that no system had room for), so one outage or one unplaceable page never holds the queue. The owner approves each new
--    topic: `approval` is `pending` for every candidate, and `approved` or `rejected` (with who decided and when) once an operator has read the
--    topic's label, meaning and facets; a grown topic is made servable only when it is `approved` (and has its supply), and a `rejected`
--    topic is retired by a release. Query shapes: one candidate by address (the primary key); the next candidates to read, to
--    propose and the operator's list by status (the status index). Locking: one row, one statement; a proposing run is
--    serialised by the harness's own run, and its admission by the catalogue's release lock. Growth: at most ten rows for each
--    recipe page, a few thousand. Retention: kept for ever, since a rejected row is what stops the same page being read
--    again.
-- 3. `content.topic_proposals`: one row per proposing run of the `content.topic-proposal` role, the shape of
--    `content.recipe_proposals`: it freezes the context the role was sent (public page text and catalogue text only) so a
--    redelivery sends exactly the same request and the harness answers from its ledger instead of refusing a changed one, and
--    it says where the run stands (`open`, `completed`, `failed`) and what code decided (`outcome`: `admitted`, `declined` or a
--    refusal code, with the `topic_id` made). `shortlist` is the system ids the model was offered: the only ones it may name.
--    The run id is derived from the candidate, the UTC day and the attempt number. Query shapes: one run by id (the primary
--    key); the runs made since the start of a UTC day (the day index), which is what the daily growth cap counts. Growth: at
--    most the growth cap of rows a day, one or two for a candidate. Retention: kept as the audit of what was asked.
-- 4. `content.concept_releases.source` gains `growth`: a release that admitted a topic for a candidate page.
-- Lock order: a proposing run's admission takes the production root, then the catalogue's release lock (`content.concept-releases`), as
-- a release has always taken it alone; nothing takes them the other way round.
-- Rollout: additive. An older process never reads or writes any of it, never writes a `growth` release and cannot read a topic
-- that is not servable. Nothing moves until `KS_SUPPLY_GROWTH_ENABLED=1` and `KS_TOPIC_GROWTH_ENABLED=1`.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- squawk-ignore ban-drop-constraint
alter table content.concept_releases drop constraint concept_releases_source_check;
alter table content.concept_releases add constraint concept_releases_source_check
  check (source in ('seed', 'plan', 'visibility', 'operator', 'growth')) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table content.concept_releases validate constraint concept_releases_source_check;

create table content.topic_seed_sources (
  page_url text not null,
  host text not null,
  outcome text not null,
  links integer not null default 0,
  candidates integer not null default 0,
  read_at timestamptz not null default now(),
  constraint topic_seed_sources_pkey primary key (page_url),
  constraint topic_seed_sources_url_check check (page_url ~ '^https://[a-z0-9.-]+/' and char_length(page_url) <= 300),
  constraint topic_seed_sources_host_check check (char_length(host) between 1 and 255),
  constraint topic_seed_sources_outcome_check check (outcome ~ '^[a-z][a-z0-9_]*$' and char_length(outcome) <= 64),
  constraint topic_seed_sources_counts_check check (links >= 0 and candidates between 0 and links)
);

comment on table content.topic_seed_sources is
  'A research page already accepted for a recipe whose links code has read, once. Shared, nonpersonal.';

create table content.topic_candidates (
  page_url text not null,
  host text not null,
  source_url text,
  status text not null default 'pending',
  verdict text not null default 'ok',
  title text,
  passages jsonb,
  passage_count integer,
  page_sha256 text,
  fetches integer not null default 0,
  attempts integer not null default 0,
  attempt_day date,
  not_before date,
  topic_id text,
  approval text not null default 'pending',
  decided_by text,
  decided_at timestamptz,
  policy_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint topic_candidates_pkey primary key (page_url),
  constraint topic_candidates_url_check check (page_url ~ '^https://[a-z0-9.-]+/' and char_length(page_url) <= 300),
  constraint topic_candidates_host_check check (char_length(host) between 1 and 255),
  constraint topic_candidates_status_check
    check (status in ('pending', 'eligible', 'rejected', 'proposed', 'refused', 'admitted', 'blocked_unknown')),
  constraint topic_candidates_verdict_check check (verdict ~ '^[a-z][a-z0-9_]*$' and char_length(verdict) <= 64),
  -- A rejection and a refusal say why; a candidate that is waiting or admitted says "ok".
  constraint topic_candidates_verdict_status_check
    check ((status in ('rejected', 'refused', 'blocked_unknown')) = (verdict <> 'ok')),
  constraint topic_candidates_title_check check (title is null or char_length(title) between 1 and 300),
  constraint topic_candidates_passages_check
    check (passages is null or (jsonb_typeof(passages) = 'array' and octet_length(passages::text) <= 40000)),
  -- The page is held exactly while the candidate can still be proposed for or has become a topic.
  constraint topic_candidates_page_check
    check ((status in ('eligible', 'proposed', 'admitted', 'blocked_unknown')) = (passages is not null)),
  constraint topic_candidates_count_check check (passage_count is null or passage_count >= 0),
  constraint topic_candidates_sha_check check (page_sha256 is null or page_sha256 ~ '^[0-9a-f]{64}$'),
  constraint topic_candidates_attempts_check check (fetches between 0 and 10 and attempts between 0 and 2),
  constraint topic_candidates_topic_check
    check ((status = 'admitted') = (topic_id is not null) and (topic_id is null or char_length(topic_id) between 1 and 160)),
  -- The owner's decision belongs to a topic that was made, and says who made it and when.
  constraint topic_candidates_approval_check check (approval in ('pending', 'approved', 'rejected')),
  constraint topic_candidates_approval_status_check check (approval = 'pending' or status = 'admitted'),
  constraint topic_candidates_decision_check
    check ((approval = 'pending') = (decided_by is null and decided_at is null) and (decided_by is null or char_length(decided_by) between 1 and 120)),
  constraint topic_candidates_policy_check check (char_length(policy_version) between 1 and 64)
);

comment on table content.topic_candidates is
  'A page code found by following links of research pages already accepted for recipes, and what became of it as a topic. Shared, nonpersonal; no person is named.';

create index topic_candidates_status on content.topic_candidates (status, created_at, page_url);
create index topic_candidates_topic on content.topic_candidates (topic_id) where topic_id is not null;
create index topic_candidates_withheld on content.topic_candidates (topic_id) where status = 'admitted' and approval <> 'approved';

create table content.topic_proposals (
  run_id uuid not null,
  page_url text not null,
  day date not null,
  retry integer not null default 0,
  shortlist text[] not null,
  context jsonb not null,
  state text not null default 'open',
  outcome text,
  topic_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint topic_proposals_pkey primary key (run_id),
  constraint topic_proposals_page_fkey foreign key (page_url) references content.topic_candidates (page_url),
  constraint topic_proposals_retry_check check (retry between 0 and 1),
  constraint topic_proposals_shortlist_check check (cardinality(shortlist) between 1 and 24),
  constraint topic_proposals_context_check
    check (jsonb_typeof(context) = 'array' and octet_length(context::text) <= 65536),
  constraint topic_proposals_state_check check (state in ('open', 'completed', 'failed')),
  constraint topic_proposals_outcome_check
    check ((state = 'open') = (outcome is null) and (outcome is null or outcome ~ '^[a-z][a-z0-9_]*$')),
  constraint topic_proposals_topic_check
    check (topic_id is null or (outcome = 'admitted' and char_length(topic_id) between 1 and 160))
);

comment on table content.topic_proposals is
  'One proposing run of the topic proposal role: the frozen context it was sent, the systems it was offered and what code decided. Shared, nonpersonal.';

create index topic_proposals_day on content.topic_proposals (day);
create index topic_proposals_page on content.topic_proposals (page_url);
