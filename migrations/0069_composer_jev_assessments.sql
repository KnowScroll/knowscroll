-- Composer keeps one small pool of recent Jev assessments per person (#231, D-058).
--
-- Owner: modules/composer. A disposable cache of model assessments, authoritative for nothing: it
-- creates no evidence and no encounter. A buffer preparation reads it so a candidate assessed in the
-- last 30 minutes while the person was on the same subject is not sent to the model again. Each
-- entry is {subject, assetId, assetRevision, relevance, appropriateness, redundancy, assessedAt};
-- `subject` is the language and primary topic of the step the person was on. The role version and
-- model are stored once for the row: entries made under another version are never reused.
-- Query shapes: one row by primary key when a preparation starts (read) and when it commits (merge).
-- Locking: the personal root, as for composer.buffers; the merge reads and writes under it.
-- Growth: one row per universe, at most 100 entries (about 25 KiB), newest kept.
-- Retention: an entry is used for 30 minutes after it was assessed; expired entries are dropped
-- when the row is next written. An idle person keeps one expired row until their next preparation
-- or erasure.
-- Erasure: Clear and full erasure delete the row with the person's other Composer stores.
-- Rollout: additive; no earlier writer exists.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table composer.jev_assessments (
  universe_id uuid primary key references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  role_version text not null check (char_length(role_version) between 1 and 64),
  model text not null check (char_length(model) between 1 and 128),
  entries jsonb not null check (
    jsonb_typeof(entries) = 'array'
    and jsonb_array_length(entries) between 1 and 100
    and octet_length(entries::text) <= 65536
  ),
  updated_at timestamptz not null default now()
);
