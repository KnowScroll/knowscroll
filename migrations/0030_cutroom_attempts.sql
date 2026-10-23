-- #240 B only: shared public business/protected requests/pool intentions. No root seed or grant.
-- World root -> Content business -> Reasoning attempt/request/operation. Pool uses another DB.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create table reasoning.cutroom_scopes (
 world_id text primary key check (world_id in ('dev','stage')),
 generation integer not null check (generation > 0),
 enabled boolean not null default false
);
create table content.reel_commissions (
 world_id text not null references reasoning.cutroom_scopes(world_id),
 business_run_id uuid not null,
 generation integer not null check (generation > 0),
 script_sha256 text not null check (script_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
 policy_version text not null check (policy_version = 'cutroom-commission.v1'),
 approval_ref text not null check (length(approval_ref) between 1 and 128),
 command_sha256 text not null check (command_sha256 ~ '^[0-9a-f]{64}$'),
 package_utf8 text not null check (octet_length(package_utf8) between 1 and 65536),
 package_sha256 text not null check (package_sha256 = script_sha256 and package_sha256 = encode(sha256(convert_to(package_utf8,'UTF8')),'hex')),
 request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
 request_id text not null,
 take integer not null check (take between 1 and 999),
 ceiling_cents integer not null check (ceiling_cents between 1 and 75),
 attempt_id uuid,
 primary key(world_id,business_run_id),
 unique(world_id,request_id)
);
create table reasoning.cutroom_attempts (
 id uuid primary key,
 world_id text not null references reasoning.cutroom_scopes(world_id),
 business_run_id uuid not null,
 generation integer not null check (generation > 0),
 request_id text not null,
 script_sha256 text not null check (script_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
 policy_version text not null check (policy_version = 'cutroom-commission.v1'),
 request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
 request_bytes integer not null check (request_bytes between 1 and 100000),
 contract_version integer not null check (contract_version = 1),
 take integer not null check (take between 1 and 999),
 until text not null check (until = 'video'),
 ceiling_cents integer not null check (ceiling_cents between 1 and 75),
 approval_ref text not null check (length(approval_ref) between 1 and 128),
 grant_ref text not null check (grant_ref = 'knowscroll-v2-d018'),
 principal_oid text not null check (case when principal_oid ~ '^[0-9]{1,10}$' then principal_oid::bigint between 1 and 4294967295 else false end),
 principal_name text not null check (length(principal_name) between 1 and 63),
 state text not null default 'reserved' check (state in ('reserved','not_sent','dispatched','succeeded','failed','unknown','reconciled','written_off')),
 fence integer not null default 1 check (fence > 0),
 dispatch_intent_at timestamptz,
 expires_at timestamptz not null,
 pool_state text not null default 'pending' check (pool_state in ('pending','claimed','released','held')),
 binding_id uuid,
 claimed_at timestamptz,
 bound_at timestamptz,
 unique(world_id,business_run_id), unique(world_id,business_run_id,id), unique(world_id,request_id),
 foreign key(world_id,business_run_id) references content.reel_commissions(world_id,business_run_id),
 check (request_id = 'ks-reel-' || left(script_sha256,32) || '-' || take::text),
 check ((binding_id is null and claimed_at is null and bound_at is null) or (binding_id is not null and claimed_at is not null and bound_at is not null)),
 check (state <> 'not_sent' or dispatch_intent_at is null),
 check (dispatch_intent_at is null or state not in ('reserved','not_sent'))
);
alter table content.reel_commissions add constraint reel_commissions_attempt_fkey foreign key(world_id,business_run_id,attempt_id) references reasoning.cutroom_attempts(world_id,business_run_id,id);
create table reasoning.cutroom_requests (
 attempt_id uuid primary key references reasoning.cutroom_attempts(id),
 request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
 byte_length integer not null check (byte_length between 1 and 100000),
 contract_version integer not null check (contract_version = 1),
 created_at timestamptz not null,
 expires_at timestamptz not null,
 request_utf8 text,
 purged_at timestamptz,
 check (expires_at > created_at and expires_at <= created_at + interval '30 days'),
 check ((request_utf8 is null) = (purged_at is not null)),
 check (request_utf8 is null or (octet_length(request_utf8) = byte_length and request_sha256 = encode(sha256(convert_to(request_utf8,'UTF8')),'hex')))
);
create index cutroom_requests_expiry on reasoning.cutroom_requests(expires_at,attempt_id) where request_utf8 is not null;
create table reasoning.cutroom_pool_operations (
 id uuid primary key,
 attempt_id uuid not null references reasoning.cutroom_attempts(id),
 kind text not null check (kind in ('claim','release')),
 operation_version integer not null check (operation_version = 1),
 fence integer not null check (fence > 0),
 state text not null default 'pending' check (state in ('pending','in_flight','confirmed','held')),
 unique(attempt_id,kind)
);
create function reasoning.cutroom_attempt_guard() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new) - array['state','fence','dispatch_intent_at','pool_state','binding_id','claimed_at','bound_at'])
  is distinct from (to_jsonb(old) - array['state','fence','dispatch_intent_at','pool_state','binding_id','claimed_at','bound_at'])
  or new.fence < old.fence or (old.state = 'not_sent' and new.state <> 'not_sent')
  or (old.dispatch_intent_at is not null and new.dispatch_intent_at is distinct from old.dispatch_intent_at)
  or (old.binding_id is not null and (new.binding_id,new.claimed_at,new.bound_at) is distinct from (old.binding_id,old.claimed_at,old.bound_at))
 then raise check_violation using message = 'cutroom_attempt_immutable'; end if;
 return new;
end $$;
create trigger cutroom_attempt_guard before update on reasoning.cutroom_attempts for each row execute function reasoning.cutroom_attempt_guard();
create function reasoning.cutroom_request_guard() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new) - array['request_utf8','purged_at']) is distinct from (to_jsonb(old) - array['request_utf8','purged_at'])
  or old.request_utf8 is null or new.request_utf8 is not null or new.purged_at is null
 then raise check_violation using message = 'cutroom_request_immutable'; end if;
 return new;
end $$;
create trigger cutroom_request_guard before update on reasoning.cutroom_requests for each row execute function reasoning.cutroom_request_guard();
create function reasoning.cutroom_operation_guard() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new) - 'state') is distinct from (to_jsonb(old) - 'state')
 then raise check_violation using message = 'cutroom_operation_immutable'; end if;
 return new;
end $$;
create trigger cutroom_operation_guard before update on reasoning.cutroom_pool_operations for each row execute function reasoning.cutroom_operation_guard();
create function content.reel_commission_guard() returns trigger language plpgsql as $$
begin
 if (to_jsonb(new) - 'attempt_id') is distinct from (to_jsonb(old) - 'attempt_id')
  or old.attempt_id is not null or new.attempt_id is null
 then raise check_violation using message = 'reel_commission_immutable'; end if;
 return new;
end $$;
create trigger reel_commission_guard before update on content.reel_commissions for each row execute function content.reel_commission_guard();
