-- Experience: a regional offer may be the Reel twin of the Scroll whose coverage binds the region (#709, D-404).
-- Role: replaces the identity guard of experience.offer_region_constraints only; no table, column or index changes.
-- The constraint row still names the covering Scroll (asset, revision, coverage head, mapping hash). The offer it guards
-- is that Scroll, as before, or a Reel whose stored revision shares the Scroll revision's explanation unit (its format
-- twin). Coverage stays a Scroll fact: a Reel never gains a binding, a coverage head or a facet of its own here.
-- Query shape: one offer row by primary key, one coverage revision by key, two asset revisions by key.
-- Growth: none. Retention and erasure: unchanged (rows erase with their offers as in 0037).
-- Rollout: older writers only ever insert Scroll-identical rows, which this guard still accepts unchanged. A Reel row is
-- written only by the new API. Older API code refuses to read a regional offer whose coverage names another asset, so
-- once a Reel row exists a rolling downgrade is unsupported, as for 0037: stop older processes before any rollback.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function experience.guard_region_constraint() returns trigger language plpgsql as $$
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
    join content.coverage_revisions r on r.asset_id=new.asset_id and r.asset_revision=new.asset_revision
      and r.revision=new.coverage_head_revision and r.mapping_sha256=new.mapping_sha256
    where o.universe_id=new.universe_id and o.privacy_epoch=new.privacy_epoch and o.id=new.offer_id
      and o.mode='vertical' and o.descriptor->'relation'->>'kind'='discovery'
      and (
        (o.asset_id=new.asset_id and o.asset_revision=new.asset_revision
          and exists(select 1 from content.assets covering where covering.id=new.asset_id and covering.kind='scroll'))
        or exists(select 1
          from content.asset_revisions covered
          join content.assets covered_asset on covered_asset.id=covered.asset_id and covered_asset.kind='scroll'
          join content.asset_revisions twin on twin.explanation_unit_id=covered.explanation_unit_id
          join content.assets twin_asset on twin_asset.id=twin.asset_id and twin_asset.kind='reel'
          where covered.asset_id=new.asset_id and covered.revision=new.asset_revision
            and twin.asset_id=o.asset_id and twin.revision=o.asset_revision)
      )) then
    raise exception 'REGION_CONSTRAINT_IDENTITY' using errcode='23514';
  end if;
  return new;
end;
$$;
