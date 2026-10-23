set local lock_timeout = '5s';
set local statement_timeout = '60s';

create schema composer;
create table composer.decisions (
  id uuid primary key,
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  command_id uuid not null,
  session_id uuid,
  intent_revision integer check (intent_revision >= 0),
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  policy_version text not null check (policy_version='composer-policy.v0'),
  payload jsonb not null check (jsonb_typeof(payload)='object' and octet_length(payload::text)<=262144),
  recorded_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique(universe_id,privacy_epoch,command_id),
  check (payload ?& array['version','universeId','privacyEpoch','policyVersion'] and payload->>'version'='composer-decision.v0' and payload->>'universeId'=universe_id::text and (payload->>'privacyEpoch')::integer=privacy_epoch and payload->>'policyVersion'=policy_version),
  check ((session_id is null) = (intent_revision is null)),
  check (expires_at > recorded_at and expires_at <= recorded_at + interval '30 days')
);
create index composer_decisions_scope_idx on composer.decisions(universe_id,privacy_epoch,recorded_at desc,id);
create index composer_decisions_expiry_idx on composer.decisions(universe_id,expires_at,id);

-- Durable policy/binding/result bytes never change. Retention timestamps remain maintenance metadata.
create function composer.refuse_decision_rewrite() returns trigger language plpgsql as $$
begin
  if (new.id,new.universe_id,new.privacy_epoch,new.command_id,new.session_id,new.intent_revision,new.input_sha256,new.policy_version,new.payload)
    is distinct from (old.id,old.universe_id,old.privacy_epoch,old.command_id,old.session_id,old.intent_revision,old.input_sha256,old.policy_version,old.payload) then
    raise exception 'COMPOSER_DECISION_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger refuse_decision_rewrite before update on composer.decisions for each row execute function composer.refuse_decision_rewrite();
