-- #674 (slice 5.1) Reels count toward formation (D-421).
-- Owner: modules/content (shared, authoritative). No table, column or index is added: a Reel's coverage is one more
-- `content.coverage_revisions` / `content.coverage_heads` row for the Reel's asset revision, and the observed coverage of a
-- Reel reuses the personal-context and evidence tables a Scroll's does.
--
-- What this adds is one guard. A coverage mapping names its policy in `mapping.version`: a Scroll's is
-- `scroll-static-coverage.v1`, a Reel's is `reel-static-coverage.v1`. The derived region lookup
-- (`content.refresh_region_bindings`, 0037) keeps only the first, so a Reel is never listed as a Scroll of a place: a Reel
-- reaches a region only as the twin of a Scroll, under the Scroll's coverage (D-404). The trigger below makes that a rule of
-- the data and not only of the writers: a revision of coverage whose policy does not match the kind of its asset is refused,
-- so neither an old writer nor a fixture can give a Reel a Scroll's mapping (and with it a place of its own) or the reverse.
-- A retraction carries the mapping it retracts, so it keeps the policy.
--
-- Query shapes: unchanged. One primary-key read of `content.assets` per inserted revision.
-- Growth: none (a trigger). Retention and erasure: unchanged; coverage is shared content, never personal data.
-- Lock order: unchanged. The trigger takes no lock beyond the row it reads.
-- Rollout: additive. An older writer never writes a Reel's mapping, and the trigger accepts everything it writes. Once a Reel
-- has coverage and a reader has watched it, an older API or worker cannot read the Reel's certificate (its schema has no
-- `requiredSpans`), so rolling them back after that is unsupported, as for 0037 and 0107.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create function content.guard_coverage_kind() returns trigger language plpgsql as $$
declare
  asset_kind text;
begin
  select kind into asset_kind from content.assets where id = new.asset_id;
  if (asset_kind = 'reel') is distinct from (new.mapping ->> 'version' = 'reel-static-coverage.v1') then
    raise exception using message = 'CONTENT_COVERAGE_KIND_MISMATCH', errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger coverage_kind_guard before insert on content.coverage_revisions
for each row execute function content.guard_coverage_kind();
