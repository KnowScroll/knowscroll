/** The worker's liveness row. The caller decides what a failure means; the projection loop lets it end the process. */
import type pg from 'pg';

export async function recordWorkerHeartbeat(
  pool: pg.Pool,
  workerId: string,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO
        worker_heartbeat (worker_id, last_seen)
      VALUES
        ($1, now())
      ON CONFLICT (worker_id) DO UPDATE
      SET
        last_seen = now()
    `,
    [workerId],
  );
}
