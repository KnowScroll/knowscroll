import type pg from 'pg';

/**
 * Whether the universe's recording is paused (ADR-0030). The universe row must exist: a missing
 * row throws, as each caller's inline read did. `atlas.ts` treats a missing row as not paused and
 * keeps its own read.
 */
export async function isRecordingPaused(
  client: pg.PoolClient,
  universeId: string,
): Promise<boolean> {
  return (
    await client.query<{ paused: boolean }>(
      'SELECT recording_paused_at IS NOT NULL AS paused FROM universe WHERE id=$1',
      [universeId],
    )
  ).rows[0]!.paused;
}
