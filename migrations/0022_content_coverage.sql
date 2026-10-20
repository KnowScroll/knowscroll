-- Content-owned authoritative shared coverage sidecars, no personal rows or admission seed.
-- One immutable bounded mapping revision per semantic correction/retraction; exact asset revision
-- FK. Current heads serve exact bounded reads; canonical asset/head SHARE locks fence consumers.
-- Growth: one row/change and one head/asset revision. Retain history; no personal erasure.
-- Rollout: older code ignores these stores; source-approved admission is separately composed.
set local lock_timeout='5s';
set local statement_timeout='60s';
create table content.coverage_revisions (
  asset_id uuid not null,
  asset_revision integer not null,
  revision integer not null check(revision>=1),
  status text not null check(status in('active','retracted')),
  mapping_sha256 text not null check(mapping_sha256~'^[0-9a-f]{64}$'),
  command_sha256 text not null check(command_sha256~'^[0-9a-f]{64}$'),
  semantic_review_reference text not null check(length(semantic_review_reference) between 1 and 240),
  mapping jsonb not null check(jsonb_typeof(mapping)='object' and octet_length(mapping::text)<=32768),
  primary key(asset_id,asset_revision,revision),
  foreign key(asset_id,asset_revision) references content.asset_revisions(asset_id,revision) on delete restrict
);
create table content.coverage_heads (
  asset_id uuid not null,
  asset_revision integer not null,
  revision integer not null check(revision>=1),
  primary key(asset_id,asset_revision),
  foreign key(asset_id,asset_revision,revision) references content.coverage_revisions(asset_id,asset_revision,revision) on delete restrict
);
create function content.coverage_revision_immutable() returns trigger language plpgsql as $$
begin
  raise exception using message='CONTENT_COVERAGE_REVISION_IMMUTABLE',errcode='23514';
end;
$$;
create trigger coverage_revision_immutable before update or delete on content.coverage_revisions
for each row execute function content.coverage_revision_immutable();
create function content.coverage_head_monotonic() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    raise exception using message='CONTENT_COVERAGE_HEAD_IMMUTABLE',errcode='23514';
  end if;
  if (tg_op='INSERT' and new.revision<>1) or
     (tg_op='UPDATE' and (new.asset_id<>old.asset_id or new.asset_revision<>old.asset_revision or new.revision<>old.revision+1)) then
    raise exception using message='CONTENT_COVERAGE_HEAD_STALE',errcode='23514';
  end if;
  return new;
end;
$$;
create trigger coverage_head_monotonic before insert or update or delete on content.coverage_heads
for each row execute function content.coverage_head_monotonic();
