/** The reader's universe summary for `GET /v1/universe`. Runs in the caller's authenticated transaction. */
import type pg from 'pg';
import type { AuthScope } from './identity.ts';
import { listSavedTraces } from './trace-revisit.ts';

export async function readUniverseSummary(
  client: pg.PoolClient,
  scope: AuthScope,
) {
  const universe = (
    await client.query(
      'SELECT revision, privacy_epoch, recording_paused_at FROM universe WHERE id=$1',
      [scope.universeId],
    )
  ).rows[0];
  const traces = await listSavedTraces(client, scope);
  return {
    universeId: scope.universeId,
    revision: universe.revision,
    privacyEpoch: universe.privacy_epoch,
    recordingPausedAt: universe.recording_paused_at
      ? new Date(universe.recording_paused_at).toISOString()
      : null,
    traces,
    capabilities: { reasoning: false, reels: false, worldEvolution: false },
  };
}
