set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Shared admission-derived metadata. No personal rows and no changes to immutable documents.
create table content.discovery_revisions (
  asset_id uuid not null,
  asset_revision integer not null,
  summary text not null check (length(summary) <= 2000),
  facets text[] not null default '{}' check (cardinality(facets) <= 16),
  attribution_version text not null default 'admitted-brief-taxonomy.v0',
  search_text tsvector not null,
  primary key (asset_id, asset_revision),
  foreign key (asset_id, asset_revision) references content.asset_revisions(asset_id, revision)
);
create index discovery_search_idx on content.discovery_revisions using gin(search_text);
create index discovery_facets_idx on content.discovery_revisions using gin(facets);
-- Existing shared inventory is bounded at rollout; transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create index asset_revision_language_idx on content.asset_revisions(language, asset_id, revision);
-- Existing shared inventory is bounded at rollout; transactional migrator cannot run CONCURRENTLY.
-- squawk-ignore require-concurrent-index-creation
create index asset_revision_explanation_idx on content.asset_revisions(explanation_unit_id, asset_id, revision);
-- Existing shared inventory is bounded at rollout; lock/statement timeouts bound admission blocking.
-- squawk-ignore require-concurrent-index-creation
create index assets_discovery_idx on content.assets(status, kind, id, revision);
create table content.encounter_topics (
  asset_id uuid not null,
  asset_revision integer not null,
  topic_id text not null check (topic_id ~ '^[a-z0-9][a-z0-9._-]{0,159}$'),
  role text not null check (role in ('primary','supporting','incidental')),
  weight double precision not null check (weight > 0 and weight <= 1),
  primary key(asset_id, asset_revision, topic_id),
  foreign key(asset_id, asset_revision) references content.discovery_revisions(asset_id, asset_revision)
);
create index encounter_topic_lookup_idx on content.encounter_topics(topic_id, asset_id, asset_revision);
-- The only v0 taxonomy mapping is code-owned from the actual approved briefs. No title classifier.
create function content.project_discovery_revision() returns trigger language plpgsql as $$
declare synopsis text;
begin
  synopsis := left(coalesce(new.document->>'summary', new.document->>'dek', ''),2000);
  insert into content.discovery_revisions(asset_id,asset_revision,summary,facets,search_text)
    values(new.asset_id,new.revision,synopsis,'{}'::text[],to_tsvector('simple',new.title || ' ' || synopsis));
  return new;
end $$;
create trigger project_discovery_revision after insert on content.asset_revisions for each row execute function content.project_discovery_revision();
insert into content.discovery_revisions(asset_id,asset_revision,summary,facets,search_text)
  select asset_id,revision,left(coalesce(document->>'summary',document->>'dek',''),2000),
    '{}'::text[],
    to_tsvector('simple',title || ' ' || left(coalesce(document->>'summary',document->>'dek',''),2000))
  from content.asset_revisions;

create table content.series_units (
  series_id text not null check (length(series_id) between 1 and 160),
  series_revision integer not null check (series_revision >= 1),
  part integer not null check (part between 1 and 99),
  asset_id uuid not null,
  asset_revision integer not null,
  authority_reference text not null check (length(authority_reference) between 1 and 240),
  primary key(series_id,series_revision,part),
  unique(series_id,series_revision,asset_id,asset_revision),
  foreign key(asset_id,asset_revision) references content.discovery_revisions(asset_id,asset_revision)
);
create index series_unit_asset_idx on content.series_units(asset_id,asset_revision,series_id,series_revision);
create table content.continuity_links (
  id uuid primary key,
  revision integer not null check (revision >= 1),
  source_asset_id uuid not null,
  source_asset_revision integer not null,
  target_asset_id uuid not null,
  target_asset_revision integer not null,
  direction text not null check (direction in ('previous','next','related')),
  relation jsonb not null check (jsonb_typeof(relation)='object' and relation ? 'kind' and octet_length(relation::text)<=1024),
  strength double precision not null check (strength >= 0 and strength <= 1),
  authority_reference text not null check (length(authority_reference) between 1 and 240),
  active boolean not null default true,
  foreign key(source_asset_id,source_asset_revision) references content.discovery_revisions(asset_id,asset_revision),
  foreign key(target_asset_id,target_asset_revision) references content.discovery_revisions(asset_id,asset_revision),
  check ((source_asset_id,source_asset_revision) <> (target_asset_id,target_asset_revision)),
  check ((direction='related' and relation->>'kind'='related_move') or (direction<>'related' and relation->>'kind'='series_step'))
);
create unique index continuity_active_slot_idx on content.continuity_links(source_asset_id,source_asset_revision,direction) where active;

-- Admission attribution cannot multiply concept weight, even through a direct SQL adapter.
create function content.check_topic_weights() returns trigger language plpgsql as $$
begin
  perform 1 from content.discovery_revisions where asset_id=new.asset_id and asset_revision=new.asset_revision for update;
  if (select count(*)>16 or sum(weight)>1.000000000001 from content.encounter_topics where asset_id=new.asset_id and asset_revision=new.asset_revision) then
    raise exception 'CONTENT_ATTRIBUTION_INVALID';
  end if;
  return new;
end $$;
create trigger check_topic_weights after insert or update on content.encounter_topics for each row execute function content.check_topic_weights();

-- Source authority is a completed approved run/script/media digest+size import, never an
-- arbitrary editorial's explanation ID. Generated Scroll attribution awaits producer-owned
-- published-job lineage in 0015; its source is not installed by this bounded slice.
create function content.approved_topic(asset uuid, rev integer) returns text language sql stable as $$
  select case r.explanation_unit_id
    when 'legacy-cutroom-seasons-v5' then 'earth.seasons'
    when 'legacy-cutroom-tides-v4' then 'earth.tides'
    when 'legacy-cutroom-greenhouse' then 'earth.greenhouse-effect' end
  from content.asset_revisions r
  where r.asset_id=asset and r.revision=rev and r.provenance_kind='cutroom_import' and exists (
    select 1 from content.reel_imports i join content.media_objects m on m.id=i.media_id
    where i.asset_id=asset and i.asset_revision=rev and not i.fixture and (
      (i.script_name='seasons-v5' and i.run_id='a3e69f72-0222-41c8-abd1-bf2d7f5cc9a0' and m.sha256='7e851851000330f7c00001e1b06cddff803b3c4be28a0be4d80231aeb476ac69' and m.size_bytes=16006181 and r.explanation_unit_id='legacy-cutroom-seasons-v5') or
      (i.script_name='tides-v4' and i.run_id='8620f77d-f2ad-4297-ae9c-e6529b6d001c' and m.sha256='9df78130d0bcd9d9bd8434157c5a354586a3a60d795a348d5f8c5f099c05eba8' and m.size_bytes=7789286 and r.explanation_unit_id='legacy-cutroom-tides-v4') or
      (i.script_name='greenhouse' and i.run_id='6a12af96-51ce-4e08-8e29-d8bc498c4c53' and m.sha256='8141851517b5c03e5b57ff1151280caca698dfc95d2aa724166440361a38aba4' and m.size_bytes=11954735 and r.explanation_unit_id='legacy-cutroom-greenhouse')))
$$;
create function content.project_approved_topic() returns trigger language plpgsql as $$
declare topic text; asset uuid; rev integer;
begin
  asset:=new.asset_id;
  if tg_table_name='reel_imports' then rev:=new.asset_revision; else rev:=new.revision; end if;
  topic:=content.approved_topic(asset,rev);
  if topic is not null then
    update content.discovery_revisions set facets=array[topic] where asset_id=asset and asset_revision=rev;
    insert into content.encounter_topics values(asset,rev,topic,'primary',1) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger project_import_topic after insert on content.reel_imports for each row execute function content.project_approved_topic();
update content.discovery_revisions d set facets=array[content.approved_topic(d.asset_id,d.asset_revision)] where content.approved_topic(d.asset_id,d.asset_revision) is not null;
insert into content.encounter_topics select asset_id,asset_revision,facets[1],'primary',1 from content.discovery_revisions where cardinality(facets)=1;
