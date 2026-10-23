-- Composer owns one worker-prepared buffer per person and mode: the next ready offers for the move
-- that follows the encounter the person is on, plus any stored Jev assessments (blueprint §9).
-- Authoritative for nothing: a buffer is a disposable cache of a ranking and creates no evidence.
-- Reads: exact primary-key probe when a navigation starts. Writes: the worker replaces the row.
-- Growth: at most one row per universe and mode. Retention: expires within minutes; a served or
-- discarded buffer is deleted in the transaction that decides it.
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
-- birth trigger repeat that digest; both move to the new value. Witnesses written under the old
-- digest are not rechecked (NOT VALID) and read as unavailable until the next Clear re-certifies them.
-- squawk-ignore ban-drop-constraint
alter table identity.recording_lifecycle_witnesses drop constraint recording_lifecycle_witnesses_registry_sha256_check;
alter table identity.recording_lifecycle_witnesses add constraint recording_lifecycle_witnesses_registry_sha256_check
 check(registry_sha256='d7942e43bb8211f37dfd08b4dfb6ac2e1b2543229a257f9c5ba850df135a1d10') not valid;
create or replace function identity.record_recording_birth() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if new.recording_lifecycle_protocol=1 then
  insert into identity.recording_lifecycle_witnesses values(new.id,new.privacy_epoch,new.account_id,1,'birth',null,
   'd7942e43bb8211f37dfd08b4dfb6ac2e1b2543229a257f9c5ba850df135a1d10',transaction_timestamp());
 end if;
 return new;
end $$;
