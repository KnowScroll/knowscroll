-- #240 C1: inert review/intent/accounting foundation. No corpus/root/approval seed or transport.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create table content.cutroom_corpus (
 source_namespace text not null check (source_namespace ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 generated_reel_id text not null check (generated_reel_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 record_utf8 text not null check (octet_length(record_utf8) between 1 and 16384),
 record_sha256 text not null check (record_sha256 = encode(sha256(convert_to(record_utf8,'UTF8')),'hex')),
 original_template_sha256 text check (original_template_sha256 ~ '^[0-9a-f]{64}$'),
 original_argument_sha256 text check (original_argument_sha256 ~ '^[0-9a-f]{64}$'),
 bridge_sha256 text not null check (bridge_sha256 ~ '^[0-9a-f]{64}$'),
 primary key(source_namespace,generated_reel_id),
 check (original_template_sha256 is not null or original_argument_sha256 is not null)
);
-- Historical collisions are legitimate records, never UNIQUE fingerprints or availability-filtered.
create index cutroom_corpus_template on content.cutroom_corpus(original_template_sha256);
create index cutroom_corpus_argument on content.cutroom_corpus(original_argument_sha256);
create index cutroom_corpus_bridge on content.cutroom_corpus(bridge_sha256);
create table content.cutroom_reviews (
 world_id text not null,
 business_run_id uuid not null,
 packet_utf8 text not null check (octet_length(packet_utf8) between 1 and 100000),
 review_sha256 text not null check (review_sha256 ~ '^[0-9a-f]{64}$'),
 corpus_sha256 text not null check (corpus_sha256 ~ '^[0-9a-f]{64}$'),
 template_sha256 text not null check (template_sha256 ~ '^[0-9a-f]{64}$'),
 bridge_sha256 text not null check (bridge_sha256 ~ '^[0-9a-f]{64}$'),
 human_evidence_ref text not null check (human_evidence_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 revoked_at timestamptz,
 primary key(world_id,business_run_id),
 foreign key(world_id,business_run_id) references content.reel_commissions(world_id,business_run_id)
);
create index cutroom_reviews_template on content.cutroom_reviews(template_sha256);
create index cutroom_reviews_bridge on content.cutroom_reviews(bridge_sha256);
create table reasoning.cutroom_execution (
 attempt_id uuid primary key references reasoning.cutroom_attempts(id),
 world_id text not null,
 business_run_id uuid not null,
 dispatch_id uuid not null unique,
 request_sha256 text not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
 fence integer not null check (fence > 0),
 review_sha256 text not null check (review_sha256 ~ '^[0-9a-f]{64}$'),
 corpus_sha256 text not null check (corpus_sha256 ~ '^[0-9a-f]{64}$'),
 human_evidence_ref text not null check (human_evidence_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 profile_sha256 text not null check (profile_sha256 ~ '^[0-9a-f]{64}$'),
 sole_writer_evidence_sha256 text not null check (sole_writer_evidence_sha256 ~ '^[0-9a-f]{64}$'),
 funds_evidence_sha256 text not null check (funds_evidence_sha256 ~ '^[0-9a-f]{64}$'),
 preflight_observed_at timestamptz not null,
 preflight_expires_at timestamptz not null,
 available_cents integer not null check (available_cents between 0 and 900),
 binding_id uuid not null, claimed_at timestamptz not null, bound_at timestamptz not null,
 follow_until timestamptz not null,
 foreign key(world_id,business_run_id,attempt_id) references reasoning.cutroom_attempts(world_id,business_run_id,id),
 foreign key(world_id,business_run_id) references content.cutroom_reviews(world_id,business_run_id),
 check (preflight_expires_at > preflight_observed_at and preflight_expires_at <= preflight_observed_at + interval '30 seconds')
);
create table reasoning.cutroom_observations (
 id uuid primary key,
 attempt_id uuid not null references reasoning.cutroom_attempts(id),
 request_id text not null check (length(request_id) between 1 and 128),
 run_id text check (run_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
 projection_sha256 text not null check (projection_sha256 ~ '^[0-9a-f]{64}$'),
 outcome text not null check (outcome in ('pending','unknown','terminal_unvalidated')),
 observed_generation integer not null check (observed_generation > 0),
 unique(attempt_id,evidence_sha256), unique(attempt_id,id)
);
create table reasoning.cutroom_accounting_intents (
 observation_id uuid primary key,
 attempt_id uuid not null,
 -- No verified cost or settlement authority exists until D1/C2. This is retained work, NOT a cents balance.
 state text not null default 'pending' check (state = 'pending'),
 foreign key(attempt_id,observation_id) references reasoning.cutroom_observations(attempt_id,id)
);
create function reasoning.cutroom_execution_immutable() returns trigger language plpgsql as $$
begin raise check_violation using message = 'cutroom_execution_immutable'; end $$;
create trigger cutroom_execution_immutable before update or delete on reasoning.cutroom_execution for each row execute function reasoning.cutroom_execution_immutable();
create trigger cutroom_observation_immutable before update or delete on reasoning.cutroom_observations for each row execute function reasoning.cutroom_execution_immutable();
create trigger cutroom_accounting_intent_immutable before update or delete on reasoning.cutroom_accounting_intents for each row execute function reasoning.cutroom_execution_immutable();
create trigger cutroom_corpus_immutable before update or delete on content.cutroom_corpus for each row execute function reasoning.cutroom_execution_immutable();
create function content.cutroom_review_guard() returns trigger language plpgsql as $$
begin
 if tg_op = 'DELETE' then raise check_violation using message = 'cutroom_review_immutable'; end if;
 if (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at') or old.revoked_at is not null or new.revoked_at is null
 then raise check_violation using message = 'cutroom_review_immutable'; end if;
 return new;
end $$;
create trigger cutroom_review_guard before update or delete on content.cutroom_reviews for each row execute function content.cutroom_review_guard();
