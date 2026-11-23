-- #791 Removing the Scrolls of the retired document formats (D-437). Owner: modules/content (shared, authoritative).
-- No table, column or index is added. Three guard functions change their body; their triggers are untouched.
--
-- Why. Coverage revisions, coverage heads and release risk raises are append-only: their triggers refuse every update and
-- every delete, with no exemption (0022, 0115). A library Scroll in `scroll-document.v1` or `scroll-document.v2` has coverage,
-- and the foreign keys to its revision are `on delete restrict`, so no such revision can be removed while the guards stand.
-- The owner asked for every v1 and v2 Scroll to leave dev (23 Nov), and `content cleanup-old-scrolls` is the one writer that
-- does it. The guards now let a DELETE through when, and only when, both of these hold:
--   1. the transaction set `knowscroll.old_scroll_cleanup` to `v1` with `set_config(..., true)` (transaction-local, so a
--      pooled connection keeps no permit after COMMIT or ROLLBACK, the pattern of `knowscroll.region_activation_v1`, 0037); and
--   2. the row's asset revision is stored in `content.asset_revisions` with `document_version` `scroll-document.v1` or
--      `scroll-document.v2`.
-- A delete of the coverage of a `scroll-document.v3` revision or of a Reel, a delete with no setting, and every update are
-- refused exactly as before. The setting is not authority by itself: the operator command refuses in `stage` and `production`
-- before it opens a transaction, and the rows it may remove are only those of the retired formats.
--
-- Query shapes: one primary-key read of `content.asset_revisions` per deleted guarded row, and only while the setting is on.
-- Growth, retention and erasure: unchanged; coverage is shared content, never personal data.
-- Lock order: unchanged. The helper takes no lock beyond the row it reads.
-- Rollout: additive. An older process never sets the setting, so for it the guards refuse as before. The command is in the
-- worker release that carries this migration; nothing else reads the setting.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- True while this transaction runs the cleanup and the revision is of a retired format.
create function content.old_scroll_cleanup_allows(target_asset uuid, target_revision integer) returns boolean
language sql stable as $$
  select current_setting('knowscroll.old_scroll_cleanup', true) is not distinct from 'v1'
    and exists (
      select 1 from content.asset_revisions
      where asset_id = target_asset and revision = target_revision
        and document_version in ('scroll-document.v1', 'scroll-document.v2'));
$$;

create or replace function content.coverage_revision_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and content.old_scroll_cleanup_allows(old.asset_id, old.asset_revision) then
    return old;
  end if;
  raise exception using message='CONTENT_COVERAGE_REVISION_IMMUTABLE',errcode='23514';
end;
$$;

create or replace function content.coverage_head_monotonic() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' then
    if content.old_scroll_cleanup_allows(old.asset_id, old.asset_revision) then
      return old;
    end if;
    raise exception using message='CONTENT_COVERAGE_HEAD_IMMUTABLE',errcode='23514';
  end if;
  if (tg_op='INSERT' and new.revision<>1) or
     (tg_op='UPDATE' and (new.asset_id<>old.asset_id or new.asset_revision<>old.asset_revision or new.revision<>old.revision+1)) then
    raise exception using message='CONTENT_COVERAGE_HEAD_STALE',errcode='23514';
  end if;
  return new;
end;
$$;

create or replace function content.release_risk_raise_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and content.old_scroll_cleanup_allows(old.asset_id, old.revision) then
    return old;
  end if;
  raise exception using message = 'CONTENT_RELEASE_RAISE_IMMUTABLE', errcode = '23514';
end;
$$;
