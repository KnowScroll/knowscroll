-- #745 Covers in the feed: what happened to a Scroll offer that Explore showed as a cover. Owner: modules/experience.
--
-- Role: routing state, never reading evidence. A row says a cover was passed (moved past without opening, with a coarse band of
-- how long it was on screen and how it was left) or opened (with how long its cover was on screen before the tap, clamped on
-- the database clock between the offer's creation and its activation). Nothing in ranking, evidence, activity, formation or the
-- Universe reads it in this release; it is kept for the next step's policy and its measures.
-- Writes: the "more covers" open and an offer activation insert rows in their own command transaction, and only while the
-- person's recording is on and the offer was made at that same recording generation (`recording_offer_origins`). Paused, a
-- report is dropped, never stored. One row per offer: a pass never overwrites an open; an open replaces an earlier pass of the
-- same offer (the person went back up to a cover and opened it).
-- Reads: the person's export; account erasure and Clear; the prune job's probe `where expires_at <= now()` on
-- `cover_outcomes_expiry`, then a delete by primary key under the person's own scope.
-- Growth: at most one row per offer shown as a cover, and an offer exists only for a navigation command. Bounded by the
-- 30-day life.
-- Retention: 30 days. `expires_at` is set at insert, the CHECK caps it, and `experience.prune-cover-outcomes` deletes expired
-- rows every thirty minutes. Real deletion, not a read expiry.
-- Erasure: account erasure and Clear delete every row of the person, before the offers it references.
-- Lock order: written under the personal root with the command's other rows, after the offer it names.
-- Rollout: a new, empty table. Older processes never read or write it.
set local lock_timeout='5s';
set local statement_timeout='60s';
create table experience.cover_outcomes (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  offer_id uuid not null,
  asset_id uuid not null,
  asset_revision integer not null check (asset_revision >= 1),
  outcome text not null check (outcome in ('passed', 'opened')),
  on_screen text check (on_screen in ('under_1_5s', '1_5s_to_5s', 'over_5s')),
  way text check (way in ('next_cover', 'more_covers', 'left')),
  cover_ms integer check (cover_ms between 0 and 900000),
  recorded_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (universe_id, offer_id),
  foreign key (universe_id, privacy_epoch, offer_id) references experience.offers (universe_id, privacy_epoch, id) on delete restrict,
  check (outcome <> 'passed' or (on_screen is not null and way is not null and cover_ms is null)),
  check (outcome <> 'opened' or (cover_ms is not null and on_screen is null and way is null)),
  check (expires_at > recorded_at and expires_at <= recorded_at + interval '30 days')
);
-- The table is created empty in this same transaction, so building its index locks nothing anyone else uses.
-- squawk-ignore require-concurrent-index-creation
create index cover_outcomes_expiry on experience.cover_outcomes (expires_at);
