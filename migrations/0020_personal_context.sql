-- Incremental qualified structural support. Activity/channel/Q/O remain Evidence-owned.
-- All rows are erasable personal state; no observations, credentials, model payloads or queue.
-- Apply under personal root lock. Per-exposure replacement touches <=32 topics/544 support keys;
-- variants/replays share unit/facet keys and cannot multiply distinct counts.
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Evidence-owned, coordinator-approved recent selection; never raw-activity ranking.
-- Transactional migrator cannot create concurrently. Deploy in the reviewed maintenance window;
-- fail after5s waiting for its write-blocking lock, retain60s statement bound. Existing small table.
-- squawk-ignore require-concurrent-index-creation
create index topic_context_recent on evidence.topic_context(universe_id,privacy_epoch,evaluated_at desc,topic_id);
create schema personal_context;
create table personal_context.contributions (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 explanation_unit_id text not null check(length(explanation_unit_id) between 1 and 160),
 qualified boolean not null,
 input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 payload_version text not null check(payload_version='personal-contribution.v0'),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384),
 projected_at timestamptz not null default now(),
 primary key(universe_id,exposure_id),
 foreign key(universe_id,exposure_id) references experience.exposures(universe_id,id) on delete restrict
);
create index context_contribution_unit on personal_context.contributions(universe_id,privacy_epoch,explanation_unit_id,exposure_id) where qualified;
create table personal_context.supports (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),
 topic_id text not null check(length(topic_id) between 1 and 160),
 kind text not null check(kind in('unit','facet')),
 support_key text not null check(length(support_key) between 1 and 160),
 reference_count integer not null check(reference_count>0),
 primary key(universe_id,privacy_epoch,topic_id,kind,support_key)
);
create index context_support_candidate on personal_context.supports(universe_id,privacy_epoch,kind,support_key,topic_id);
create table personal_context.topics (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),
 topic_id text not null check(length(topic_id) between 1 and 160),
 qualified_units integer not null check(qualified_units>=0),
 covered_facets integer not null check(covered_facets>=0),
 primary key(universe_id,privacy_epoch,topic_id)
);
create table personal_context.state (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),
 revision integer not null check(revision>=1),
 projected_scope_revision integer not null check(projected_scope_revision>=0),
 policy_version text not null check(policy_version='personal-context.v0'),
 primary key(universe_id,privacy_epoch)
);
