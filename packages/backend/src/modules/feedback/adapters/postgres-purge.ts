import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { PurgeDueReports } from '../application/purge-reports.js';

/**
 * Deletes reports about deleted accounts whose `retain_until` has passed (migration 0067, index
 * `reports_to_purge`). The clock is the database's. Rows another transaction holds are skipped, so the purge
 * never waits on a deletion in progress; the next run takes them.
 */
export const purgeDueReports =
  (db: Kysely<Database>): PurgeDueReports =>
  async (limit) => {
    const deleted = await withTransaction(db, 'feedback.purge-reports', (trx) =>
      sql`
        delete from feedback.reports
        where report_id in (
          select report_id from feedback.reports
          where retain_until <= now()
          order by retain_until
          limit ${limit}
          for update skip locked
        )`.execute(trx),
    );
    return Number(deleted.numAffectedRows ?? 0);
  };
