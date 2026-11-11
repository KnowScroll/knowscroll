import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/index.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { WatchdogStore } from '../application/ports.js';

/** The most groups one rule reads; a rule with more than this many queues or codes is alarming enough at 50. */
const MAX_GROUPS = 50;
/** One watchdog read waits at most this long, so a slow view cannot hold a connection. */
const STATEMENT_TIMEOUT_MS = 5000;

/**
 * `ops.watchdog` through the application role. Each read is one read-only transaction with its own
 * statement timeout, grouped by subject and detail, so the cost is bounded by the view's sources
 * and never by a person's history. It shows codes and counts; the view holds no ID.
 */
export function makeWatchdogStore(db: Kysely<Database>): WatchdogStore {
  return {
    groups: (query) =>
      withTransaction(db, 'operator.watchdog', async (trx) => {
        await sql`set transaction read only`.execute(trx);
        await sql`select set_config('statement_timeout', ${`${STATEMENT_TIMEOUT_MS}ms`}, true)`.execute(trx);
        const newer = query.newerThan === undefined ? sql`` : sql` and observed_at > ${query.newerThan}`;
        const older = query.olderThan === undefined ? sql`` : sql` and observed_at < ${query.olderThan}`;
        const magnitude = query.minMagnitude === undefined ? sql`` : sql` and magnitude >= ${query.minMagnitude}`;
        const rows = await sql<{ subject: string; detail: string | null; count: string }>`
          select subject, detail, count(*)::text as count
          from ops.watchdog
          where rule = ${query.rule}${newer}${older}${magnitude}
          group by subject, detail
          order by count(*) desc, subject, detail
          limit ${MAX_GROUPS}`.execute(trx);
        return rows.rows.map((row) => ({ subject: row.subject, detail: row.detail, count: Number(row.count) }));
      }),
  };
}
