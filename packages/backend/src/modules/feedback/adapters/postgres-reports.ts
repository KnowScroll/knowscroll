import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReportStore } from '../application/ports.js';

/** `feedback.reports` (migration 0065), written in the reporter's personal transaction. */
export const reportStore: ReportStore = {
  async countSince(scope, accountId, since) {
    const counted = await sql<{ sent: number }>`
      select count(*)::int as sent from feedback.reports
      where reporter_account_id = ${accountId}::uuid and created_at >= ${since}`.execute(transactionOf(scope));
    return counted.rows[0]?.sent ?? 0;
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
