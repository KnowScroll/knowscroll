/**
 * #160/#163 — a committed source correction and the worker's catch-up pass (ADR-0040), shared by the
 * tests that watch a correction reach a reader who is away: their places, and their rooms.
 */
import { pool, transaction } from '../../packages/db/src/index.ts';
import { runCorrectionRefreshPass } from '../../packages/db/src/semantic/correction-refresh.ts';
import { correctSourceSnapshot } from '../../packages/db/src/semantic/corrections.ts';

/** The publisher withdraws a page: an operator correction, committed. */
export const withdraw = (sourceKey: string) => transaction(client =>
  correctSourceSnapshot(client, { sourceKey, action: 'revoked', reason: 'Test: the publisher withdrew this page' }, 'operator'));

/** The worker's pass, run until it refreshes no one (other readers in the file may be behind too).
 * Returns everyone it refreshed and everyone whose refresh failed. */
export async function drain(): Promise<{ refreshed: Set<string>; failed: Set<string> }> {
  const refreshed = new Set<string>(), failed = new Set<string>();
  for (let pass = 0; pass < 100; pass += 1) {
    const result = await runCorrectionRefreshPass(pool, { limit: 50 });
    for (const f of result.failed) failed.add(f.universeId);
    if (result.refreshed.length === 0) return { refreshed, failed };
    for (const id of result.refreshed) refreshed.add(id);
  }
  throw new Error('the correction refresh never settled');
}
