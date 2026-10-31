import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/index.js';
import type { StoredDecision } from '../application/replay-policy.js';

/** Decisions fetched per query: a payload is up to 256 KiB, so a page stays near ten megabytes at most. */
const PAGE_SIZE = 40;

/**
 * The retained vertical decisions recorded at or after `since`, newest first, at most `limit`, a page at a
 * time (keyset on recorded time and id), so a window of thousands is never held in memory. For the
 * operator replay only: it reads the decisions of every account, which the caller must not print or log.
 * It sees the table the way the migration role does, not through a personal scope.
 */
export async function* readRetainedDecisions(
  db: Kysely<Database>,
  query: { readonly since: Date; readonly limit: number },
): AsyncGenerator<StoredDecision> {
  let remaining = query.limit;
  // The keyset carries the time as text: a Date holds milliseconds and the column microseconds, which would skip rows.
  let after: { readonly recordedAt: string; readonly id: string } | undefined;
  while (remaining > 0) {
    const page = await sql<{
      id: string;
      recorded_text: string;
      policy_version: string;
      payload: unknown;
    }>`select id,recorded_at::text as recorded_text,policy_version,payload from composer.decisions
      where recorded_at>=${query.since}::timestamptz and payload #>> '{input,mode}'='vertical'
      ${after ? sql`and (recorded_at,id)<(${after.recordedAt}::timestamptz,${after.id}::uuid)` : sql``}
      order by recorded_at desc,id desc limit ${Math.min(PAGE_SIZE, remaining)}`.execute(db);
    for (const row of page.rows) yield { policyVersion: row.policy_version, payload: row.payload };
    const last = page.rows.at(-1);
    if (page.rows.length < Math.min(PAGE_SIZE, remaining) || last === undefined) return;
    remaining -= page.rows.length;
    after = { recordedAt: last.recorded_text, id: last.id };
  }
}
