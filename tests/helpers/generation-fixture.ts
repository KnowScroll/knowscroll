import type pg from 'pg';
import * as storage from '../../apps/worker/src/generation/storage.ts';

/** `storage.claimJob` deliberately claims the globally oldest ready job (never scoped to a single
 * caller's own rows), so a `generation_job` an earlier test in the same file left claimable would
 * otherwise be claimed by mistake instead of the next test's own job. (Each file has its own
 * database, #188, so only this file's rows are there.) Claiming those away first is a benign,
 * non-destructive status change and makes every later claim deterministic.
 *
 * #169: a job left under a live lease is not claimable yet, but becomes so the moment that lease
 * runs out, in the middle of a later test. Its worker has stopped, so the lease is ended now and the
 * job drained with the rest. */
export async function drainStrayJobs(db: pg.Pool, owner: string): Promise<void> {
  await db.query('UPDATE generation_job SET lease_expires_at=clock_timestamp() WHERE lease_expires_at>clock_timestamp()');
  for (;;) {
    const claimed = await storage.claimJob(db, {owner, leaseMs: 60_000});
    if (!claimed) return;
  }
}

/** Registers a Cutroom engine nothing listens on, for rows that only need one to point at. An
 * origin belongs to at most one active engine (`cutroom_engine_one_active_origin`), and the engines
 * earlier tests in the file registered stay active, so the port is the lowest one no active engine
 * holds -- #169: a random port collided with an earlier engine often enough to fail CI. */
export async function insertFakeEngine(db: pg.Pool, engine: {id: string; artifactRoot: string; providerMode: 'standin' | 'live'}): Promise<void> {
  const inserted = await db.query(
    `INSERT INTO cutroom_engine(id,origin,contract_revision,artifact_root,provider_mode,declared_by)
     SELECT $1,'http://127.0.0.1:'||port,$2,$3,$4,'test' FROM generate_series(20000,49999) AS port
     WHERE NOT EXISTS (SELECT 1 FROM cutroom_engine WHERE origin='http://127.0.0.1:'||port AND retired_at IS NULL)
     ORDER BY port LIMIT 1`,
    [engine.id, storage.CUTROOM_CONTRACT_REVISION, engine.artifactRoot, engine.providerMode],
  );
  if (inserted.rowCount !== 1) throw new Error('every fixture engine origin is held by an active engine');
}
