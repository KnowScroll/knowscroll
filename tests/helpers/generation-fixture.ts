import type pg from 'pg';
import * as storage from '../../apps/worker/src/generation/storage.ts';

/** `pnpm test` runs every `tests/*.test.ts` file against one shared disposable database.
 * `storage.claimJob` deliberately claims the globally oldest ready job (never scoped to a single
 * caller's own rows), so a `generation_job` another file in this same run left claimable (for
 * example `generation-contract.test.ts`'s own admission-guard fixture, left `queued`) would
 * otherwise be claimed by a later file by mistake instead of its own job. Claiming those away first
 * is a benign, non-destructive status change (that file's own assertions about them have already
 * completed by the time the next file runs) and makes every later claim deterministic.
 *
 * #169: a job another file left under a live lease is not claimable yet, but becomes so the moment
 * that lease runs out -- mid-file, when it outlasts the files in between (generation-admission's
 * 20 s leases ran out inside generation-runtime on CI). Its worker went with that file's process,
 * so the lease is ended now and the job drained with the rest. */
export async function drainStrayJobs(db: pg.Pool, owner: string): Promise<void> {
  await db.query('UPDATE generation_job SET lease_expires_at=clock_timestamp() WHERE lease_expires_at>clock_timestamp()');
  for (;;) {
    const claimed = await storage.claimJob(db, {owner, leaseMs: 60_000});
    if (!claimed) return;
  }
}
