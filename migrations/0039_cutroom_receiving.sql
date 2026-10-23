-- #373 CF62 receiving. No root, enablement, script approval, paid claim or pool identity seed.
-- Content owns one world root and immutable handoff/admission receipts; no personal/financial FK.
-- Bounded world/UUID keyset discovery uses the partial pending index; exact replay uses the PK.
-- Public provenance/receipts survive personal erasure. Mutable lease/due/counters are finite
-- delivery metadata, not another work outbox. Admission expires720elapsed hours after the
-- immutable origin claim. Explicit cleanup of retained public rows/media is not shipped.
-- Older processes ignore these additive tables; both process and DB enablement default off.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table content.cutroom_receiving_state (
 world_id text primary key check (world_id in ('dev','stage')),
 enabled boolean not null default false,
 generation integer not null check (generation > 0)
);
create function content.cutroom_receiving_state_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or new.world_id<>old.world_id or new.generation<old.generation
   or (new.enabled is distinct from old.enabled and new.generation<=old.generation)
 then raise check_violation using message='cutroom_receiving_state_identity'; end if;
 return new;
end $$;
create trigger cutroom_receiving_state_guard before update or delete on content.cutroom_receiving_state
 for each row execute function content.cutroom_receiving_state_guard();

create table content.cutroom_receive_receipts (
 handoff_id uuid primary key,
 world_id text not null references content.cutroom_receiving_state(world_id),
 origin_world text not null check (origin_world in ('dev','stage') and origin_world<>world_id),
 origin_publication_id uuid not null,
 generation integer not null check (generation>0),
 payload_utf8 text not null check (octet_length(payload_utf8) between 1 and 100000),
 payload_sha256 text not null check (payload_sha256=encode(sha256(convert_to(payload_utf8,'UTF8')),'hex')),
 original_claimed_at timestamptz not null,
 hard_deadline timestamptz not null check (hard_deadline=original_claimed_at+interval '720 hours'),
 state text not null default 'pending' check (state in ('pending','admitted','expired')),
 next_at timestamptz not null default clock_timestamp(),
 deliveries integer not null default 0 check (deliveries between 0 and 2880),
 recoveries integer not null default 0 check (recoveries between 0 and 3),
 lease_id uuid,
 lease_until timestamptz,
 receipt_id uuid unique,
 receipt_utf8 text check (octet_length(receipt_utf8) between 1 and 8192),
 receipt_sha256 text check (receipt_sha256=encode(sha256(convert_to(receipt_utf8,'UTF8')),'hex')),
 asset_id uuid,
 asset_revision integer,
 media_id uuid references content.media_objects(id),
 admitted_at timestamptz,
 check ((lease_id is null)=(lease_until is null)),
 check ((state='admitted')=(receipt_id is not null and receipt_utf8 is not null and receipt_sha256 is not null and asset_id is not null and asset_revision is not null and media_id is not null and admitted_at is not null)),
 check (state='admitted' or (receipt_id is null and receipt_utf8 is null and receipt_sha256 is null and asset_id is null and asset_revision is null and media_id is null and admitted_at is null)),
 unique(origin_world,origin_publication_id,world_id),
 foreign key(asset_id,asset_revision) references content.asset_revisions(asset_id,revision)
);
create index cutroom_receive_due on content.cutroom_receive_receipts(world_id,handoff_id) where state='pending';
create function content.cutroom_receive_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or old.state<>'pending' or
   (new.handoff_id,new.world_id,new.origin_world,new.origin_publication_id,new.generation,new.payload_utf8,new.payload_sha256,new.original_claimed_at,new.hard_deadline)
   is distinct from
   (old.handoff_id,old.world_id,old.origin_world,old.origin_publication_id,old.generation,old.payload_utf8,old.payload_sha256,old.original_claimed_at,old.hard_deadline)
   or new.deliveries<old.deliveries or new.recoveries<old.recoveries
 then raise check_violation using message='cutroom_receive_immutable'; end if;
 return new;
end $$;
create trigger cutroom_receive_guard before update or delete on content.cutroom_receive_receipts
 for each row execute function content.cutroom_receive_guard();
create function content.cutroom_receive_identity() returns trigger language plpgsql as $$
declare p jsonb;
begin
 p:=new.payload_utf8::jsonb;
 if p->'document'->>'fixture'='true' and current_database() !~ '^(ks_it_|knowscroll_fixture_)'
 then raise check_violation using message='fixture_reel_database_refused'; end if;
 if p->>'version' is distinct from 'cutroom-receive.v1'
   or p->>'handoffId' is distinct from new.handoff_id::text
   or p->>'targetWorld' is distinct from new.world_id
   or p->>'originWorld' is distinct from new.origin_world
   or p->>'publicationId' is distinct from new.origin_publication_id::text
   or (p->'settlement'->>'claimedAt')::timestamptz is distinct from new.original_claimed_at
   or p->>'receiverChargeCents' is distinct from '0'
 then raise check_violation using message='cutroom_receive_identity'; end if;
 if new.state='admitted' and not exists(
   select 1 from content.asset_revisions r join content.assets a on a.id=r.asset_id
   join content.media_objects m on m.id=new.media_id
   where r.asset_id=new.asset_id and r.revision=new.asset_revision and a.kind='reel'
     and r.document_version='reel-document.v1' and r.document=p->'document'
     and r.document_sha256=p->>'documentSha256'
     and m.sha256=p->'media'->>'sha256' and m.logical_key=p->'media'->>'key'
     and m.size_bytes=(p->'media'->>'sizeBytes')::bigint)
 then raise check_violation using message='cutroom_receive_admission'; end if;
 if new.state='admitted' and (
   new.asset_revision<>1 or new.asset_id::text is distinct from p->'document'->>'assetId'
   or new.receipt_utf8::jsonb->>'version' is distinct from 'cutroom-receive-receipt.v1'
   or new.receipt_utf8::jsonb->>'receiptId' is distinct from new.receipt_id::text
   or new.receipt_utf8::jsonb->>'handoffId' is distinct from new.handoff_id::text
   or new.receipt_utf8::jsonb->>'payloadSha256' is distinct from new.payload_sha256
   or new.receipt_utf8::jsonb->>'targetWorld' is distinct from new.world_id
   or new.receipt_utf8::jsonb->>'assetId' is distinct from new.asset_id::text
   or new.receipt_utf8::jsonb->>'assetRevision' is distinct from new.asset_revision::text
   or new.receipt_utf8::jsonb->>'mediaSha256' is distinct from p->'media'->>'sha256'
   or new.receipt_utf8::jsonb->>'mediaBytes' is distinct from p->'media'->>'sizeBytes'
   or new.receipt_utf8::jsonb->>'receiverChargeCents' is distinct from '0'
   or not exists(select 1 from content.cutroom_receiving_state s where s.world_id=new.world_id and s.enabled
      and s.generation::text=new.receipt_utf8::jsonb->>'generation')
   or new.hard_deadline<=clock_timestamp())
 then raise check_violation using message='cutroom_receive_receipt_identity'; end if;
 return new;
end $$;
create trigger cutroom_receive_identity before insert or update on content.cutroom_receive_receipts
 for each row execute function content.cutroom_receive_identity();
