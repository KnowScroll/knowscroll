-- #240 connected public commissioning. No root, human approval, grant, principal or enablement seed.
-- World/business/attempt ownership is genuine shared-public ownership; no personal context is accepted.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table content.cutroom_publications (
 id uuid primary key,
 world_id text not null,
 business_run_id uuid not null,
 attempt_id uuid not null unique,
 snapshot_id uuid not null references content.cutroom_chain_snapshots(id),
 snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
 asset_id uuid not null,
 asset_revision integer not null check (asset_revision = 1),
 media_id uuid not null references content.media_objects(id),
 final_run_id text not null check (final_run_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 publication_utf8 text not null check (octet_length(publication_utf8) between 1 and 16384),
 publication_sha256 text not null check (publication_sha256 = encode(sha256(convert_to(publication_utf8,'UTF8')),'hex')),
 created_at timestamptz not null default clock_timestamp(),
 unique(world_id,business_run_id),
 foreign key(world_id,business_run_id,attempt_id) references reasoning.cutroom_attempts(world_id,business_run_id,id),
 foreign key(asset_id,asset_revision) references content.asset_revisions(asset_id,revision)
);

-- These are work/receipt facts, not another outbox, balance, allowance or paid attempt engine.
create table reasoning.cutroom_maintenance (
 attempt_id uuid primary key,
 world_id text not null,
 business_run_id uuid not null,
 next_at timestamptz not null default clock_timestamp(),
 deliveries integer not null default 0 check (deliveries between 0 and 2880),
 recoveries integer not null default 0 check (recoveries between 0 and 3),
 recovered_at timestamptz,
 stopped_at timestamptz,
 lease_id uuid,
 lease_until timestamptz,
 check ((lease_id is null) = (lease_until is null)),
 foreign key(world_id,business_run_id,attempt_id) references reasoning.cutroom_attempts(world_id,business_run_id,id)
);
create index cutroom_maintenance_due on reasoning.cutroom_maintenance(world_id,attempt_id) where stopped_at is null;

-- One stable closed-chain financial report, independent of collection time/publication UUID.
-- Evidence-only holds and later publication settlement use the SAME canonical pool report.
create table reasoning.cutroom_financial_reports (
 id uuid primary key,
 world_id text not null,
 business_run_id uuid not null,
 attempt_id uuid not null,
 snapshot_id uuid not null references content.cutroom_chain_snapshots(id),
 report_utf8 text not null check (octet_length(report_utf8) between 1 and 8192),
 evidence_sha256 text not null check (evidence_sha256 = encode(sha256(convert_to(report_utf8,'UTF8')),'hex')),
 evidence_ref text not null check (evidence_ref ~ '^cutroom-financial:[0-9a-f]{64}$'),
 actual_cents bigint not null check (actual_cents between 0 and 9007199254740991),
 outcome text not null check (outcome in ('completed','refused','stopped','failed','cancelled')),
 final_run_id text not null check (final_run_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 hold_recoveries integer not null default 0 check (hold_recoveries between 0 and 3),
 hold_next_at timestamptz,
 hold_state text not null default 'none' check (hold_state in ('none','pending','recorded','satisfied')),
 hold_evidence_id text check (hold_evidence_id ~ '^[0-9a-f]{64}$'),
 check (hold_state <> 'recorded' or hold_evidence_id is not null),
 unique(attempt_id,evidence_sha256),
 foreign key(world_id,business_run_id,attempt_id) references reasoning.cutroom_attempts(world_id,business_run_id,id)
);

create table reasoning.cutroom_settlements (
 id uuid primary key,
 world_id text not null,
 business_run_id uuid not null,
 attempt_id uuid not null unique,
 publication_id uuid not null unique references content.cutroom_publications(id),
 financial_report_id uuid not null references reasoning.cutroom_financial_reports(id),
 snapshot_id uuid not null references content.cutroom_chain_snapshots(id),
 snapshot_sha256 text not null check (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
 final_run_id text not null check (final_run_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 actual_cents bigint not null check (actual_cents between 0 and 9007199254740991),
 evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
 evidence_ref text not null check (evidence_ref ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$'),
 binding_id uuid not null,
 claimed_at timestamptz not null,
 bound_at timestamptz not null,
 state text not null default 'pending' check (state in ('pending','held','confirmed')),
 foreign key(world_id,business_run_id,attempt_id) references reasoning.cutroom_attempts(world_id,business_run_id,id)
);
create table reasoning.cutroom_settlement_receipts (
 settlement_id uuid primary key references reasoning.cutroom_settlements(id),
 pool_evidence_id text not null check (pool_evidence_id ~ '^[0-9a-f]{64}$'),
 receipt_utf8 text not null check (octet_length(receipt_utf8) between 1 and 8192),
 receipt_sha256 text not null check (receipt_sha256 = encode(sha256(convert_to(receipt_utf8,'UTF8')),'hex')),
 confirmed_at timestamptz not null default clock_timestamp()
);

create function content.cutroom_publication_identity() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from content.cutroom_chain_snapshots s where s.id=new.snapshot_id
   and (s.world_id,s.business_run_id,s.attempt_id,s.snapshot_sha256) =
       (new.world_id,new.business_run_id,new.attempt_id,new.snapshot_sha256)
   and not s.over_ceiling and s.video_kind='candidate')
 then raise check_violation using message='cutroom_publication_identity'; end if;
 return new;
end $$;
create trigger cutroom_publication_identity before insert on content.cutroom_publications
 for each row execute function content.cutroom_publication_identity();
create trigger cutroom_publication_immutable before update or delete on content.cutroom_publications
 for each row execute function reasoning.cutroom_execution_immutable();
create trigger cutroom_settlement_receipt_immutable before update or delete on reasoning.cutroom_settlement_receipts
 for each row execute function reasoning.cutroom_execution_immutable();

create function reasoning.cutroom_settlement_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or (to_jsonb(new)-'state') is distinct from (to_jsonb(old)-'state')
   or old.state='confirmed' or (old.state='held' and new.state='pending')
 then raise check_violation using message='cutroom_settlement_immutable'; end if;
 return new;
end $$;
create trigger cutroom_settlement_guard before update or delete on reasoning.cutroom_settlements
 for each row execute function reasoning.cutroom_settlement_guard();

create function reasoning.cutroom_financial_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or (to_jsonb(new)-array['hold_state','hold_evidence_id','hold_recoveries','hold_next_at']) is distinct from
   (to_jsonb(old)-array['hold_state','hold_evidence_id','hold_recoveries','hold_next_at']) or old.hold_state='satisfied'
   or (old.hold_evidence_id is not null and new.hold_evidence_id is distinct from old.hold_evidence_id)
   or (old.hold_state='recorded' and new.hold_state not in ('recorded','satisfied'))
   or (old.hold_state='pending' and new.hold_state='none')
   or new.hold_recoveries<old.hold_recoveries
   or (new.hold_state in ('recorded','satisfied') and new.hold_next_at is not null)
 then raise check_violation using message='cutroom_financial_immutable'; end if;
 return new;
end $$;
create trigger cutroom_financial_guard before update or delete on reasoning.cutroom_financial_reports
 for each row execute function reasoning.cutroom_financial_guard();

create function reasoning.cutroom_financial_identity() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from content.cutroom_chain_snapshots s where s.id=new.snapshot_id
   and (s.world_id,s.business_run_id,s.attempt_id,s.engine_actual_cents)=
       (new.world_id,new.business_run_id,new.attempt_id,new.actual_cents)
   and s.header_utf8::jsonb->'execution'->'poolReceipt'=new.report_utf8::jsonb->'poolReceipt'
   and s.header_utf8::jsonb->'execution'->>'dispatchId'=new.report_utf8::jsonb->>'dispatchId'
   and s.header_utf8::jsonb->'expected'->>'requestId'=new.report_utf8::jsonb->>'requestId'
   and s.header_utf8::jsonb->'expected'->>'requestSha256'=new.report_utf8::jsonb->>'requestSha256'
   and jsonb_array_length(new.report_utf8::jsonb->'runs')=s.document_count/4
   and not exists(select 1 from jsonb_array_elements(new.report_utf8::jsonb->'runs') with ordinality r(value,n)
     where not exists(select 1 from jsonb_array_elements(s.header_utf8::jsonb->'runs') with ordinality h(run,n)
       join content.cutroom_chain_documents d on d.snapshot_id=s.id and d.run_ordinal=h.n-1 and d.kind='result'
       join content.cutroom_chain_documents c on c.snapshot_id=s.id and c.run_ordinal=h.n-1 and c.kind='record'
       where h.n=r.n and h.run->>'runId'=r.value->>'runId' and d.sha256=r.value->>'resultSha256' and c.sha256=r.value->>'recordSha256'
         and d.body_utf8::jsonb->>'status'=r.value->>'status'
         and d.body_utf8::jsonb->>'costCents'=r.value->>'ownCostCents')))
   or new.report_utf8::jsonb->>'version' is distinct from 'cutroom-financial.v1'
   or new.report_utf8::jsonb->>'actualCents' is distinct from new.actual_cents::text
   or new.report_utf8::jsonb->>'outcome' is distinct from new.outcome
   or new.report_utf8::jsonb->>'finalRunId' is distinct from new.final_run_id
   or new.report_utf8::jsonb->'runs'->-1->>'runId' is distinct from new.final_run_id
   or new.report_utf8::jsonb->'runs'->-1->>'status' is distinct from new.outcome
   or new.report_utf8::jsonb->>'worldId' is distinct from new.world_id
   or new.report_utf8::jsonb->>'businessRunId' is distinct from new.business_run_id::text
   or new.report_utf8::jsonb->>'attemptId' is distinct from new.attempt_id::text
 then raise check_violation using message='cutroom_financial_identity'; end if;
 return new;
end $$;
create trigger cutroom_financial_identity before insert on reasoning.cutroom_financial_reports
 for each row execute function reasoning.cutroom_financial_identity();

create function reasoning.cutroom_settlement_identity() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from content.cutroom_publications p join reasoning.cutroom_financial_reports f
   on f.id=new.financial_report_id where p.id=new.publication_id
   and (p.world_id,p.business_run_id,p.attempt_id,p.snapshot_id,p.snapshot_sha256,p.final_run_id)=
       (new.world_id,new.business_run_id,new.attempt_id,new.snapshot_id,new.snapshot_sha256,new.final_run_id)
   and (f.world_id,f.business_run_id,f.attempt_id,f.evidence_sha256,f.evidence_ref,f.actual_cents,f.outcome,f.final_run_id)=
       (new.world_id,new.business_run_id,new.attempt_id,new.evidence_sha256,new.evidence_ref,new.actual_cents,'completed',new.final_run_id))
 then raise check_violation using message='cutroom_settlement_identity'; end if;
 return new;
end $$;
create trigger cutroom_settlement_identity before insert on reasoning.cutroom_settlements
 for each row execute function reasoning.cutroom_settlement_identity();

create function reasoning.cutroom_maintenance_guard() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' or (new.world_id,new.business_run_id,new.attempt_id) is distinct from
   (old.world_id,old.business_run_id,old.attempt_id) or new.deliveries<old.deliveries or new.recoveries<old.recoveries
   or (old.stopped_at is not null and new is distinct from old)
 then raise check_violation using message='cutroom_maintenance_immutable'; end if;
 return new;
end $$;
create trigger cutroom_maintenance_guard before update or delete on reasoning.cutroom_maintenance
 for each row execute function reasoning.cutroom_maintenance_guard();


-- Neither half of admission/settlement may commit alone, even through a future adapter.
create function content.cutroom_publication_complete() returns trigger language plpgsql as $$
begin
 if not exists(select 1 from reasoning.cutroom_settlements s where s.publication_id=new.id)
 then raise check_violation using message='cutroom_publication_incomplete'; end if;
 return null;
end $$;
create constraint trigger cutroom_publication_complete after insert on content.cutroom_publications
 deferrable initially deferred for each row execute function content.cutroom_publication_complete();
create function reasoning.cutroom_settlement_complete() returns trigger language plpgsql as $$
begin
 if exists(select 1 from reasoning.cutroom_settlements s where s.id=new.id and s.state='confirmed')
   and not exists(select 1 from reasoning.cutroom_settlement_receipts r where r.settlement_id=new.id)
 then raise check_violation using message='cutroom_settlement_incomplete'; end if;
 return null;
end $$;
create constraint trigger cutroom_settlement_complete after insert or update on reasoning.cutroom_settlements
 deferrable initially deferred for each row execute function reasoning.cutroom_settlement_complete();
