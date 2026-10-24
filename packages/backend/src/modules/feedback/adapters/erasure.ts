import { sql } from 'kysely';
import { declareErasure } from '../../../infrastructure/erasure/declaration.js';
import { EXPORT_LIST_LIMIT, boundedSection, exportReading } from '../../../infrastructure/erasure/registry.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';

/**
 * Reports are account-keyed: a report is a message to the safety team, not exploration evidence, so
 * selective Clear keeps them (as it keeps rooms and conversations, D-042). Account deletion removes
 * every report the account sent and every report about it. Nothing is universe-keyed.
 */
const LIFECYCLE = 'feedback.reports';

const ABOUT_WORDS = {
  asset: 'a Reel or Scroll',
  message: 'a message',
  room_message: 'a message in a room',
  person: 'a person',
} as const;

interface ExportRow {
  readonly kind: string;
  readonly category: string;
  readonly target_kind: keyof typeof ABOUT_WORDS;
  readonly asset_id: string | null;
  readonly title: string | null;
  readonly note: string | null;
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

  /** Deletes what the account sent and what was sent about it; a second run finds nothing. */
  async eraseAccount(scope) {
    const removed = await sql`
      delete from feedback.reports
      where reporter_account_id = ${scope.accountId}::uuid or reported_account_id = ${scope.accountId}::uuid`.execute(
      transactionOf(scope.personal),
    );
    return { module: 'feedback', status: 'completed', removed: Number(removed.numAffectedRows ?? 0) };
  },

  clear: {
    dispositions: { [LIFECYCLE]: 'preserve' },
    erase() {
      return Promise.resolve({ module: 'feedback', status: 'completed', removed: 0 });
    },
  },

  /**
   * What the person sent: the kind, reason, what it was about in words and their own note. Never an
   * identifier and never the person or message reported.
   */
  export: (declaration) =>
    exportReading(declaration, [LIFECYCLE], 'Nothing else is declared.', async (scope, person) => {
      const rows = await sql<ExportRow>`
        select report.kind, report.category, report.target_kind, report.asset_id, revision.title, report.note, report.created_at
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
            sentAt: row.created_at.toISOString(),
          })),
        ),
      };
    }),
});
