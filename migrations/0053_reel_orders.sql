-- 0053_reel_orders: ordering Reels from Cutroom (#240, D-041).
--
-- Owner: content. Authoritative for the business run "make a Reel of this script" and for the
-- external attempts that ask Cutroom to do it. The shared Reel pool (its own database) stays the
-- sole spend record; this schema records what this world asked for and what came of it.
-- Reads: the order and its attempts by script digest on every operator command.
-- Writes: operator commands only (`reel order`, `reel follow`, `reel receive`), in short
-- transactions. Never across a Cutroom call or a pool call.
-- Growth: one order per script, one attempt per take. A handful of rows in practice.
-- Retention/erasure: shared content production; no person, account or universe is referenced.
-- Rollout: additive. 0053 also removes the connected-commissioning tables of 0030-0039, which no
-- world has ever populated (their code never ran against a real order); see D-041.

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The business run. Its identity is the digest of the script's wire content, the same in every
-- world: editing a script is a new order, ordering it again is the same one.
create table content.reel_orders (
  id uuid primary key,
  script_name text not null check (script_name ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  recipe_key text not null check (length(recipe_key) between 1 and 80),
  until text not null check (until in ('plan', 'video')),
  script_sha256 text not null unique check (script_sha256 ~ '^[0-9a-f]{64}$'),
  approval_ref text not null check (length(approval_ref) between 1 and 500),
  asset_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  check ((asset_id is null) = (published_at is null)),
  check (until = 'video' or asset_id is null)
);

-- One attempt is one request to Cutroom. States are the blueprint's attempt states: `dispatched`
-- means "may have been sent". `paid` attempts must hold a pool claim before they leave `reserved`.
create table content.reel_attempts (
  id uuid primary key,
  order_id uuid not null references content.reel_orders (id) on delete restrict,
  take integer not null check (take between 1 and 999),
  paid boolean not null,
  request_id text not null unique check (request_id ~ '^ks-reel-[0-9a-f]{32}-[1-9][0-9]{0,2}$'),
  request_utf8 text not null check (octet_length(request_utf8) between 1 and 100000),
  request_sha256 text not null check (
    request_sha256 ~ '^[0-9a-f]{64}$' and request_sha256 = encode(sha256(convert_to(request_utf8, 'UTF8')), 'hex')
  ),
  ceiling_cents integer not null check (ceiling_cents between 1 and 75),
  state text not null default 'reserved' check (
    state in ('reserved', 'not_sent', 'dispatched', 'succeeded', 'failed', 'unknown', 'reconciled', 'written_off')
  ),
  -- A closed code for why an attempt did not go, failed or is unknown. Never provider text.
  outcome_code text check (outcome_code ~ '^[a-z0-9_]{1,60}$'),
  -- The operator's reason for writing an uncertain attempt off. The claim stays open.
  operator_note text check (length(operator_note) between 1 and 300),
  run_id text check (run_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  pool_state text not null default 'none' check (pool_state in ('none', 'claimed', 'settled', 'released')),
  remote_outcome text check (remote_outcome in ('completed', 'refused', 'stopped', 'failed', 'cancelled')),
  remote_cost_cents integer check (remote_cost_cents >= 0),
  final_run_id text check (final_run_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
  run_ids text[] check (cardinality(run_ids) between 1 and 2),
  -- Cutroom's reason for a stop, redacted and cut: for the operator, never shown to a person.
  remote_detail text check (length(remote_detail) <= 500),
  reserved_at timestamptz not null default clock_timestamp(),
  dispatched_at timestamptz,
  finished_at timestamptz,
  settled_at timestamptz,
  unique (order_id, take),
  check (right(request_id, length(take::text) + 1) = '-' || take::text),
  check (paid or pool_state = 'none'),
  -- Claim before order: nothing paid leaves `reserved` without a claim in the pool.
  check (not paid or state in ('reserved', 'not_sent') or pool_state <> 'none'),
  check (pool_state <> 'released' or state in ('not_sent', 'failed')),
  check (pool_state <> 'settled' or (remote_outcome is not null and settled_at is not null)),
  check ((dispatched_at is null) = (state in ('reserved', 'not_sent'))),
  check ((remote_outcome is null) = (finished_at is null)),
  check (
    (remote_outcome is null) = (remote_cost_cents is null) and (remote_outcome is null) = (final_run_id is null)
    and (remote_outcome is null) = (run_ids is null)
  ),
  check (remote_outcome is null or state in ('succeeded', 'reconciled')),
  check ((state in ('succeeded', 'reconciled')) = (run_id is not null)),
  check ((state = 'written_off') = (operator_note is not null))
);

create function content.reel_attempt_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise check_violation using message = 'reel_attempt_never_deleted';
  end if;
  -- Identity never changes; the rest moves forward only, and what is set stays set.
  if (new.id, new.order_id, new.take, new.paid, new.request_id, new.request_utf8, new.request_sha256,
      new.ceiling_cents, new.reserved_at)
     is distinct from
     (old.id, old.order_id, old.take, old.paid, old.request_id, old.request_utf8, old.request_sha256,
      old.ceiling_cents, old.reserved_at)
     or (old.dispatched_at is not null and new.dispatched_at is distinct from old.dispatched_at)
     or (old.run_id is not null and new.run_id is distinct from old.run_id)
     or (old.operator_note is not null and new.operator_note is distinct from old.operator_note)
     or (old.remote_outcome is not null and (new.remote_outcome, new.remote_cost_cents, new.final_run_id,
         new.run_ids, new.remote_detail, new.finished_at) is distinct from
         (old.remote_outcome, old.remote_cost_cents, old.final_run_id, old.run_ids, old.remote_detail, old.finished_at))
     or (old.settled_at is not null and new.settled_at is distinct from old.settled_at)
     or (old.pool_state in ('settled', 'released') and new.pool_state <> old.pool_state)
     or (old.pool_state = 'claimed' and new.pool_state = 'none')
     or (old.pool_state = 'none' and new.pool_state in ('settled', 'released'))
     or not (
       new.state = old.state
       or (old.state = 'reserved' and new.state in ('not_sent', 'dispatched'))
       or (old.state = 'dispatched' and new.state in ('succeeded', 'failed', 'unknown'))
       or (old.state = 'unknown' and new.state in ('reconciled', 'written_off'))
     )
  then
    raise check_violation using message = 'reel_attempt_immutable';
  end if;
  return new;
end $$;
create trigger reel_attempt_guard before update or delete on content.reel_attempts
  for each row execute function content.reel_attempt_guard();

create function content.reel_order_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE'
     or (new.id, new.script_name, new.recipe_key, new.until, new.script_sha256, new.approval_ref, new.created_at)
        is distinct from
        (old.id, old.script_name, old.recipe_key, old.until, old.script_sha256, old.approval_ref, old.created_at)
     or (old.asset_id is not null and (new.asset_id, new.published_at) is distinct from (old.asset_id, old.published_at))
  then
    raise check_violation using message = 'reel_order_immutable';
  end if;
  return new;
end $$;
create trigger reel_order_guard before update or delete on content.reel_orders
  for each row execute function content.reel_order_guard();

-- Reels no longer come only from the three approved v1 scripts. The name stays a plain label.
-- squawk-ignore ban-drop-constraint
alter table content.reel_imports drop constraint reel_imports_script_check;
-- Existing rows hold one of the three original names and satisfy the new check; NOT VALID still
-- enforces every new write without scanning a table of a few rows under the lock.
alter table content.reel_imports
  add constraint reel_imports_script_name_check check (script_name ~ '^[a-z0-9][a-z0-9-]{0,79}$') not valid;
