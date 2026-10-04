// The transaction helper for db functions that own their transaction on a caller-supplied pool.
import type pg from 'pg';

/**
 * Runs `body` in one transaction on a client checked out of `pool`. A failed ROLLBACK is
 * swallowed so the original error is the one thrown. That is what distinguishes it from
 * `transaction()` in `../connection.ts`, whose ROLLBACK failure propagates; callers chose one or
 * the other on purpose, so the two stay separate.
 */
export async function inTransaction<T>(
  pool: pg.Pool,
  body: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await body(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
