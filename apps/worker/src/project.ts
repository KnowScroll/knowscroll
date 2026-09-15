import { pool, transaction } from '../../../packages/db/src/index.ts';
/** Only short, deterministic database work belongs in this transaction.
 * A paid provider call must use a separate lease/attempt protocol (ADR-0005). */
export async function projectOne():Promise<string|null> {
 let jobId:string|undefined;
 try {return await transaction(async c=> {
  const j=(await c.query("SELECT * FROM job WHERE status='pending' AND available_at<=now() ORDER BY available_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
  if(!j) return null; jobId=j.id;
  await c.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[j.universe_id]);
  const e=(await c.query('SELECT * FROM ledger WHERE id=$1',[j.event_id])).rows[0];
  if(e.kind!=='keep') throw new Error('Unsupported event');
  const added=await c.query('INSERT INTO trace(universe_id,asset_id,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',[j.universe_id,e.payload.assetId,e.id]);
  if(added.rowCount) {
   await c.query('UPDATE accounts SET revision=revision+1,kept_asset_ids=array_append(kept_asset_ids,$2::uuid) WHERE universe_id=$1',[j.universe_id,e.payload.assetId]);
   await c.query('UPDATE universe SET revision=revision+1 WHERE id=$1',[j.universe_id]);
  }
  await c.query("UPDATE job SET status='completed',attempts=attempts+1,completed_at=now() WHERE id=$1",[j.id]);
  return j.id as string;
 });} catch(e) {
  if(jobId) await pool.query("UPDATE job SET attempts=attempts+1,status=CASE WHEN attempts+1>=5 THEN 'failed' ELSE 'pending' END,available_at=now()+interval '5 seconds',last_error='projection failed; inspect worker' WHERE id=$1 AND status='pending'",[jobId]);
  throw e;
 }
}
