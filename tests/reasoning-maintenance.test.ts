import assert from 'node:assert/strict';
import test from 'node:test';

import {createReasoningMaintenance} from '../packages/db/src/reasoning-maintenance.ts';
import {
 ageWithdrawalForTest,seedPurgeableAccounting,seedWithdrawnReasoningGraph,withReasoningMaintenanceSchema,
} from './helpers/reasoning-maintenance-fixture.ts';

test('reasoning maintenance retires only bounded safely withdrawn private graphs',async t=>{
 await t.test('erases an aged withdrawn graph while retaining the independent accounting lane',async()=>{
  await withReasoningMaintenanceSchema('happy',async pool=>{
   const graph=await seedWithdrawnReasoningGraph(pool,{steps:2,contexts:2});
   await ageWithdrawalForTest(pool,graph.jobId,169);
   const maintenance=createReasoningMaintenance(pool);
   assert.deepEqual(await maintenance.runBatch({maxProbes:1}),{probes:1,retiredJobs:1,purgedAccounting:0,skipped:0});
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.count,0);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_step WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
  });
 });

 await t.test('a deletion failure rolls back every private row and surfaces to its sanitized caller',async()=>{
  await withReasoningMaintenanceSchema('rollback',async pool=>{
   const graph=await seedWithdrawnReasoningGraph(pool);
   await ageWithdrawalForTest(pool,graph.jobId,169);
   await pool.query("CREATE FUNCTION reject_maintenance_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced maintenance rollback'; END $$");
   await pool.query('CREATE TRIGGER reject_maintenance_delete BEFORE DELETE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION reject_maintenance_delete()');
   try {await assert.rejects(createReasoningMaintenance(pool).runBatch({maxProbes:1}),/forced maintenance rollback/);}
   finally {await pool.query('DROP TRIGGER reject_maintenance_delete ON reasoning_job');await pool.query('DROP FUNCTION reject_maintenance_delete()');}
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.count,1);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context WHERE job_id=$1',[graph.jobId])).rows[0]!.count,1);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_step WHERE job_id=$1',[graph.jobId])).rows[0]!.count,1);
  });
 });

 await t.test('an oversized private graph is skipped without partial erasure',async()=>{
  await withReasoningMaintenanceSchema('bounds',async pool=>{
   const graph=await seedWithdrawnReasoningGraph(pool,{steps:129});
   await ageWithdrawalForTest(pool,graph.jobId,169);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:1}),{probes:1,retiredJobs:0,purgedAccounting:0,skipped:1});
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.count,1);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_step WHERE job_id=$1',[graph.jobId])).rows[0]!.count,129);
  });
 });

 await t.test('the separate accounting probe uses the existing 30-day purge only for erased identity',async()=>{
  await withReasoningMaintenanceSchema('accounting',async pool=>{
   const graph=await seedWithdrawnReasoningGraph(pool);
   const attemptId=await seedPurgeableAccounting(pool,graph.universeId);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:2}),{probes:2,retiredJobs:0,purgedAccounting:1,skipped:1});
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_accounting WHERE attempt_id=$1',[attemptId])).rows[0]!.count,0);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.count,1);
  });
 });

 await t.test('max probe limits are strict',async()=>{
  await withReasoningMaintenanceSchema('limits',async pool=>{
   const maintenance=createReasoningMaintenance(pool);
   await assert.rejects(maintenance.runBatch({maxProbes:0}),/1 through 128/);
   await assert.rejects(maintenance.runBatch({maxProbes:129}),/1 through 128/);
  });
 });
});
