-- PC-owned incremental observed coverage, separate from legacy routing/qualification aggregates.
-- Personal root -> Content canonical asset/head SHARE locks. No Content personal fanout or queue.
-- Current per-exposure certificate <=16KiB, <=16 references; indexed exact unit/topic/facet probes.
-- Support counts are projection state, never live authority: proof reads revalidate latest Evidence
-- and Content heads. Retain until correction/erasure; erase references/supports/certificates before
-- existing PC/Evidence activity/exposure roots. No historical seed/backfill or semantic approval.
set local lock_timeout='5s';
set local statement_timeout='60s';
create table personal_context.coverage_contributions (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null, activity_id uuid not null,
 input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=16384 and payload->>'version'='observed-static-coverage.v1'),
 primary key(universe_id,exposure_id),
 unique(universe_id,privacy_epoch,exposure_id),
 foreign key(universe_id,privacy_epoch,exposure_id,activity_id) references evidence.activity_revisions(universe_id,privacy_epoch,exposure_id,id) on delete restrict
);
create table personal_context.coverage_references (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1), exposure_id uuid not null,
 topic_id text not null check(length(topic_id) between 1 and 160),
 facet_id text not null check(length(facet_id) between 1 and 160),
 meaning_sha256 text not null check(meaning_sha256~'^[a-f0-9]{64}$'),
 explanation_unit_id text not null check(length(explanation_unit_id) between 1 and 160),
 truth_sha256 text not null check(truth_sha256~'^[a-f0-9]{64}$'),
 primary key(universe_id,privacy_epoch,exposure_id,topic_id,facet_id),
 foreign key(universe_id,privacy_epoch,exposure_id) references personal_context.coverage_contributions(universe_id,privacy_epoch,exposure_id) on delete restrict
);
create index coverage_reference_probe on personal_context.coverage_references(universe_id,privacy_epoch,topic_id,facet_id,explanation_unit_id,exposure_id);
create table personal_context.coverage_supports (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),
 topic_id text not null check(length(topic_id) between 1 and 160),
 facet_id text not null check(length(facet_id) between 1 and 160),
 meaning_sha256 text not null check(meaning_sha256~'^[a-f0-9]{64}$'),
 explanation_unit_id text not null check(length(explanation_unit_id) between 1 and 160),
 truth_sha256 text not null check(truth_sha256~'^[a-f0-9]{64}$'),
 reference_count integer not null check(reference_count>0),
 primary key(universe_id,privacy_epoch,topic_id,facet_id,meaning_sha256,explanation_unit_id,truth_sha256)
);
