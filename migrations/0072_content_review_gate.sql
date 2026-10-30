-- #472 (v3 S-1e) The operator review gate for library v2 Scrolls (D-138): a produced v2 library Scroll is stored but
-- held until an operator reads it and releases it.
--
-- Owner: content. Authoritative. Shared content, not personal data: nothing here has a universe_id or an account
-- column, and nothing is in the erasure registry. `decided_by` is the operator's shell user (`cli:<name>`), never a
-- person of the product.
-- Query shapes: the held revisions (partial index), one revision's state by its key (the primary key), and the
-- exclusion test every exact-revision read makes ("is this revision released?", one primary-key probe).
-- Locking: release and reject take the asset's content advisory lock, the same one admission takes, then this row.
-- Growth: one row per held v2 library revision. Retention: kept as the audit of who released or rejected what, when.
-- Rollout: additive. Old processes never write v2 library revisions, so they never read a row here. A held asset has
-- status 'held', which every existing read already treats as "not admitted".

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 'held': the asset exists only because its first revision is held; no revision of it has been served yet. An asset
-- with a served revision keeps status 'admitted' and its current revision unchanged while a newer one is held.
-- Only widens the allowed statuses, so every existing row already satisfies the replacement. NOT VALID still
-- enforces every new write and avoids a table scan under the lock the replacement holds (as with 0014 and 0026).
-- squawk-ignore ban-drop-constraint
alter table content.assets drop constraint assets_status_check;
alter table content.assets
  add constraint assets_status_check check (status in ('admitted', 'held', 'withdrawn')) not valid;

create table content.revision_reviews (
  asset_id uuid not null,
  revision integer not null,
  state text not null,
  held_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  reason text,
  constraint revision_reviews_pkey primary key (asset_id, revision),
  constraint revision_reviews_revision_fkey foreign key (asset_id, revision)
    references content.asset_revisions (asset_id, revision) on delete restrict,
  constraint revision_reviews_state_check check (state in ('held', 'released', 'rejected')),
  -- A held revision has no decision; a released or rejected one records when and by whom.
  constraint revision_reviews_decision_check
    check ((state = 'held') = (decided_at is null) and (state = 'held') = (decided_by is null)),
  constraint revision_reviews_decided_by_check
    check (decided_by is null or char_length(decided_by) between 1 and 64),
  constraint revision_reviews_reason_check
    check ((state = 'rejected') = (reason is not null) and (reason is null or char_length(reason) between 1 and 500))
);

comment on table content.revision_reviews is 'The review gate for library v2 Scrolls: held until an operator releases the revision, or rejected. A revision with no row here was never under review.';

create index revision_reviews_held on content.revision_reviews (asset_id) where state = 'held';
