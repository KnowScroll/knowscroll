import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { EXPORT_LIST_LIMIT, boundedSection, exportReading } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { DELETED_ACCOUNT_REPORT_RETENTION_DAYS } from '../domain/reports.js';

/**
 * Reports are account-keyed: a report is a message to the safety team, not exploration evidence, so
 * selective Clear keeps them (as it keeps rooms and conversations, D-042). Nothing is universe-keyed.
 *
 * Account deletion follows who a report belongs to (D-055):
 *  - what the account sent is theirs, and goes with the account;
 *  - what was sent about the account is its reporters' report, and must outlive the deletion for
 *    `DELETED_ACCOUNT_REPORT_RETENTION_DAYS`, so deleting an account cannot erase the complaints about it.
 *    The report loses its pointer to the person (the account column is cleared, a person target becomes
 *    `deleted_account`). A message id stays: Social and Rooms tombstone the message in the same deletion, so
 *    it names no one. `feedback.purge-reports` deletes the report once `retain_until` has passed.
 * A content error names an asset, never an account, so this side of a deletion never touches one.
 */
const LIFECYCLE = 'feedback.reports';

const ABOUT_WORDS = {
  asset: 'a Reel or Scroll',
  message: 'a message',
  room_message: 'a message in a room',
  person: 'a person',
  deleted_account: 'a person who has since deleted their account',
} as const;

interface ExportRow {
  readonly kind: string;
  readonly category: string;
  readonly target_kind: keyof typeof ABOUT_WORDS;
  readonly asset_id: string | null;
  readonly title: string | null;
  readonly note: string | null;
  readonly quick_answer: string | null;
  readonly retain_until: Date | null;
  readonly created_at: Date;
}

export const feedbackErasure = declareErasure({
  module: 'feedback',
  tables: [],
  nonRowStores: [],
  accountTables: [{ schema: 'feedback', table: 'reports', ownerColumn: 'reporter_account_id,reported_account_id' }],
  accountColumns: [
    { schema: 'feedback', table: 'reports', column: 'reporter_account_id' },
    { schema: 'feedback', table: 'reports', column: 'reported_account_id' },
  ],

  erase() {
    return Promise.resolve({ module: 'feedback', status: 'completed', removed: 0 });
  },

  /**
   * Deletes what the account sent, then cuts the account out of what was sent about it and starts that
   * report's retention. A second run finds nothing to do.
   */
  async eraseAccount(scope) {
    const trx = transactionOf(scope.personal);
    const sent = await sql`delete from feedback.reports where reporter_account_id = ${scope.accountId}::uuid`.execute(
      trx,
    );
    const deidentified = await sql`
      update feedback.reports
      set reported_account_id = null,
          target_kind = case when target_kind = 'person' then 'deleted_account' else target_kind end,
          retain_until = now() + make_interval(days => ${DELETED_ACCOUNT_REPORT_RETENTION_DAYS}::int)
      where reported_account_id = ${scope.accountId}::uuid`.execute(trx);
    return {
      module: 'feedback',
      status: 'completed',
      removed: Number(sent.numAffectedRows ?? 0) + Number(deidentified.numAffectedRows ?? 0),
    };
  },

  clear: {
    dispositions: { [LIFECYCLE]: 'preserve' },
    erase() {
      return Promise.resolve({ module: 'feedback', status: 'completed', removed: 0 });
    },
  },

  /**
   * What the person sent: the kind, reason, what it was about in words and their own note. Never an
   * identifier and never the person or message reported. A report about a person who has deleted their
   * account says until when it is kept.
   */
  export: (declaration) =>
    exportReading(declaration, [LIFECYCLE], 'Nothing else is declared.', async (scope, person) => {
      const rows = await sql<ExportRow>`
        select report.kind, report.category, report.target_kind, report.asset_id, revision.title, report.note,
          report.quick_answer, report.retain_until, report.created_at
        from feedback.reports report
        left join content.asset_revisions revision
          on revision.asset_id = report.asset_id and revision.revision = report.asset_revision
        where report.reporter_account_id = ${person.accountId}::uuid
        order by report.created_at desc, report.report_id
        limit ${EXPORT_LIST_LIMIT + 1}`.execute(transactionOf(scope));
      if (rows.rows.length === 0) return {};
      const reachable = await person.reach([
        ...new Set(rows.rows.flatMap((row) => (row.asset_id === null ? [] : [row.asset_id]))),
      ]);
      return {
        reports: boundedSection(
          rows.rows.map((row) => ({
            kind: row.kind === 'abuse' ? 'abuse report' : 'content error',
            reason: row.category,
            about: ABOUT_WORDS[row.target_kind],
            ...(row.asset_id !== null && row.title !== null && reachable.has(row.asset_id) ? { title: row.title } : {}),
            ...(row.note === null ? {} : { note: row.note }),
            ...(row.quick_answer === null ? {} : { quickAnswer: row.quick_answer }),
            ...(row.retain_until === null ? {} : { keptUntil: row.retain_until.toISOString() }),
            sentAt: row.created_at.toISOString(),
          })),
        ),
      };
    }),
});
