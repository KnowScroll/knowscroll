-- Content: shared derived canonical facet lookup, no admission or personal authority.
-- Experience: immutable private per-offer region/coverage constraint, not a public descriptor.
-- Reads: topic+facet exact indexed100+one key lookahead; own epoch/offer exact lookup.
-- Growth: <=16 bindings per current mapping, <=1 private constraint per actual prepared offer.
-- Retention: Content projection survives personal erasure; Experience constraints erase before
-- offers across ALL epochs on full/Clear. Geographic IDs are historical snapshots, not live FKs:
-- Geography erases earlier in the existing registry, and activation independently rechecks it.
-- Old writers cannot activate regional offers or shed inherited constraints (guards below).
-- Rolling downgrade is unsupported: stop incompatible processes before any rollback.
-- No model/job/admission seed or public API bypass.
set local lock_timeout='5s';
set local statement_timeout='60s';

create table content.region_bindings (
  topic_id text not null check(length(topic_id) between 1 and 160),
  facet_id text not null check(length(facet_id) between 1 and 160),
  asset_id uuid not null,
  asset_revision integer not null check(asset_revision>0),
  head_revision integer not null check(head_revision>0),
  primary key(topic_id,facet_id,asset_id,asset_revision),
  foreign key(asset_id,asset_revision,head_revision)
    references content.coverage_revisions(asset_id,asset_revision,revision) on delete restrict
);
create index region_bindings_asset_idx on content.region_bindings(asset_id,asset_revision);

-- Keep the derived lookup in the SAME head transaction, including corrections/retractions.
-- The lookup conveys no truth: readers still validate canonical mapping, document/provenance,
-- current asset head, render support and the actual requested binding before returning metadata.
create function content.refresh_region_bindings() returns trigger language plpgsql as $$
begin
  delete from content.region_bindings where asset_id=new.asset_id and asset_revision=new.asset_revision;
  insert into content.region_bindings(topic_id,facet_id,asset_id,asset_revision,head_revision)
    select b->>'topicId',b->>'facetId',r.asset_id,r.asset_revision,r.revision
    from content.coverage_revisions r cross join lateral jsonb_array_elements(r.mapping->'bindings') b
    where r.asset_id=new.asset_id and r.asset_revision=new.asset_revision and r.revision=new.revision
      and r.status='active' and r.mapping->>'version'='scroll-static-coverage.v1'
      and r.mapping->>'catalogueVersion'='content-concepts.v1' and r.mapping->>'framing'='factual';
  return new;
end;
$$;
create trigger refresh_region_bindings after insert or update on content.coverage_heads
for each row execute function content.refresh_region_bindings();

insert into content.region_bindings(topic_id,facet_id,asset_id,asset_revision,head_revision)
  select b->>'topicId',b->>'facetId',r.asset_id,r.asset_revision,r.revision
  from content.coverage_heads h join content.coverage_revisions r
    on r.asset_id=h.asset_id and r.asset_revision=h.asset_revision and r.revision=h.revision
  cross join lateral jsonb_array_elements(r.mapping->'bindings') b
  where r.status='active' and r.mapping->>'version'='scroll-static-coverage.v1'
    and r.mapping->>'catalogueVersion'='content-concepts.v1' and r.mapping->>'framing'='factual';

-- Required scoped FK on small existing offer inventory; transactional bounded rollout.
-- squawk-ignore require-concurrent-index-creation
create unique index offers_owned_epoch_idx on experience.offers(universe_id,privacy_epoch,id);
create table experience.offer_region_constraints (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check(privacy_epoch>0),
  offer_id uuid not null,
  asset_id uuid not null,
  asset_revision integer not null check(asset_revision>0),
  coverage_head_revision integer not null check(coverage_head_revision>0),
  mapping_sha256 text not null check(mapping_sha256~'^[0-9a-f]{64}$'),
  constraint_payload jsonb not null check(jsonb_typeof(constraint_payload)='object'
    and coalesce(constraint_payload->>'version'='offer-region-constraint.v1',false)
    and octet_length(constraint_payload::text)<=8192),
  primary key(universe_id,offer_id),
  foreign key(universe_id,privacy_epoch,offer_id)
    references experience.offers(universe_id,privacy_epoch,id) on delete restrict,
  foreign key(asset_id,asset_revision,coverage_head_revision)
    references content.coverage_revisions(asset_id,asset_revision,revision) on delete restrict
);
create function experience.guard_region_constraint() returns trigger language plpgsql as $$
begin
  if tg_op='UPDATE' then
    raise exception 'REGION_CONSTRAINT_IMMUTABLE' using errcode='23514';
  end if;
  if (new.constraint_payload->'coverage'->>'assetId',new.constraint_payload->'coverage'->>'assetRevision',
      new.constraint_payload->'coverage'->>'headRevision',new.constraint_payload->'coverage'->>'mappingSha256')
    is distinct from (new.asset_id::text,new.asset_revision::text,new.coverage_head_revision::text,new.mapping_sha256) then
    raise exception 'REGION_CONSTRAINT_IDENTITY' using errcode='23514';
  end if;
  if not exists(select 1 from experience.offers o
    join content.coverage_revisions r on r.asset_id=o.asset_id and r.asset_revision=o.asset_revision
      and r.revision=new.coverage_head_revision and r.mapping_sha256=new.mapping_sha256
    where o.universe_id=new.universe_id and o.privacy_epoch=new.privacy_epoch and o.id=new.offer_id
      and o.asset_id=new.asset_id and o.asset_revision=new.asset_revision and o.mode='vertical'
      and o.descriptor->'relation'->>'kind'='discovery') then
    raise exception 'REGION_CONSTRAINT_IDENTITY' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger guard_region_constraint before insert or update on experience.offer_region_constraints
for each row execute function experience.guard_region_constraint();

-- Mixed old writers cannot create an exposure/binding from a regional offer without the new
-- protocol. The marker is set only after a single-use live-scope permit is consumed by the new
-- adapter; all authority still comes from application Geography/Content/intent checks, not a GUC.
-- set_config(...,true) disappears at COMMIT/ROLLBACK; a pooled connection retains no permit.
create function experience.require_region_activation_protocol() returns trigger language plpgsql as $$
begin
  if exists(select 1 from experience.offer_region_constraints r
      where r.universe_id=new.universe_id and r.privacy_epoch=new.privacy_epoch and r.offer_id=new.offer_id)
    and current_setting('knowscroll.region_activation_v1',true) is distinct from new.offer_id::text then
    raise exception 'REGION_PROTOCOL_REQUIRED' using errcode='23514';
  end if;
  return new;
end;
$$;
create trigger require_region_activation_protocol before insert on experience.offer_activations
for each row execute function experience.require_region_activation_protocol();

-- Old generic vertical navigation must not shed a regional source constraint. Deferred until
-- commit so the new writer can insert offer then its required private child in the same Tx.
-- Nonregional discovery and explicit series/related/variant/return semantics remain unchanged.
create function experience.require_vertical_region_constraint() returns trigger language plpgsql as $$
declare source_region jsonb;
begin
  if new.mode<>'vertical' or new.source_offer_id is null then return new; end if;
  select r.constraint_payload->'region' into source_region from experience.offer_region_constraints r
    where r.universe_id=new.universe_id and r.privacy_epoch=new.privacy_epoch and r.offer_id=new.source_offer_id;
  if source_region is not null and not exists(select 1 from experience.offer_region_constraints r
    where r.universe_id=new.universe_id and r.privacy_epoch=new.privacy_epoch and r.offer_id=new.id
      and r.constraint_payload->'region'=source_region) then
    raise exception 'REGION_CONSTRAINT_REQUIRED' using errcode='23514';
  end if;
  return new;
end;
$$;
create constraint trigger require_vertical_region_constraint after insert on experience.offers
deferrable initially deferred for each row execute function experience.require_vertical_region_constraint();
