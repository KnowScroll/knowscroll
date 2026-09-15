import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { pool } from '../packages/db/src/index.ts';
import { projectOne } from '../apps/worker/src/project.ts';

if(!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Worker epoch tests require an isolated knowscroll_test_* database');
after(async()=>pool.end());

async function createProjection(epoch=0):Promise<{universeId:string;eventId:string;jobId:string;assetId:string}> {
 const universeId=randomUUID(),eventId=randomUUID(),jobId=randomUUID();
 const assetId=(await pool.query('SELECT id FROM asset ORDER BY editorial_order LIMIT 1')).rows[0].id;
 await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,$2)',[universeId,epoch]);
 await pool.query('INSERT INTO accounts(universe_id) VALUES($1)',[universeId]);
 await pool.query("INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch) VALUES($1,$2,'keep',$3,$4,$5)",
  [eventId,universeId,randomUUID(),JSON.stringify({assetId}),epoch]);
 await pool.query("INSERT INTO job(id,universe_id,event_id,kind,privacy_epoch) VALUES($1,$2,$3,'project_keep',$4)",[jobId,universeId,eventId,epoch]);
 await pool.query("UPDATE job SET available_at='2000-01-01T00:00:00Z' WHERE id=$1",[jobId]);
 return {universeId,eventId,jobId,assetId};
}

test('current-epoch work projects once and reports its actual outcome',async()=>{
 const work=await createProjection(2);
 assert.deepEqual(await projectOne(),{jobId:work.jobId,status:'completed'});
 const job=(await pool.query('SELECT status,completed_at,discarded_at FROM job WHERE id=$1',[work.jobId])).rows[0];
 assert.equal(job.status,'completed');assert.ok(job.completed_at);assert.equal(job.discarded_at,null);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM trace WHERE universe_id=$1 AND event_id=$2',[work.universeId,work.eventId])).rows[0].n,1);
});

test('epoch advancement discards queued work without projection or retry',async()=>{
 const work=await createProjection();
 await pool.query('UPDATE universe SET privacy_epoch=privacy_epoch+1 WHERE id=$1',[work.universeId]);
 assert.deepEqual(await projectOne(),{jobId:work.jobId,status:'discarded'});
 const job=(await pool.query('SELECT status,attempts,completed_at,discarded_at FROM job WHERE id=$1',[work.jobId])).rows[0];
 assert.equal(job.status,'discarded');assert.equal(job.attempts,0);assert.equal(job.completed_at,null);assert.ok(job.discarded_at);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM trace WHERE universe_id=$1',[work.universeId])).rows[0].n,0);
 assert.equal((await pool.query('SELECT revision FROM accounts WHERE universe_id=$1',[work.universeId])).rows[0].revision,0);
 assert.equal((await pool.query('SELECT revision FROM universe WHERE id=$1',[work.universeId])).rows[0].revision,0);
});

test('job and causal Ledger epoch mismatch is discarded',async()=>{
 const work=await createProjection(3);
 await pool.query('UPDATE ledger SET privacy_epoch=2 WHERE id=$1',[work.eventId]);
 assert.deepEqual(await projectOne(),{jobId:work.jobId,status:'discarded'});
 assert.equal((await pool.query('SELECT status FROM job WHERE id=$1',[work.jobId])).rows[0].status,'discarded');
});

test('a locked universe does not block ready work for another universe',async()=>{
 const blocked=await createProjection();
 const available=await createProjection();
 await pool.query("UPDATE job SET available_at='1999-01-01T00:00:00Z' WHERE id=$1",[blocked.jobId]);
 const lock=await pool.connect();await lock.query('BEGIN');
 await lock.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[blocked.universeId]);
 assert.deepEqual(await projectOne(),{jobId:available.jobId,status:'completed'});
 assert.equal((await pool.query('SELECT status FROM job WHERE id=$1',[blocked.jobId])).rows[0].status,'pending');
 await lock.query('COMMIT');lock.release();
 assert.deepEqual(await projectOne(),{jobId:blocked.jobId,status:'completed'});
});

test('projection failure retry settles under the universe lock and later epoch change discards',async()=>{
 const work=await createProjection();
 await pool.query("CREATE FUNCTION reject_worker_epoch_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.universe_id='"+work.universeId+"'::uuid THEN RAISE EXCEPTION 'test crash'; END IF; RETURN NEW; END $$");
 await pool.query('CREATE TRIGGER reject_worker_epoch_projection BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION reject_worker_epoch_projection()');
 try { await assert.rejects(projectOne); }
 finally { await pool.query('DROP TRIGGER reject_worker_epoch_projection ON accounts');await pool.query('DROP FUNCTION reject_worker_epoch_projection()'); }
 assert.equal((await pool.query('SELECT attempts,status FROM job WHERE id=$1',[work.jobId])).rows[0].attempts,1);
 await pool.query('UPDATE universe SET privacy_epoch=privacy_epoch+1 WHERE id=$1',[work.universeId]);
 await pool.query("UPDATE job SET available_at='2000-01-01T00:00:00Z' WHERE id=$1",[work.jobId]);
 assert.deepEqual(await projectOne(),{jobId:work.jobId,status:'discarded'});
});
