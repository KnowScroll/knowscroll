import { sql, type Kysely } from 'kysely';
import type { Database } from './database.js';

/**
 * Runs `work` only while this process holds a session-level advisory lock named `name`, taken with a try: when another holds it, returns `undefined`
 * and runs nothing. For work that must never overlap itself and that may call a model or the network, such as one pass of the gap loop's brief job
 * (#674, D-414), so the lock is not a transaction's: one dedicated connection holds it and no transaction is open, and `work` is not marked as
 * inside one. It does its own database work on the pool. A crash, or a connection that dies, releases the lock with the session; a normal end
 * releases it here, and a failure to unlock never hides the outcome of `work`. The connection is out of the pool for as long as `work` runs.
 */
export function withSessionLock<T>(db: Kysely<Database>, name: string, work: () => Promise<T>): Promise<T | undefined> {
  return db.connection().execute(async (connection) => {
    const { rows } = await sql<{
      locked: boolean;
    }>`select pg_try_advisory_lock(hashtextextended(${name}, 0)) as locked`.execute(connection);
    if (rows[0]?.locked !== true) return undefined;
    try {
      return await work();
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${name}, 0))`.execute(connection).catch(() => undefined);
    }
  });
}
