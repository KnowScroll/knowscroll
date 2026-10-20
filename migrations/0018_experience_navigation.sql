-- Experience owns scoped session intent, immutable offers, activated lineage and explicit actions.
-- Reads: exact scoped IDs, session members, recent20 activated, indexed unit/facet history probes.
-- Growth: sessions/offers/transitions/actions grow with actual commands; JSON/arrays are bounded.
-- Retention: retained personal encounter lineage; full erasure removes dependants first. No selective
-- clear-history API is implied. Existing immutable revisions/legacy receipts remain unchanged.
set local lock_timeout='5s';
set local statement_timeout='60s';
-- Required scoped integrity index on the existing small private decision table; transactional migration.
-- squawk-ignore require-concurrent-index-creation
create unique index composer_decisions_owned_idx on composer.decisions(universe_id,privacy_epoch,id);
create table experience.sessions (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 id uuid not null, privacy_epoch integer not null check(privacy_epoch>=1),
 intent_revision integer not null check(intent_revision>=0),
 capabilities jsonb not null check(jsonb_typeof(capabilities)='object' and octet_length(capabilities::text)<=8192),
 intent jsonb not null check(jsonb_typeof(intent)='object' and octet_length(intent::text)<=4096),
 created_at timestamptz not null default now(), primary key(universe_id,id),
 unique(universe_id,privacy_epoch,id)
);
create table experience.offers (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 id uuid not null,privacy_epoch integer not null check(privacy_epoch>=1),session_id uuid not null,
 intent_revision integer not null check(intent_revision>=0),decision_id uuid not null,
 asset_id uuid not null,asset_revision integer not null,
 descriptor jsonb not null check(jsonb_typeof(descriptor)='object' and octet_length(descriptor::text)<=8192),
 source_offer_id uuid,source_exposure_id uuid,mode text not null check(mode in('vertical','series','related','variant','return')),
 continuity_link_id uuid,continuity_link_revision integer,
 expires_at timestamptz not null,created_at timestamptz not null default now(),
 primary key(universe_id,id),unique(universe_id,session_id,id),
 foreign key(universe_id,privacy_epoch,session_id) references experience.sessions(universe_id,privacy_epoch,id) on delete restrict,
 foreign key(universe_id,privacy_epoch,decision_id) references composer.decisions(universe_id,privacy_epoch,id) on delete restrict,
 foreign key(asset_id,asset_revision) references content.asset_revisions(asset_id,revision) on delete restrict,
 foreign key(universe_id,source_exposure_id) references experience.exposures(universe_id,id) on delete restrict,
 check((source_offer_id is null)=(source_exposure_id is null)),
 check((continuity_link_id is null)=(continuity_link_revision is null)),
 check(expires_at>created_at and expires_at<=created_at+interval '15 minutes')
);
create index offers_session_idx on experience.offers(universe_id,session_id,intent_revision,id);
create table experience.offer_activations (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),offer_id uuid not null,exposure_id uuid not null,
 primary key(universe_id,offer_id),unique(universe_id,exposure_id),unique(universe_id,offer_id,exposure_id),
 foreign key(universe_id,offer_id) references experience.offers(universe_id,id) on delete restrict,
 foreign key(universe_id,exposure_id) references experience.exposures(universe_id,id) on delete restrict
);
-- Exact source is an actual activated member of this same session, never merely an offered buffer.
alter table experience.offers add constraint offers_source_offer_fkey foreign key(universe_id,session_id,source_offer_id) references experience.offers(universe_id,session_id,id) on delete restrict;
create table experience.encounter_lineage (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),exposure_id uuid not null,
 asset_id uuid not null,asset_revision integer not null,kind text not null check(kind in('reel','scroll')),
 explanation_unit_id text not null check(length(explanation_unit_id) between 1 and 160),
 facets text[] not null check(cardinality(facets)<=16),activated_at timestamptz not null,
 primary key(universe_id,exposure_id),
 foreign key(universe_id,exposure_id) references experience.exposures(universe_id,id) on delete restrict,
 foreign key(asset_id,asset_revision) references content.asset_revisions(asset_id,revision) on delete restrict
);
create index lineage_recent_idx on experience.encounter_lineage(universe_id,privacy_epoch,activated_at desc,exposure_id);
create index lineage_unit_idx on experience.encounter_lineage(universe_id,privacy_epoch,explanation_unit_id,activated_at desc,exposure_id);
create index lineage_facet_idx on experience.encounter_lineage using gin(facets);
-- Truthful historical metadata only: actual activated exposures, immutable identity and real facets.
insert into experience.encounter_lineage select e.universe_id,e.privacy_epoch,e.id,e.asset_id,e.asset_revision,e.kind,r.explanation_unit_id,d.facets,e.activated_at
 from experience.exposures e join content.asset_revisions r on r.asset_id=e.asset_id and r.revision=e.asset_revision
 join content.discovery_revisions d on d.asset_id=r.asset_id and d.asset_revision=r.revision where e.activated_at is not null;
create table experience.encounter_activity_inputs (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),exposure_id uuid not null,
 liked boolean not null default false,saved boolean not null default false,horizontal boolean not null default false,returned boolean not null default false,
 action_revision integer not null default 0 check(action_revision>=0),navigation_revision integer not null default 0 check(navigation_revision>=0),
 primary key(universe_id,exposure_id),foreign key(universe_id,exposure_id) references experience.exposures(universe_id,id) on delete restrict
);
insert into experience.encounter_activity_inputs(universe_id,privacy_epoch,exposure_id) select universe_id,privacy_epoch,exposure_id from experience.encounter_lineage;
create table experience.action_state (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),asset_id uuid not null references content.assets(id) on delete restrict,
 liked boolean not null default false,hidden boolean not null default false,
 saved_origin_exposure_id uuid,liked_origin_exposure_id uuid,saved_origin_action_id uuid,liked_origin_action_id uuid,
 primary key(universe_id,asset_id),
 foreign key(universe_id,saved_origin_exposure_id) references experience.exposures(universe_id,id) on delete restrict,
 foreign key(universe_id,liked_origin_exposure_id) references experience.exposures(universe_id,id) on delete restrict,
 foreign key(universe_id,saved_origin_action_id) references experience.actions(universe_id,id) on delete restrict,
 foreign key(universe_id,liked_origin_action_id) references experience.actions(universe_id,id) on delete restrict
);
create index action_state_hide_idx on experience.action_state(universe_id,privacy_epoch,asset_id) where hidden;
create table experience.action_links (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),action_id uuid not null,provided_exposure_id uuid,credited_exposure_id uuid,origin_action_id uuid,
 primary key(universe_id,action_id),foreign key(universe_id,action_id) references experience.actions(universe_id,id) on delete restrict,
 foreign key(universe_id,provided_exposure_id) references experience.exposures(universe_id,id) on delete restrict,
 foreign key(universe_id,credited_exposure_id) references experience.exposures(universe_id,id) on delete restrict,
 foreign key(universe_id,origin_action_id) references experience.actions(universe_id,id) on delete restrict
);
create table experience.navigation_transitions (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),target_exposure_id uuid not null,source_exposure_id uuid,offer_id uuid not null,session_id uuid not null,
 mode text not null check(mode in('vertical','series','related','variant','return')),horizontal boolean not null,returned boolean not null,
 policy_version text not null check(policy_version='activity.v0'),
 primary key(universe_id,target_exposure_id),
 foreign key(universe_id,target_exposure_id) references experience.exposures(universe_id,id) on delete restrict,
 foreign key(universe_id,source_exposure_id) references experience.exposures(universe_id,id) on delete restrict,
 foreign key(universe_id,session_id,offer_id) references experience.offers(universe_id,session_id,id) on delete restrict
);
create index transitions_source_idx on experience.navigation_transitions(universe_id,source_exposure_id);
-- Widens explicit actions without changing old rows or legacy receipt operation/version.
-- squawk-ignore ban-drop-constraint
alter table experience.actions drop constraint actions_kind_check;
alter table experience.actions add constraint actions_kind_check check(kind in('save','unsave','like','unlike','hide')) not valid;

-- Required operator reconcile index on retained actual activations, bounded by migration timeouts.
-- squawk-ignore require-concurrent-index-creation
create index exposures_activity_reconcile_idx on experience.exposures(universe_id,privacy_epoch,id) where activated_at is not null;
