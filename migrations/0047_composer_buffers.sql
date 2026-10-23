-- Composer owns one worker-prepared buffer per person and mode: the next ready offers for the move
-- that follows the encounter the person is on, plus any stored Jev assessments (blueprint §9).
-- Authoritative for nothing: a buffer is a disposable cache of a ranking and creates no evidence.
-- Reads: exact primary-key probe when a navigation starts. Writes: the worker replaces the row.
-- Growth: at most one row per universe and mode.
-- Retention: a buffer is served for minutes. A served or discarded buffer is deleted in the
-- transaction that decides it. An expired one is deleted when its owner next navigates, when the
-- worker replaces it, and by pruneComposerDecisions (which deletes expired buffers before decisions).
-- Erasure: Clear and full erasure delete buffers before decisions (the foreign key restricts).
set local lock_timeout='5s';
set local statement_timeout='60s';
create table composer.buffers (
 universe_id uuid not null references identity.universes(id) on delete restrict,
 mode text not null check(mode='vertical'),
 privacy_epoch integer not null check(privacy_epoch>=1),
 session_id uuid not null,
 intent_revision integer not null check(intent_revision>=0),
 source_offer_id uuid not null,
 source_exposure_id uuid not null,
 decision_id uuid not null,
 selection jsonb not null check(jsonb_typeof(selection)='array' and jsonb_array_length(selection) between 1 and 3),
 assessments jsonb check(assessments is null or (jsonb_typeof(assessments)='object' and octet_length(assessments::text)<=16384)),
 prepared_at timestamptz not null default now(),
 expires_at timestamptz not null,
 primary key(universe_id,mode),
 foreign key(universe_id,privacy_epoch,decision_id) references composer.decisions(universe_id,privacy_epoch,id) on delete restrict,
 check(expires_at>prepared_at and expires_at<=prepared_at+interval '1 hour')
);
-- Composer's new personal store and its job payload store change the fresh-recording registry
-- (packages/backend/src/erasure-registry.ts), so its digest changes. The witness table's CHECK and the
-- birth trigger repeat that digest. Schema 44 is live on dev: accounts there hold witnesses stamped with
-- the old digest, and the application reads any other digest as an unavailable lifecycle, which stops
-- every recording-aware command for that person. The two new stores are empty for every existing
-- universe (the table is new and no buffer job has run), so re-stamping those witnesses with the new
-- digest states nothing false. The guard trigger refuses every update, so it is off for this one statement.
-- squawk-ignore ban-drop-constraint
alter table identity.recording_lifecycle_witnesses drop constraint recording_lifecycle_witnesses_registry_sha256_check;
alter table identity.recording_lifecycle_witnesses disable trigger recording_lifecycle_witness_guard;
update identity.recording_lifecycle_witnesses
 set registry_sha256='d7942e43bb8211f37dfd08b4dfb6ac2e1b2543229a257f9c5ba850df135a1d10'
 where registry_sha256='ebbec3bda043ab47c5566ebb29e80322e841f4dc15ef7940fc2ee4c053176dc1';
alter table identity.recording_lifecycle_witnesses enable trigger recording_lifecycle_witness_guard;
alter table identity.recording_lifecycle_witnesses add constraint recording_lifecycle_witnesses_registry_sha256_check
 check(registry_sha256='d7942e43bb8211f37dfd08b4dfb6ac2e1b2543229a257f9c5ba850df135a1d10') not valid;
-- One small row per universe; validating in the same transaction blocks reads for an instant.
-- squawk-ignore constraint-missing-not-valid
alter table identity.recording_lifecycle_witnesses validate constraint recording_lifecycle_witnesses_registry_sha256_check;
create or replace function identity.record_recording_birth() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if new.recording_lifecycle_protocol=1 then
  insert into identity.recording_lifecycle_witnesses values(new.id,new.privacy_epoch,new.account_id,1,'birth',null,
   'd7942e43bb8211f37dfd08b4dfb6ac2e1b2543229a257f9c5ba850df135a1d10',transaction_timestamp());
 end if;
 return new;
end $$;
