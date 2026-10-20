-- Evidence owns separate activity input vectors/revisions, replacement contributions and prepared
-- topic-format aggregates. One current row/exposure/topic, immutable bounded revisions grow with
-- actual changed input vectors. Indexed scope/key reads; no lifetime-history scan per swipe.
-- Retained personal evidence; full erasure deletes contributions/current/revisions/context before
-- Experience's exposure roots. No formation, provider or new transport/outbox is created.
set local lock_timeout='5s';
set local statement_timeout='60s';
create table evidence.activity_revisions (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),id uuid not null,exposure_id uuid not null,
 revision integer not null check(revision>=1),input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 input_vector jsonb not null check(octet_length(input_vector::text)<=4096),
 channels jsonb not null check(octet_length(channels::text)<=2048),
 activity double precision not null check(activity>=0 and activity<=3),
 policy_version text not null check(policy_version='activity.v0'),recorded_at timestamptz not null default now(),
 -- Input hashes may recur after a real reversible correction A -> B -> A; only CURRENT hash
 -- is idempotent under the personal root lock. Every change appends its own monotonic revision.
 primary key(universe_id,id),unique(universe_id,privacy_epoch,exposure_id,id),unique(universe_id,exposure_id,revision),
 foreign key(universe_id,exposure_id) references experience.exposures(universe_id,id) on delete restrict
);
create table evidence.activity_current (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),exposure_id uuid not null,activity_id uuid not null,
 primary key(universe_id,exposure_id),
 foreign key(universe_id,privacy_epoch,exposure_id,activity_id) references evidence.activity_revisions(universe_id,privacy_epoch,exposure_id,id) on delete restrict,
 foreign key(universe_id,exposure_id) references experience.exposures(universe_id,id) on delete restrict
);
create table evidence.topic_contributions (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),exposure_id uuid not null,topic_id text not null,
 channel_values jsonb not null check(jsonb_typeof(channel_values)='object' and octet_length(channel_values::text)<=2048),
 value double precision not null check(value>=0 and value<=3),measured integer not null check(measured in(0,1)),qualified integer not null check(qualified between 0 and measured),
 primary key(universe_id,exposure_id,topic_id),
 foreign key(universe_id,exposure_id) references evidence.activity_current(universe_id,exposure_id) on delete restrict
);
create table evidence.topic_context (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 privacy_epoch integer not null check(privacy_epoch>=1),topic_id text not null,
 channel_values jsonb not null check(jsonb_typeof(channel_values)='object' and octet_length(channel_values::text)<=2048),
 activity double precision not null check(activity>=0),evaluated_at timestamptz not null,
 reel_measured integer not null default 0 check(reel_measured>=0),reel_qualified integer not null default 0 check(reel_qualified between 0 and reel_measured),
 scroll_measured integer not null default 0 check(scroll_measured>=0),scroll_qualified integer not null default 0 check(scroll_qualified between 0 and scroll_measured),
 primary key(universe_id,topic_id)
);
-- Required broadened audit vocabulary; qualification rows/observation watermarks are untouched.
-- squawk-ignore ban-drop-constraint
alter table evidence.action_events drop constraint action_events_kind_check;
alter table evidence.action_events add constraint action_events_kind_check check(kind in('save','unsave','like','unlike','hide')) not valid;

-- Original channels/input vectors are audit facts; corrections append a new revision.
create function evidence.refuse_activity_rewrite() returns trigger language plpgsql as $$
begin
 raise exception 'ACTIVITY_REVISION_IMMUTABLE';
end $$;
create trigger refuse_activity_rewrite before update on evidence.activity_revisions for each row execute function evidence.refuse_activity_rewrite();
