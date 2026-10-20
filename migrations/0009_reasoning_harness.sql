-- 0009_reasoning_harness: the S2.2 reasoning harness on top of the 0006 attempt ledger — run
-- descriptors and fences, attempt accounting columns (role, prompt version, causation, dispatch
-- identity, reservation, usage, quota observation, validator result, write-off), the protected
-- request store and the minimal usage receipts budgets are counted from.
--
-- Owner: reasoning engine. Authoritative for attempt accounting, protected request bytes and usage
--   receipts; owning modules keep their accepted proposals elsewhere.
-- Identity (blueprint §5): personal records keyed (universe_id, id); a protected request is tied to
--   its own attempt in the same universe by a composite foreign key. Usage receipts are keyed by
--   attempt ID only and carry no universe, purpose, context or output: they are the minimal
--   accounting identity that survives erasure (blueprint §15), so global and per-role budgets and
--   late usage still settle after a person's context is erased.
-- Reads: latest attempt of a run step on every delivery; per-scope usage of one universe's attempts
--   in the current UTC day (under the personal lock); global/per-role usage from receipts in the
--   current UTC day (under a transaction advisory lock); expired protected requests for purging.
-- Writes: run admission and closure (fence + 1); reservation = attempt + protected request bytes +
--   receipt in the admission transaction; dispatch intent with the quota observation; ledger-owned
--   settlement with usage, outcome code and the stored output or validator issues; operator
--   write-off of `unknown` attempts with its reason.
-- Growth: one run per admitted job, at most a few attempts per run (primary, one repair, and new
--   sequences only after `not_sent`), one receipt per attempt, one protected request per attempt
--   until it expires (default 48 hours).
-- Retention/erasure: protected request bytes expire and are purged; erasure removes all of a
--   universe's protected requests (also for open attempts), settled attempts and runs without
--   attempts. Receipts are not personal and are kept for accounting (no retention job yet).
-- Rollout: additive. New columns are nullable or have constant defaults; the 0006 skeleton code
--   never reads them. No product data exists in these tables yet (S2.2 is their first writer).

-- Bounded waits: a migration fails fast instead of queueing behind live traffic (CF-27 backup first).
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table reasoning.business_runs
  add column role_id text,
  add column role_version text,
  add column policy_version text,
  add column provider text,
  add column model text,
  -- The owning module's reference to its frozen context bundle, and the refs of the items sent
  -- (never their text: that lives only in the protected request bytes).
  add column context_bundle_ref text,
  add column context_refs jsonb,
  -- Incremented when the run is closed; an applier closes with the fence it was given.
  add column fence integer not null default 1,
  add column closed_at timestamptz;

alter table reasoning.external_attempts
  add column role_id text,
  add column role_version text,
  -- The harness prompt template version; with role_version it pins the instructions sent.
  add column prompt_version text,
  -- The attempt this one repairs (a repair is a new attempt with its own reservation).
  add column causation_attempt_id uuid,
  -- Minted when dispatch intent commits; with dispatched_by it identifies the dispatching delivery.
  add column dispatch_id uuid,
  add column dispatched_by text,
  add column max_output_tokens integer,
  add column request_bytes integer,
  -- Budget reservation: request bytes (an upper bound of input tokens) + max output tokens.
  add column reserved_tokens integer not null default 0,
  -- UTC day the reservation counts against.
  add column budget_window date,
  -- Provider-reported usage; NULL when unknown (never estimated).
  add column input_tokens integer,
  add column output_tokens integer,
  add column reasoning_tokens integer,
  add column cached_tokens integer,
  -- {"v": 1, "verdict": …, "intervalRemainingPercent": …, "weeklyRemainingPercent": …}: an observation, not a reservation.
  add column quota_observation jsonb,
  -- {"v": 1, "reason": …, "issues": [...]}: the validator's result for an answer that was not usable.
  add column output_issues jsonb,
  add column written_off_reason text,
  add column written_off_at timestamptz;

create table reasoning.protected_requests (
  universe_id uuid not null,
  attempt_id uuid not null,
  -- The exact request bytes the provider adapter sends (no credential: keys travel in headers).
  -- Personal context: never logged, read only through the harness, erased with the universe.
  body bytea not null,
  body_sha256 text not null,
  erasure_class text not null default 'personal_context',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint protected_requests_pkey primary key (universe_id, attempt_id),
  constraint protected_requests_universe_fkey foreign key (universe_id) references identity.universes (id) on delete restrict,
  constraint protected_requests_attempt_fkey foreign key (universe_id, attempt_id) references reasoning.external_attempts (universe_id, id) on delete restrict,
  constraint protected_requests_size_check check (octet_length(body) between 1 and 262144),
  constraint protected_requests_hash_check check (body_sha256 ~ '^[0-9a-f]{64}$'),
  constraint protected_requests_class_check check (erasure_class in ('personal_context')),
  constraint protected_requests_expiry_check check (expires_at > created_at)
);

create index protected_requests_expiry_idx on reasoning.protected_requests (expires_at);

create table reasoning.usage_receipts (
  attempt_id uuid not null,
  role_id text not null,
  role_version text not null,
  provider text not null,
  model text not null,
  budget_window date not null,
  reserved_tokens integer not null,
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cached_tokens integer,
  -- held: reserved or in flight; settled: conclusive; released: never sent (charges nothing);
  -- unknown: may have been sent (charges its reservation until usage is known); written_off.
  state text not null default 'held',
  -- Usage that arrived after the attempt had been written off.
  late_usage boolean not null default false,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint usage_receipts_pkey primary key (attempt_id),
  constraint usage_receipts_state_check check (state in ('held', 'settled', 'released', 'unknown', 'written_off')),
  constraint usage_receipts_tokens_check check (
    reserved_tokens >= 0
    and (input_tokens is null or input_tokens >= 0)
    and (output_tokens is null or output_tokens >= 0)
    and (reasoning_tokens is null or reasoning_tokens >= 0)
    and (cached_tokens is null or cached_tokens >= 0)
  )
);

create index usage_receipts_window_idx on reasoning.usage_receipts (budget_window, role_id);
