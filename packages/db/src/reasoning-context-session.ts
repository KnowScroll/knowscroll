import type pg from 'pg';
import type {ReasoningScope} from './reasoning-runtime-policy.ts';

/** Caller already holds the universe lock. Lock the immutable original session
 * before any Job/Step locks. Validators still re-read live authority after waits;
 * this lookup neither authenticates nor permits missing/unsealed contexts.
 */
export async function lockBoundContextSession(client:pg.PoolClient,scope:ReasoningScope):Promise<void> {
 await client.query(`SELECT s.id FROM reasoning_context_job_session b
  JOIN device_session s ON s.id=b.session_id AND s.universe_id=b.universe_id
  WHERE b.job_id=$1 AND b.universe_id=$2 AND b.privacy_epoch=$3
  FOR UPDATE OF s`,[scope.jobId,scope.universeId,scope.privacyEpoch]);
}
