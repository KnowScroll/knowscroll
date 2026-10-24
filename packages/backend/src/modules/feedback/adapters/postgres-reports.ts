import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadRoomReports } from '../../rooms/public.js';
import type { ReportStore } from '../application/ports.js';

/** `feedback.reports` (migration 0065), written in the reporter's personal transaction. */
export const reportStore: ReportStore = {
  async countSince(scope, accountId, since) {
    const counted = await sql<{ sent: number }>`
      select count(*)::int as sent from feedback.reports
      where reporter_account_id = ${accountId}::uuid and created_at >= ${since}`.execute(transactionOf(scope));
    return counted.rows[0]?.sent ?? 0;
  },

  async findEarlierAbuse(scope, accountId, target) {
    const targetId = target.assetId ?? target.messageId ?? target.reportedAccountId;
    if (targetId === undefined) return undefined;
    // The same expression as the unique index `reports_one_abuse_per_target`, so the probe is an index lookup.
    const found = await sql<{ report_id: string; created_at: Date }>`
      select report_id, created_at from feedback.reports
      where kind = 'abuse' and reporter_account_id = ${accountId}::uuid and target_kind = ${target.targetKind}
        and coalesce(asset_id, message_id, reported_account_id) = ${targetId}::uuid`.execute(transactionOf(scope));
    const first = found.rows[0];
    return first === undefined ? undefined : { reportId: first.report_id, createdAt: first.created_at };
  },

  async insert(scope, report) {
    await sql`
      insert into feedback.reports (report_id, reporter_account_id, kind, category, target_kind, asset_id,
        asset_revision, message_id, room_id, reported_account_id, anchor, note, created_at)
      values (${report.reportId}::uuid, ${report.reporterAccountId}::uuid, ${report.kind}, ${report.category},
        ${report.targetKind}, ${report.assetId ?? null}::uuid, ${report.assetRevision ?? null}::int,
        ${report.messageId ?? null}::uuid, ${report.roomId ?? null}::uuid, ${report.reportedAccountId ?? null}::uuid,
        ${report.anchor === undefined ? null : JSON.stringify(report.anchor)}::jsonb, ${report.note ?? null},
        ${report.createdAt})`.execute(transactionOf(scope));
  },
};

/**
 * Reports on one room's messages, one row per message. `sent` counts different reporters, so one person
 * cannot raise it. A moderator's own messages are left out of their view.
 */
export const readRoomReports: ReadRoomReports = async (scope, query) => {
  const rows = await sql<{ message_id: string; categories: string[]; sent: number; last_reported_at: Date }>`
    select message_id, array_agg(distinct category order by category) as categories,
      count(distinct reporter_account_id)::int as sent, max(created_at) as last_reported_at
    from feedback.reports
    where room_id = ${query.roomId}::uuid and target_kind = 'room_message'
      and (reported_account_id is null or reported_account_id <> ${query.excludingAccountId}::uuid)
    group by message_id
    order by max(created_at) desc, message_id
    limit ${query.limit}`.execute(transactionOf(scope));
  return rows.rows.map((row) => ({
    messageId: row.message_id,
    categories: row.categories,
    count: row.sent,
    lastReportedAt: row.last_reported_at,
  }));
};
