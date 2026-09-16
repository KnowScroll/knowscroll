import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {createReasoningMaintenance} from '../packages/db/src/reasoning-maintenance.ts';
import {
 ageWithdrawalForTest,seedWithdrawnReasoningGraph,withReasoningMaintenanceSchema,
} from './helpers/reasoning-maintenance-fixture.ts';

async function insertLeasedJob(pool:import('pg').Pool, status:'running'|'waiting'='running') {
 const universeId=randomUUID(),jobId=randomUUID(),intentId=randomUUID();
 await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
 await pool.query(`INSERT INTO reasoning_job
  (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id,lease_owner,lease_fence,lease_expires_at)
  VALUES($1,$2,0,$3,'interactive',$2,'maintenance-adversarial',clock_timestamp()+interval '1 hour','direct',$4,'maintenance-adversarial',1,clock_timestamp()+interval '1 hour')`,
 [jobId,universeId,status,intentId]);
 return {universeId,jobId};
}

test('reasoning retirement adversarial SQL boundaries',async t=>{
 await t.test('the database clock, not a caller timestamp, begins a safe retirement period',async()=>{
  await withReasoningMaintenanceSchema('clock-guard',async pool=>{
   const live=await insertLeasedJob(pool);
   const supplied='2000-01-01T00:00:00.000Z';
   const stamped=(await pool.query<{withdrawn_at:Date}>(`UPDATE reasoning_job
    SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,withdrawn_at=$2
    WHERE id=$1 RETURNING withdrawn_at`,[live.jobId,supplied])).rows[0]!.withdrawn_at;
   assert(stamped.getTime()>Date.parse('2020-01-01T00:00:00.000Z'));
   await assert.rejects(pool.query("UPDATE reasoning_job SET withdrawn_at=clock_timestamp()-interval '9 days' WHERE id=$1",[live.jobId]),/cannot reactivate or change its retention clock/);
   await assert.rejects(pool.query("UPDATE reasoning_job SET status='running' WHERE id=$1",[live.jobId]),/cannot reactivate or change its retention clock/);
  });
 });

 await t.test('an unleased recovered waiting Job cannot acquire a retirement timestamp through raw SQL',async()=>{
  await withReasoningMaintenanceSchema('unleased-waiting',async pool=>{
   const waiting=await insertLeasedJob(pool,'waiting');
   await pool.query('UPDATE reasoning_job SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1',[waiting.jobId]);
   await assert.rejects(pool.query(`UPDATE reasoning_job
    SET status='cancelled',withdrawn_at=clock_timestamp() WHERE id=$1`,[waiting.jobId]),/requires a safely withdrawn Job/);
   assert.deepEqual((await pool.query('SELECT status,withdrawn_at FROM reasoning_job WHERE id=$1',[waiting.jobId])).rows[0],{status:'waiting',withdrawn_at:null});
  });
 });

 await t.test('a graph is retained just before 168 hours and becomes eligible after the boundary',async()=>{
  await withReasoningMaintenanceSchema('seven-day-boundary',async pool=>{
   const graph=await seedWithdrawnReasoningGraph(pool);
   await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_withdrawal_clock_guard');
   try {await pool.query("UPDATE reasoning_job SET withdrawn_at=clock_timestamp()-interval '168 hours'+interval '1 second' WHERE id=$1",[graph.jobId]);}
   finally {await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_withdrawal_clock_guard');}
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:1}),{probes:1,retiredJobs:0,purgedAccounting:0,skipped:1});
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.count,1);
   await ageWithdrawalForTest(pool,graph.jobId,168);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:1}),{probes:1,retiredJobs:1,purgedAccounting:0,skipped:0});
  });
 });

 await t.test('two workers racing one due Job erase its private graph once and retain its accounting identity',async()=>{
  await withReasoningMaintenanceSchema('same-job-race',async pool=>{
   const graph=await seedWithdrawnReasoningGraph(pool);
   await ageWithdrawalForTest(pool,graph.jobId);
   const [first,second]=await Promise.all([
    createReasoningMaintenance(pool).runBatch({maxProbes:1}),
    createReasoningMaintenance(pool).runBatch({maxProbes:1}),
   ]);
   assert.equal(first.retiredJobs+second.retiredJobs,1);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.count,0);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
  });
 });

 await t.test('a locked universe is skipped and the next keyset candidate is processed in the same bounded batch',async()=>{
  await withReasoningMaintenanceSchema('locked-universe',async pool=>{
   const first=await seedWithdrawnReasoningGraph(pool),second=await seedWithdrawnReasoningGraph(pool);
   await ageWithdrawalForTest(pool,first.jobId);await ageWithdrawalForTest(pool,second.jobId);
   const [locked,open]=[first,second].sort((a,b)=>a.jobId.localeCompare(b.jobId));
   const holder=await pool.connect();
   try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[locked.universeId]);
    const result=await createReasoningMaintenance(pool).runBatch({maxProbes:3});
    assert.deepEqual(result,{probes:3,retiredJobs:1,purgedAccounting:0,skipped:2});
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[locked.jobId])).rows[0]!.count,1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[open.jobId])).rows[0]!.count,0);
   } finally {await holder.query('ROLLBACK');holder.release();}
  });
 });
});
