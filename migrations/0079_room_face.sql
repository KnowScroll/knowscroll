-- #490 (v3 R-4) Every room has a face, and painted backdrops within $1 (D-166, D-170, D-171): the kit a room wears
-- (closed-vocabulary JSON, proposed by a model, reviewed by an operator), the ledger of every paid image attempt, and the
-- painted backdrops those attempts made, each reviewed before any member sees it.
--
-- Owner: rooms. Authoritative. Rooms are not personal: no table here names an account, and an operator's login is kept as
-- `cli:<name>` text, so the erasure registry has nothing to declare (the same as `rooms.room_cast`).
-- Query shapes: a room's approved kit and approved backdrop (read with every room row); the proposals and backdrops
-- waiting for review; the sum of what every attempt currently counts against the cap, and a room's unresolved attempts.
-- Locking: a new attempt takes the transaction advisory lock `rooms.backdrop-spend`, reads the sum, and inserts its row
-- in the same transaction, so two operators at once cannot pass the cap together. Nothing else here takes a lock.
-- Access: operator commands only write these tables; the API reads the approved kit and backdrop of a room.
-- Growth: a handful of rows per room, ever (one proposal per review, one attempt per image, at most 285 images at the cap).
-- Retention: kept with the room. A rejected or superseded kit or backdrop stays as the record of what was decided.
-- Rollout: additive. An older process neither reads nor writes these tables and every room keeps its default face.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- A kit a model proposed for a room, and what the operator decided. Only `approved` is shown to members; a room with no
-- approved kit wears the default its ID gives it (computed by code, never stored). One proposal waits at a time, and one
-- kit is approved at a time: approving a new one supersedes the old in the same transaction.
create table rooms.room_identity (
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  revision integer not null check (revision >= 1),
  kit jsonb not null check (jsonb_typeof(kit) = 'object' and pg_column_size(kit) <= 4096),
  kit_version text not null check (kit_version ~ '^station-kit\.v[0-9]+$'),
  review_state text not null check (review_state in ('pending', 'approved', 'rejected', 'superseded')),
  role_version text not null,
  model text not null,
  attempt_id uuid,
  proposed_at timestamptz not null,
  reviewed_at timestamptz,
  reviewed_by text check (reviewed_by ~ '^cli:[a-z_][a-z0-9_.-]{0,31}$'),
  primary key (room_id, revision),
  check ((review_state = 'pending') = (reviewed_at is null)),
  check ((reviewed_at is null) = (reviewed_by is null))
);
create unique index room_identity_one_pending on rooms.room_identity(room_id) where review_state = 'pending';
create unique index room_identity_one_approved on rooms.room_identity(room_id) where review_state = 'approved';

-- The ledger of every paid image attempt, one row each, in the same states as a Reel order's ledger. `charge_micro_usd`
-- is what the attempt counts against the $1 cap now: the whole estimate while it is dispatched, unknown or done, and
-- nothing once the provider conclusively refused it or it never left. Amounts are millionths of a US dollar. An attempt is
-- inserted already `dispatched` (the intent is recorded before the request leaves); one still dispatched past the request
-- deadline becomes `unknown` and is never sent again. An operator who has read the provider's own record may reconcile an
-- unknown attempt (charged or not) or write it off (it stays charged).
create table rooms.backdrop_attempts (
  attempt_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  kit_revision integer,
  state text not null check (state in ('dispatched', 'succeeded', 'failed', 'not_sent', 'unknown', 'reconciled', 'written_off')),
  model text not null,
  prompt_sha256 text not null check (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  estimate_micro_usd integer not null check (estimate_micro_usd between 1 and 1000000),
  charge_micro_usd integer not null check (charge_micro_usd between 0 and 1000000),
  price_source text not null check (price_source ~ '^https://'),
  price_checked_on date not null,
  requested_by text not null check (requested_by ~ '^cli:[a-z_][a-z0-9_.-]{0,31}$'),
  dispatched_at timestamptz not null,
  settled_at timestamptz,
  settled_by text check (settled_by ~ '^cli:[a-z_][a-z0-9_.-]{0,31}$'),
  outcome_code text check (outcome_code ~ '^[A-Z0-9_]{2,60}$'),
  note text check (char_length(note) between 1 and 300),
  check (charge_micro_usd <= estimate_micro_usd),
  check ((state = 'dispatched') = (settled_at is null)),
  check (state not in ('failed', 'not_sent') or charge_micro_usd = 0),
  check (state in ('failed', 'not_sent', 'reconciled') or charge_micro_usd = estimate_micro_usd),
  check (state not in ('reconciled', 'written_off') or (note is not null and settled_by is not null))
);
create index backdrop_attempts_room on rooms.backdrop_attempts(room_id, dispatched_at desc);
create index backdrop_attempts_unresolved on rooms.backdrop_attempts(dispatched_at) where state in ('dispatched', 'unknown');

-- A painted backdrop an attempt made: where its bytes are in the media store, and what the operator decided. Only
-- `approved` is served; a room with none draws its kit alone. At most one backdrop per room is approved.
create table rooms.room_backdrops (
  backdrop_id uuid primary key,
  room_id uuid not null references rooms.rooms(room_id) on delete restrict,
  attempt_id uuid not null unique references rooms.backdrop_attempts(attempt_id) on delete restrict,
  media_key text not null check (media_key ~ '^sha256/[0-9a-f]{2}/[0-9a-f]{64}\.(jpg|png|webp)$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 8388608),
  mime text not null check (mime in ('image/jpeg', 'image/png', 'image/webp')),
  review_state text not null check (review_state in ('pending', 'approved', 'rejected', 'superseded')),
  created_at timestamptz not null,
  reviewed_at timestamptz,
  reviewed_by text check (reviewed_by ~ '^cli:[a-z_][a-z0-9_.-]{0,31}$'),
  check (position(sha256 in media_key) = 11),
  check ((review_state = 'pending') = (reviewed_at is null)),
  check ((reviewed_at is null) = (reviewed_by is null))
);
create unique index room_backdrops_one_approved on rooms.room_backdrops(room_id) where review_state = 'approved';
create index room_backdrops_served on rooms.room_backdrops(sha256) where review_state = 'approved';

-- The Operator's counts of room faces: kits and backdrops by review state, attempts still unresolved, and what every
-- attempt currently counts against the cap, in millionths of a dollar. Counts and an integer only; no prompt, no image.
create view ops.room_faces as
select
  (select count(*) from rooms.room_identity where review_state = 'pending') as kits_pending,
  (select count(*) from rooms.room_identity where review_state = 'approved') as kits_approved,
  (select count(*) from rooms.room_backdrops where review_state = 'pending') as backdrops_pending,
  (select count(*) from rooms.room_backdrops where review_state = 'approved') as backdrops_approved,
  (select count(*) from rooms.backdrop_attempts) as backdrop_attempts,
  (select count(*) from rooms.backdrop_attempts where state in ('dispatched', 'unknown')) as backdrop_unresolved,
  (select coalesce(sum(charge_micro_usd), 0) from rooms.backdrop_attempts) as backdrop_spent_micro_usd;

comment on view ops.room_faces is
  'Room faces: kits and backdrops waiting or approved, image attempts unresolved, and the dollars (in millionths) they count against the cap. Counts only.';
