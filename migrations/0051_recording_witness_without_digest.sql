-- Recording lifecycle witnesses no longer carry an erasure-registry digest.
--
-- 0044 stamped every witness with the SHA-256 of a hand-kept registry manifest and pinned it in a
-- CHECK and in the birth trigger; 0047 had to swap both and re-stamp every witness when Composer
-- added a store. That bought no privacy: erasure completeness is proved by the schema inventory
-- test and by the inventory check inside every Clear, and a witness says only that this root
-- elected the lifecycle for this epoch. Any later personal store needs its own migration and its
-- declaration, nothing more.
--
-- Every existing witness stays valid: the row, its epoch, origin, account and clear operation are
-- unchanged, and the readers now look only for the row. Dropping the column drops its CHECK. The
-- guard trigger refuses updates but does not fire for DDL, so no trigger needs disabling.
--
-- Rollout: apply with the new binary. A process of the previous recipe still selects the dropped
-- column and fails closed (a database error, never an unverified lifecycle) until it is replaced.
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function identity.record_recording_birth() returns trigger language plpgsql set search_path=pg_catalog as $$
begin
 if new.recording_lifecycle_protocol=1 then
  insert into identity.recording_lifecycle_witnesses(universe_id,privacy_epoch,account_id,protocol_version,origin_kind,clear_operation_id,verified_at)
   values(new.id,new.privacy_epoch,new.account_id,1,'birth',null,transaction_timestamp());
 end if;
 return new;
end $$;

-- squawk-ignore ban-drop-column
alter table identity.recording_lifecycle_witnesses drop column registry_sha256;
