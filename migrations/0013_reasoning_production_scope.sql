-- 0013_reasoning_production_scope: reasoning-owned, authoritative nonpersonal execution boundary
-- for global Scroll supply. No production row references an account or personal universe.
-- The fixed world-local root is disabled initially; deployment configuration also defaults off.
-- Root lock -> production runs/attempts/domain effects -> shared budget advisory lock; no personal
-- roots may be acquired from this shared-only protocol. Generation fences stale work/results.
-- Reads: root by id; run/attempt by (scope_id, run_id, step); unknown/dispatched and request expiry
-- indexes for the existing operator/sweep/purge. Separate tables preserve personal erasure rules.
-- Growth: one run per production decision, bounded attempts per run, one protected request per
-- attempt until expiry. Requests use the same 48h default expiry and backup policy as personal
-- requests; no personal-erasure entry. Run/attempt audit rows currently retained, receipts retained.
-- Usage receipts remain shared and nonpersonal: add only a conclusive-failure bit. It survives
-- personal erasure and reservation refunds. Policy role-failure-brake.v1 limits new role/day runs
-- against five unresolved or conclusively failed receipts, independently of spend; one such receipt
-- per business run by the attempt state machine. Older processes tolerate this additive schema;
-- only new workers enforce the brake and production config. No old migration is changed.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table reasoning.usage_receipts
  add column conclusive_failure boolean not null default false;

-- Existing terminal failures must count even if their spend was released. Erased historical
-- failures cannot be recovered, but every failure settled by this implementation survives erasure.
update reasoning.usage_receipts receipt
set conclusive_failure = true
from reasoning.external_attempts attempt
where attempt.id = receipt.attempt_id
  and (attempt.state = 'failed' or (attempt.state = 'reconciled' and attempt.output is null and attempt.output_issues is null));

create table reasoning.production_scopes (
  id text primary key,
  generation integer not null default 1,
  enabled boolean not null default false,
  constraint production_scopes_id_check check (id = 'scroll-supply'),
  constraint production_scopes_generation_check check (generation > 0)
);
insert into reasoning.production_scopes (id) values ('scroll-supply');

create table reasoning.production_runs (
  scope_id text not null,
  id uuid not null,
  owner_module text not null,
  purpose text not null,
  generation integer not null,
  role_id text,
  role_version text,
  policy_version text,
  provider text,
  model text,
  context_bundle_ref text,
  context_refs jsonb,
  state text not null default 'admitted',
  fence integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint production_runs_pkey primary key (scope_id, id),
  constraint production_runs_scope_fkey foreign key (scope_id) references reasoning.production_scopes (id) on delete restrict,
  constraint production_runs_generation_check check (generation > 0),
  constraint production_runs_state_check check (state in ('admitted', 'completed', 'failed', 'cancelled'))
);

create table reasoning.production_attempts (
  role_id text,
  role_version text,
  -- The harness prompt template version; with role_version it pins the instructions sent.
  prompt_version text,
  -- The attempt this one repairs (a repair is a new attempt with its own reservation).
  causation_attempt_id uuid,
  -- Minted when dispatch intent commits; with dispatched_by it identifies the dispatching delivery.
  dispatch_id uuid,
  dispatched_by text,
  max_output_tokens integer,
  request_bytes integer,
  -- Budget reservation: request bytes (an upper bound of input tokens) + max output tokens.
  reserved_tokens integer not null default 0,
  -- UTC day the reservation counts against.
  budget_window date,
  -- Provider-reported usage; NULL when unknown (never estimated).
  input_tokens integer,
  output_tokens integer,
  reasoning_tokens integer,
  cached_tokens integer,
  -- {"v": 1, "verdict": …, "intervalRemainingPercent": …, "weeklyRemainingPercent": …}: an observation, not a reservation.
  quota_observation jsonb,
  -- {"v": 1, "reason": …, "issues": [...]}: the validator's result for an answer that was not usable.
  output_issues jsonb,
  -- Operator write-off of an `unknown` attempt: the reason text and who ran the command (`cli:<name>`).
  written_off_reason text,
  written_off_by text,
  written_off_at timestamptz,
  scope_id text not null,
  id uuid not null,
  run_id uuid not null,
  step text not null,
  provider text not null,
  model text not null,
  -- SHA-256 of the immutable request; a redelivery with another request is refused.
  request_hash text not null,
  state text not null default 'reserved',
  remote_id text,
  -- SUCCEEDED, OUTPUT_TOO_LARGE, OUTCOME_NOT_RECORDED, TRANSPORT_OUTCOME_UNKNOWN, AUTHORITY_REFUSED,
  -- or the provider's rejection code; a reconciled attempt keeps the late answer's real code.
  outcome_code text,
  -- {"v": 1, "text": …} for a successful call; nonpersonal production proposal audit.
  output jsonb,
  reserved_at timestamptz not null default now(),
  dispatched_at timestamptz,
  settled_at timestamptz,
  constraint production_attempts_pkey primary key (scope_id, id),
  constraint production_attempts_run_step_key unique (scope_id, run_id, step),
  constraint production_attempts_universe_fkey foreign key (scope_id) references reasoning.production_scopes (id) on delete restrict,
  constraint production_attempts_run_fkey foreign key (scope_id, run_id) references reasoning.production_runs (scope_id, id) on delete restrict,
  constraint production_attempts_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  -- The application bound is 64 KiB of serialised JSON; the slack covers jsonb's own formatting.
  constraint production_attempts_output_check check (
    output is null
    or (state in ('succeeded', 'reconciled') and jsonb_typeof(output) = 'object' and octet_length(output::text) <= 66560)
  ),
  constraint production_attempts_written_off_check check (state <> 'written_off' or (written_off_reason is not null and written_off_by is not null and written_off_at is not null)),
  constraint production_attempts_dispatch_check check (state in ('reserved', 'not_sent') or (dispatch_id is not null and dispatched_at is not null)),
  constraint production_attempts_state_check check (
    state in ('reserved', 'not_sent', 'dispatched', 'succeeded', 'failed', 'unknown', 'reconciled', 'written_off')
  )
);

create index production_attempts_unknown_idx on reasoning.production_attempts (state) where state = 'unknown';
create index production_attempts_dispatched_idx on reasoning.production_attempts (dispatched_at) where state = 'dispatched';

create table reasoning.production_requests (
  scope_id text not null,
  attempt_id uuid not null,
  body bytea not null,
  body_sha256 text not null,
  erasure_class text not null default 'nonpersonal_production',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint production_requests_pkey primary key (scope_id, attempt_id),
  constraint production_requests_scope_fkey foreign key (scope_id) references reasoning.production_scopes (id) on delete restrict,
  constraint production_requests_attempt_fkey foreign key (scope_id, attempt_id) references reasoning.production_attempts (scope_id, id) on delete restrict,
  constraint production_requests_size_check check (octet_length(body) between 1 and 262144),
  constraint production_requests_hash_check check (body_sha256 ~ '^[0-9a-f]{64}$'),
  constraint production_requests_body_hash_check check (encode(sha256(body), 'hex') = body_sha256),
  constraint production_requests_class_check check (erasure_class = 'nonpersonal_production'),
  constraint production_requests_expiry_check check (expires_at > created_at)
);
create index production_requests_expiry_idx on reasoning.production_requests (expires_at);
