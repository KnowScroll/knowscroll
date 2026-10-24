-- #244 What if, Another perspective and the shared Scenario Planner (blueprint §14, §17; D-049).
--
-- Owner: scenarios (schema scenarios), with two small tables owned by their modules: supply
-- (Quartermaster's ledger of scenario orders) and content (the Scrolls ordered from code).
-- Everything here is authoritative; nothing is derived.
--
-- scenarios.nodes: the exploration graph of a content thread. Each node has one parent (a node, or the
-- thread root when parent_node_id is null). `changes` are the explicit assumption changes of this step,
-- `kept` what this step declares unchanged, `assumptions` the effective set after the step (the
-- parent's, changed). A perspective keeps its parent's assumptions and has a lens; a what-if is
-- hypothetical, and so is everything below one. asset_id is the Scroll the branch will be; it is
-- allocated when the branch is chosen and admitted by production later (asset_revision is set then).
-- scenarios.drafts: one composer session of one member. It holds the member's words, the directions the
-- Scenario Planner proposed and the node the member finally chose. A draft starts no production.
--
-- Query shapes: a thread's nodes in creation order; the preparing nodes oldest first (the resolver
-- sweep); the node that holds an asset (the open gate); a member's drafts of a day (the draft limit).
-- Locking: every write takes the actor's personal root, the actor's account gate and the thread's own
-- root (social.conversations row) first; node rows are then locked FOR UPDATE by id. The resolver locks
-- one node row with SKIP LOCKED and nothing else.
-- Growth: a node per chosen branch, at most the thread cap (KS_SUPPLY_SCENARIO_THREAD_CAP); a draft per
-- request, deleted when it expires or its member is erased.
-- Retention: nodes are shared work of the thread and stay while the thread does. Deleting a member's
-- account deletes their drafts and clears their words and authorship from their nodes; the branch and
-- its Scroll stay for the others. Selective Clear deletes the person's drafts and keeps their nodes,
-- as it keeps messages.
-- Rollout: additive. No earlier writer exists for these tables.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema scenarios;

create table scenarios.nodes (
  node_id uuid primary key,
  thread_id uuid not null references social.conversations(conversation_id) on delete restrict,
  parent_node_id uuid references scenarios.nodes(node_id) on delete restrict,
  kind text not null check (kind in ('what_if', 'perspective')),
  origin_kind text not null check (origin_kind in ('root', 'snippet', 'message')),
  origin_message_id uuid references social.messages(message_id) on delete restrict,
  -- Null once the starter's account is deleted, together with request_text.
  started_by_account_id uuid references identity.accounts(id) on delete restrict,
  request_text text check (char_length(request_text) between 1 and 500),
  title text not null check (char_length(title) between 1 and 120),
  lens text check (char_length(lens) between 3 and 80),
  changes jsonb not null check (jsonb_typeof(changes) = 'array' and jsonb_array_length(changes) <= 2),
  kept jsonb not null check (jsonb_typeof(kept) = 'array' and jsonb_array_length(kept) <= 3),
  assumptions jsonb not null check (jsonb_typeof(assumptions) = 'array' and jsonb_array_length(assumptions) <= 4),
  hypothetical boolean not null,
  -- SHA-256 of the branch's meaning (parent, kind, changes or lens): the same idea in one thread is one node.
  semantic_key text not null check (semantic_key ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('preparing', 'ready', 'failed', 'removed')),
  revision integer not null check (revision >= 1),
  asset_id uuid not null unique,
  asset_revision integer check (asset_revision >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check ((kind = 'perspective') = (lens is not null)),
  check (kind = 'what_if' or jsonb_array_length(changes) = 0),
  check (kind = 'perspective' or (hypothetical and jsonb_array_length(changes) >= 1)),
  check ((origin_kind = 'root') = (origin_message_id is null)),
  check (status <> 'ready' or asset_revision is not null),
  check (asset_revision is null or status in ('ready', 'removed')),
  foreign key (asset_id, asset_revision) references content.asset_revisions(asset_id, revision) on delete restrict
);
-- One live branch per meaning in a thread. A failed or removed one does not block asking again.
create unique index nodes_live_meaning on scenarios.nodes(thread_id, semantic_key) where status in ('preparing', 'ready');
create index nodes_thread on scenarios.nodes(thread_id, created_at, node_id);
create index nodes_preparing on scenarios.nodes(created_at, node_id) where status = 'preparing';
create index nodes_parent on scenarios.nodes(parent_node_id) where parent_node_id is not null;
create index nodes_started_by on scenarios.nodes(started_by_account_id) where started_by_account_id is not null;

create table scenarios.drafts (
  draft_id uuid primary key,
  thread_id uuid not null references social.conversations(conversation_id) on delete restrict,
  requester_account_id uuid not null references identity.accounts(id) on delete restrict,
  requester_universe_id uuid not null references identity.universes(id) on delete restrict,
  -- The privacy epoch the request was made under: the worker acts for this universe at this epoch only.
  privacy_epoch integer not null check (privacy_epoch >= 1),
  kind text not null check (kind in ('what_if', 'perspective')),
  origin_kind text not null check (origin_kind in ('root', 'snippet', 'message')),
  origin_message_id uuid references social.messages(message_id) on delete restrict,
  parent_node_id uuid references scenarios.nodes(node_id) on delete restrict,
  parent_revision integer not null check (parent_revision >= 1),
  request_text text not null check (char_length(request_text) between 1 and 500),
  state text not null check (state in ('thinking', 'ready', 'failed', 'chosen')),
  failure text check (failure in ('could_not_suggest', 'budget_unavailable')),
  mode text check (mode in ('direct', 'options')),
  options jsonb check (
    options is null or (jsonb_typeof(options) = 'array' and jsonb_array_length(options) between 1 and 3
      and octet_length(options::text) <= 8192)
  ),
  node_id uuid references scenarios.nodes(node_id) on delete restrict,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at > created_at),
  check ((state = 'failed') = (failure is not null)),
  check ((state = 'chosen') = (node_id is not null)),
  check ((options is null) = (mode is null)),
  check (state <> 'thinking' or options is null),
  check ((origin_kind = 'root') = (origin_message_id is null))
);
create index drafts_requester_day on scenarios.drafts(requester_account_id, created_at);
create index drafts_thread on scenarios.drafts(thread_id, requester_account_id);
create index drafts_universe on scenarios.drafts(requester_universe_id);

-- Quartermaster's ledger of scenario orders (supply). One row per branch Create commissioned. It names
-- no person and no words: the day's count and a thread's count are what the caps read.
create table supply.scenario_orders (
  order_id uuid primary key,
  thread_id uuid not null,
  created_at timestamptz not null default now()
);
create index scenario_orders_day on supply.scenario_orders(created_at);
create index scenario_orders_thread on supply.scenario_orders(thread_id);

-- Scrolls ordered from code (content). The commissioner (a scenario branch) builds the brief, the
-- framing and the research pages; content stores them, researches the pages and writes the Scroll like
-- any other. `recipe` is the production job's key (`content.scroll_production_runs.topic`). Such a Scroll
-- is never offered in Explore and is never attributed to a topic or given coverage.
create table content.made_to_order_scrolls (
  recipe text primary key check (recipe ~ '^order-[0-9a-f]{32}$'),
  asset_id uuid not null unique,
  explanation_unit_id text not null check (char_length(explanation_unit_id) between 1 and 160),
  mode text not null check (mode in ('what_if', 'perspective')),
  brief text not null check (char_length(brief) between 1 and 6000),
  pages text[] not null check (cardinality(pages) between 1 and 3),
  kicker text not null check (char_length(kicker) between 1 and 40),
  framing jsonb not null check (jsonb_typeof(framing) = 'object' and octet_length(framing::text) <= 4096),
  created_at timestamptz not null default now()
);
