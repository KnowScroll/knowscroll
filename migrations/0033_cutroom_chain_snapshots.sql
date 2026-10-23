-- #240 Content-owned immutable sanitized chain evidence; never money, media or approval.
-- Query: exact snapshot/digest or observation; <=33 headers and one <=8-document set.
-- Growth: <=32 snapshots/attempt, <=2MiB documents +8KiB header each; no eviction/seed.
-- Shared public production metadata survives personal erasure; no personal FK/cascade.
-- Additive/default-unmounted rollout. Existing C1 pending intents and pool ledger stay unchanged.
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create table content.cutroom_chain_snapshots (
 id uuid primary key,
 world_id text not null check (world_id in ('dev','stage')),
 business_run_id uuid not null,
 attempt_id uuid not null references reasoning.cutroom_execution(attempt_id),
 observation_id uuid not null unique,
 snapshot_ordinal integer not null check (snapshot_ordinal between 1 and 32),
 projection_version text not null check (projection_version = 'cutroom-chain-snapshot.v1'),
 header_utf8 text not null check (octet_length(header_utf8) between 1 and 8192),
 snapshot_sha256 text not null check (snapshot_sha256 = encode(sha256(convert_to(header_utf8,'UTF8')),'hex')),
 document_count integer not null check (document_count in (4,8)),
 total_document_bytes integer not null check (total_document_bytes between 1 and 2097152),
 sealed_validation_time_ms bigint not null check (sealed_validation_time_ms between 0 and 9007199254740991),
 engine_actual_cents bigint not null check (engine_actual_cents between 0 and 9007199254740991),
 over_ceiling boolean not null,
 video_kind text not null check (video_kind in ('candidate','unavailable')),
 unique(attempt_id,snapshot_ordinal), unique(attempt_id,snapshot_sha256),
 foreign key(world_id,business_run_id,attempt_id) references reasoning.cutroom_attempts(world_id,business_run_id,id),
 foreign key(world_id,business_run_id) references content.reel_commissions(world_id,business_run_id),
 foreign key(attempt_id,observation_id) references reasoning.cutroom_observations(attempt_id,id)
);
create table content.cutroom_chain_documents (
 snapshot_id uuid not null references content.cutroom_chain_snapshots(id),
 run_ordinal integer not null check (run_ordinal in (0,1)),
 kind text not null check (kind in ('opening','result','record','closing')),
 body_utf8 text not null check (octet_length(body_utf8) between 1 and 262144),
 byte_length integer not null check (byte_length = octet_length(body_utf8)),
 sha256 text not null check (sha256 = encode(sha256(convert_to(body_utf8,'UTF8')),'hex')),
 primary key(snapshot_id,run_ordinal,kind)
);
create function content.cutroom_chain_immutable() returns trigger language plpgsql as $$
begin raise check_violation using message = 'cutroom_chain_immutable'; end $$;
create trigger cutroom_chain_snapshot_immutable before update or delete on content.cutroom_chain_snapshots
 for each row execute function content.cutroom_chain_immutable();
create trigger cutroom_chain_document_immutable before update or delete on content.cutroom_chain_documents
 for each row execute function content.cutroom_chain_immutable();
create function content.cutroom_chain_complete() returns trigger language plpgsql as $$
declare sid uuid; expected_count integer; expected_bytes integer; actual_count bigint;
 actual_bytes bigint; first_count bigint; second_count bigint;
begin
 if tg_table_name = 'cutroom_chain_snapshots' then sid := new.id; else sid := new.snapshot_id; end if;
 select document_count,total_document_bytes into expected_count,expected_bytes
 from content.cutroom_chain_snapshots where id=sid;
 select count(*),coalesce(sum(byte_length),0),count(*) filter(where run_ordinal=0),
 count(*) filter(where run_ordinal=1) into actual_count,actual_bytes,first_count,second_count
 from content.cutroom_chain_documents where snapshot_id=sid;
 if expected_count is null or actual_count<>expected_count or actual_bytes<>expected_bytes
 or actual_bytes>2097152 or first_count<>4
 or second_count<>(case when expected_count=8 then 4 else 0 end)
 then raise check_violation using message = 'cutroom_chain_incomplete'; end if;
 return null;
end $$;
-- Deferred verification permits the one atomic header+documents insert, never a partial commit.
create constraint trigger cutroom_chain_snapshot_complete after insert on content.cutroom_chain_snapshots
 deferrable initially deferred for each row execute function content.cutroom_chain_complete();
create constraint trigger cutroom_chain_document_complete after insert on content.cutroom_chain_documents
 deferrable initially deferred for each row execute function content.cutroom_chain_complete();
