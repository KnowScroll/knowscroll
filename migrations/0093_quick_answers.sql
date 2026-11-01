-- #480 (v3 S-9b) Quick answer (D-086, D-253 to D-255): a short, unchecked answer about words a person selected in a Scroll
-- they are reading. It is made by a worker; the HTTP command only stores it and sends the job.
--
-- Owners: supply (`supply.quick_answers`, `supply.quick_answer_ledger`) and feedback (`feedback.reports.quick_answer`).
-- Query shapes: one of the person's answers by (universe, id); the person's answers made since the start of the UTC day
-- (their cap) and the ones still waiting (the open limit); the world's answers made since the start of the day (the world's
-- cap, read from the ledger); the answers past `expires_at` (the scheduled purge).
-- Locking: the create transaction runs under the personal root and takes its own advisory lock, `supply.quick-answers`,
-- before it counts, so the day's counts and the rows it admits agree. It is last in the lock order and no other path takes it.
-- Access: a row is the person's own and is never read by another person, room or thread. The ledger names no person and
-- no words: an ID and a time.
-- Growth: bounded by the daily caps (one ledger row per answer; at most the person's cap a day per person), and every row
-- is deleted a day after it was asked.
-- Retention: the words the person selected and the question they typed are cleared the moment the answer settles or the
-- card is dismissed. What the card shows (the question it answers and the answer) is kept until `expires_at`, one day after it
-- was asked, then purged by the scheduled job `supply.purge-quick-answers`. Clear and account deletion erase the rows at once.
-- The ledger stays, as the ask-order ledger does: it names no one and the world's cap reads it.
-- A report keeps the words of the Quick answer it was about (`feedback.reports.quick_answer`), because the answer itself is gone
-- a day later; the person chose to send it, like a note.
-- Rollout: additive. An older process neither reads nor writes the tables or the column.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table supply.quick_answers (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  id uuid not null,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  asset_id uuid not null,
  asset_revision integer not null check (asset_revision >= 1),
  stop_id text not null check (char_length(stop_id) between 1 and 64),
  state text not null check (state in ('waiting', 'answered', 'unavailable', 'dismissed')),
  -- What the person asked, kept only while a worker needs it.
  passage text check (passage is null or char_length(passage) between 1 and 400),
  question text check (question is null or char_length(question) between 3 and 200),
  -- What the card shows once it is answered.
  shown_question text check (shown_question is null or char_length(shown_question) between 1 and 200),
  answer text check (answer is null or char_length(answer) between 1 and 640),
  covered boolean,
  created_at timestamptz not null,
  settled_at timestamptz,
  expires_at timestamptz not null,
  primary key (universe_id, id),
  foreign key (asset_id, asset_revision) references content.asset_revisions(asset_id, revision) on delete restrict,
  check (expires_at > created_at),
  check (
    (state = 'waiting' and passage is not null and answer is null and shown_question is null and covered is null and settled_at is null)
    or (state = 'answered' and passage is null and question is null and answer is not null and shown_question is not null and covered is not null and settled_at is not null)
    or (state in ('unavailable', 'dismissed') and passage is null and question is null and answer is null and shown_question is null and covered is null)
  )
);
-- The person's cap and open limit.
create index quick_answers_person_day on supply.quick_answers(universe_id, created_at);
-- The purge.
create index quick_answers_expiry on supply.quick_answers(expires_at);

-- Quartermaster's ledger of Quick answers. One row per answer asked. It names no person and no words: the day's count is
-- what the world's cap reads, so Clear and account deletion cannot reset it.
create table supply.quick_answer_ledger (
  id uuid primary key,
  created_at timestamptz not null default now()
);
create index quick_answer_ledger_day on supply.quick_answer_ledger(created_at);

-- A content-error report about a Quick answer keeps its words, so the safety team can read what was wrong.
alter table feedback.reports add column quick_answer text;
alter table feedback.reports
  add constraint reports_quick_answer_shape check (
    quick_answer is null or (kind = 'content_error' and char_length(quick_answer) between 1 and 900)
  ) not valid;
-- Every existing row has a null column, so validating takes no real time (the squawk-ignore comment says so, as in 0090).
-- squawk-ignore constraint-missing-not-valid
alter table feedback.reports validate constraint reports_quick_answer_shape;
