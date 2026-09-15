import { transaction, lockUniverse } from '../../../packages/db/src/index.ts';

export type ProjectionResult = {jobId:string;status:'completed'|'discarded'};

async function settleFailure(jobId:string,universeId:string):Promise<void> {
 await transaction(async c=>{
  await lockUniverse(c,universeId);
  const j=(await c.query("SELECT status,privacy_epoch FROM job WHERE id=$1 AND universe_id=$2 FOR UPDATE",[jobId,universeId])).rows[0];
  if(!j || j.status!=='pending') return;
  const epoch=(await c.query('SELECT privacy_epoch FROM universe WHERE id=$1',[universeId])).rows[0].privacy_epoch;
  if(j.privacy_epoch!==epoch) {
   await c.query("UPDATE job SET status='discarded',discarded_at=clock_timestamp(),last_error='stale privacy epoch' WHERE id=$1",[jobId]);
   return;
  }
  await c.query("UPDATE job SET attempts=attempts+1,status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'pending' END,available_at=clock_timestamp()+interval '5 seconds',last_error='projection failed; inspect worker' WHERE id=$1",[jobId]);
 });
}

/** Only short, deterministic database work belongs in this transaction.
 * A paid provider call must use a separate lease/attempt protocol (ADR-0005). */
export async function projectOne():Promise<ProjectionResult|null> {
 let jobId:string|undefined,universeId:string|undefined;
 try {return await transaction(async c=> {
  const candidate=(await c.query(`SELECT j.id,j.universe_id FROM job j JOIN universe u ON u.id=j.universe_id
   WHERE j.status='pending' AND j.available_at<=clock_timestamp()
   ORDER BY j.available_at,j.id FOR UPDATE OF u SKIP LOCKED LIMIT 1`)).rows[0];
  if(!candidate) return null; jobId=candidate.id;universeId=candidate.universe_id;
  await lockUniverse(c,universeId);
  const j=(await c.query("SELECT * FROM job WHERE id=$1 AND universe_id=$2 AND status='pending' AND available_at<=clock_timestamp() FOR UPDATE",[jobId,universeId])).rows[0];
  if(!j) return null;
  const universe=(await c.query('SELECT privacy_epoch FROM universe WHERE id=$1',[j.universe_id])).rows[0];
  const e=(await c.query('SELECT * FROM ledger WHERE id=$1',[j.event_id])).rows[0];
  if(j.privacy_epoch!==universe.privacy_epoch || !e || e.universe_id!==j.universe_id || e.privacy_epoch!==j.privacy_epoch) {
   await c.query("UPDATE job SET status='discarded',discarded_at=clock_timestamp(),last_error='stale privacy epoch' WHERE id=$1",[j.id]);
   return {jobId:j.id,status:'discarded'};
  }
  if(e.kind!=='keep') throw new Error('Unsupported event');
  const added=await c.query('INSERT INTO trace(universe_id,asset_id,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',[j.universe_id,e.payload.assetId,e.id]);
  if(added.rowCount) {
   await c.query('UPDATE accounts SET revision=revision+1,kept_asset_ids=array_append(kept_asset_ids,$2::uuid) WHERE universe_id=$1',[j.universe_id,e.payload.assetId]);
   await c.query('UPDATE universe SET revision=revision+1 WHERE id=$1',[j.universe_id]);
  }
  await c.query("UPDATE job SET status='completed',attempts=attempts+1,completed_at=now() WHERE id=$1",[j.id]);
  return {jobId:j.id as string,status:'completed'};
 });} catch(e) {
  if(jobId&&universeId) await settleFailure(jobId,universeId);
  throw e;
 }
}
