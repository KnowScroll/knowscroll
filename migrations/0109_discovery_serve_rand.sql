-- #674 (slice 1.2) Content discovery serves a rotating sample, not the lowest asset ids (D-408). Owner: modules/content.
--
-- `serve_rand` is a stable random key per revision of the discovery projection, in [0, 1). Retrieval orders each lane by it
-- from a cursor that the decision seed picks, so two people (and two decisions) see different slices of a large library, and
-- no UUID order decides who is offered what. It is derived, shared and has no personal content. A revision's key never
-- changes: the projection trigger of 0016 inserts without it and the default fills it.
--
-- Query shapes: the general lane reads `serve_rand >= cursor order by serve_rand limit n` and, to wrap round,
-- `serve_rand < cursor order by serve_rand limit n`, each an index range scan that joins the asset's current revision;
-- the topic lane orders the revisions of a topic by it. Index `discovery_serve_rand_idx`.
-- Growth: one double precision per revision, one index entry per revision. Retention and erasure: as the projection (shared,
-- retained, no personal erasure).
-- Rollout: an older writer inserts revisions without the column and the default fills it, so no writer has to change. An older
-- reader ignores it. Retrieval before this migration ordered by asset id; nothing stored depends on retrieval order (a
-- decision freezes its candidates), so no decision replays differently.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A volatile default is evaluated once per existing row, which is what each revision needs. The projection holds one row per
-- admitted revision and the rewrite is bounded by the lock and statement timeouts above.
-- squawk-ignore adding-field-with-default
alter table content.discovery_revisions add column serve_rand double precision not null default random();
alter table content.discovery_revisions
  add constraint discovery_serve_rand_check check (serve_rand >= 0 and serve_rand < 1) not valid;
-- squawk-ignore constraint-missing-not-valid
alter table content.discovery_revisions validate constraint discovery_serve_rand_check;
-- squawk-ignore require-concurrent-index-creation
create index discovery_serve_rand_idx on content.discovery_revisions(serve_rand, asset_id, asset_revision);
