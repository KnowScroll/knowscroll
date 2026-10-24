-- #250 (D-055) Feedback on content: "Not interested" and reports.
--
-- experience.not_interested (owner: experience). One row per person and asset the person said they
-- are not interested in. Composer's eligibility reads it beside Hide, so the asset is not offered
-- again until the row expires or the person taps Undo. It is a short-lived routing constraint, not
-- evidence and not a claim about the person: nothing derives interest, planets or a profile from it.
--   Reads: candidate-bounded probe by primary key (universe, asset) with expires_at in the future.
--   Writes: upsert on the command, delete on Undo; each write also deletes the person's expired rows
--   and everything past the newest 500, so a person holds at most 500 rows.
--   Retention: 14 days from the command (expires_at); expired rows are ignored by every read.
--   Erasure: Clear and full erasure delete the rows (universe-keyed).
--
-- feedback.reports (owner: feedback). One row per report a person sent to the safety team: a content
-- error (a Reel or Scroll, with an optional place in it) or abuse (a Reel or Scroll, a message in a
-- conversation or thread, a room message, or a person). The reported person is never told and no
-- consumer route reads a report; operators read the newest reports, and a room's moderators read the
-- reports about messages in their room (never the reporter or the note).
--   Reads: newest first (operators); a reporter's reports (daily bound, export); a room's reports
--   (moderators); the rows naming an account (account deletion).
--   Growth: at most 25 reports per account per day; note at most 500 characters.
--   Retention: kept until the reporter or the reported person deletes their account.
--   Erasure: account-keyed, so Clear keeps reports (an explicit message to us, not exploration
--   evidence). Account deletion deletes every report the account sent and every report about it.
--   Message ids are soft references: the report does not stop a message from being tombstoned.
--
-- ops.feedback_reports (owner: operator, D-044). The Operator screen's list of reports: ids, kind,
-- category, target kind, whether a note exists and when. Never the note, the reporter or the person
-- reported (the allowlist of the ops views holds: no text, no account).
-- Rollout: additive. No earlier writer exists for these tables.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table experience.not_interested (
  universe_id uuid not null references identity.universes(id) on delete restrict,
  privacy_epoch integer not null check (privacy_epoch >= 1),
  asset_id uuid not null references content.assets(id) on delete restrict,
  marked_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (universe_id, asset_id),
  check (expires_at > marked_at and expires_at <= marked_at + interval '60 days')
);

create schema feedback;

create table feedback.reports (
  report_id uuid primary key,
  reporter_account_id uuid not null references identity.accounts(id) on delete restrict,
  kind text not null check (kind in ('content_error', 'abuse')),
  category text not null,
  target_kind text not null check (target_kind in ('asset', 'message', 'room_message', 'person')),
  asset_id uuid,
  asset_revision integer,
  message_id uuid,
  room_id uuid,
  -- The person behind a message or a person target; null once their account is gone or for a message of an AI inhabitant.
  reported_account_id uuid references identity.accounts(id) on delete restrict,
  -- Where in a Reel (milliseconds) or Scroll (block id) a content error points.
  anchor jsonb check (anchor is null or (jsonb_typeof(anchor) = 'object' and pg_column_size(anchor) <= 256)),
  note text check (char_length(note) between 1 and 500),
  created_at timestamptz not null,
  foreign key (asset_id, asset_revision) references content.asset_revisions(asset_id, revision) on delete restrict,
  check (
    (kind = 'content_error' and category in ('wrong', 'out_of_date', 'misleading', 'other') and target_kind = 'asset')
    or (kind = 'abuse' and category in ('harassment', 'hate', 'sexual_content', 'violence', 'spam', 'self_harm', 'other'))
  ),
  check (anchor is null or kind = 'content_error'),
  check (
    (target_kind = 'asset' and asset_id is not null and asset_revision is not null and message_id is null and room_id is null and reported_account_id is null)
    or (target_kind = 'message' and message_id is not null and asset_id is null and room_id is null)
    or (target_kind = 'room_message' and message_id is not null and room_id is not null and asset_id is null)
    or (target_kind = 'person' and reported_account_id is not null and asset_id is null and message_id is null and room_id is null)
  )
);
create index reports_recent on feedback.reports(created_at desc, report_id);
create index reports_by_reporter on feedback.reports(reporter_account_id, created_at desc);
create index reports_by_room on feedback.reports(room_id, created_at desc) where room_id is not null;
create index reports_by_reported on feedback.reports(reported_account_id) where reported_account_id is not null;

create view ops.feedback_reports as
select
  report.report_id,
  report.kind,
  ops.safe_code(report.category) as category,
  report.target_kind,
  report.asset_id,
  report.asset_revision,
  report.message_id,
  report.room_id,
  (report.note is not null) as has_note,
  report.created_at
from feedback.reports as report;

comment on view ops.feedback_reports is
  'Reports to the safety team: kind, category, target kind and ids, whether a note exists, and when. No note, no reporter, no reported person.';
