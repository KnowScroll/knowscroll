import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';

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

async function waitFor(check:()=>Promise<boolean>,label:string):Promise<void> {
 for(let attempt=0;attempt<70;attempt+=1) {
  if(await check()) return;
  await sleep(5);
 }
 throw new Error(`maintenance adversarial barrier timed out: ${label}`);
}

async function attachActiveAttempt(pool:import('pg').Pool,graph:{universeId:string;jobId:string;contextIds:string[];stepIds:string[]}):Promise<void> {
 const attemptId=randomUUID(),permitId=randomUUID(),reservationSetId=randomUUID();
 await pool.query(`INSERT INTO reasoning_accounting
  (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,state,output_authority,remote_disposition)
  VALUES($1,$2,0,$3,'maintenance-adversarial','maintenance-adversarial',1,clock_timestamp()+interval '1 hour','not_sent','withdrawn','not_sent')`,
 [attemptId,graph.universeId,randomUUID()]);
 await pool.query(`INSERT INTO reasoning_permit(id,attempt_id,universe_id,privacy_epoch,reservation_set_id,expires_at)
  VALUES($1,$2,$3,0,$4,clock_timestamp()+interval '1 hour')`,[permitId,attemptId,graph.universeId,reservationSetId]);
 await pool.query(`INSERT INTO reasoning_attempt
  (id,job_id,step_id,context_id,universe_id,privacy_epoch,ordinal,lease_fence,request_hash,permit_id,reservation_set_id,active)
  VALUES($1,$2,$3,$4,$5,0,1,1,$6,$7,$8,true)`,
 [attemptId,graph.jobId,graph.stepIds[0]!,graph.contextIds[0]!,graph.universeId,'b'.repeat(64),permitId,reservationSetId]);
}

async function attachFairReady(pool:import('pg').Pool,graph:{universeId:string;jobId:string;contextIds:string[];stepIds:string[]}):Promise<void> {
 const policy='maintenance-adversarial';
 await pool.query("INSERT INTO reasoning_fairness_policy(version,policy_hash,config) VALUES($1,$2,'{}')",[policy,'c'.repeat(64)]);
 await pool.query('INSERT INTO reasoning_fairness_scheduler(policy_version) VALUES($1)',[policy]);
 await pool.query("INSERT INTO reasoning_fairness_class(policy_version,class) VALUES($1,'interactive')",[policy]);
 await pool.query("INSERT INTO reasoning_fairness_universe(policy_version,class,universe_id) VALUES($1,'interactive',$2)",[policy,graph.universeId]);
 await pool.query(`INSERT INTO reasoning_fairness_ready
  (job_id,step_id,context_id,universe_id,privacy_epoch,class,policy_version,request_id,request_hash,input_tokens_upper_bound,max_output_tokens,deadline,permit_ttl_ms,charge)
  VALUES($1,$2,$3,$4,0,'interactive',$5,$6,$7,1,1,clock_timestamp()+interval '1 hour',100,1)`,
 [graph.jobId,graph.stepIds[0]!,graph.contextIds[0]!,graph.universeId,policy,randomUUID(),'d'.repeat(64)]);
}

test('reasoning retirement adversarial SQL boundaries',async t=>{
 await t.test('the database clock, not a caller timestamp, begins a safe retirement period',async()=>{
  await withReasoningMaintenanceSchema('clock_guard',async pool=>{
   const live=await insertLeasedJob(pool);
   const supplied='2000-01-01T00:00:00.000Z';
   const before=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   const stamped=(await pool.query<{withdrawn_at:Date}>(`UPDATE reasoning_job
    SET status='cancelled',lease_owner=NULL,lease_expires_at=NULL,withdrawn_at=$2
    WHERE id=$1 RETURNING withdrawn_at`,[live.jobId,supplied])).rows[0]!.withdrawn_at;
   const after=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   assert(stamped.getTime()>=before.getTime()&&stamped.getTime()<=after.getTime());
   await assert.rejects(pool.query("UPDATE reasoning_job SET withdrawn_at=clock_timestamp()-interval '9 days' WHERE id=$1",[live.jobId]),/cannot reactivate or change its retention clock/);
   await assert.rejects(pool.query("UPDATE reasoning_job SET status='running' WHERE id=$1",[live.jobId]),/cannot reactivate or change its retention clock/);
  });
 });

 await t.test('an unleased recovered waiting Job cannot acquire a retirement timestamp through raw SQL',async()=>{
  await withReasoningMaintenanceSchema('unleased_waiting',async pool=>{
   const waiting=await insertLeasedJob(pool,'waiting');
   await pool.query('UPDATE reasoning_job SET lease_owner=NULL,lease_expires_at=NULL WHERE id=$1',[waiting.jobId]);
   await assert.rejects(pool.query(`UPDATE reasoning_job
    SET status='cancelled',withdrawn_at=clock_timestamp() WHERE id=$1`,[waiting.jobId]),/requires a safely withdrawn Job/);
   assert.deepEqual((await pool.query('SELECT status,withdrawn_at FROM reasoning_job WHERE id=$1',[waiting.jobId])).rows[0],{status:'waiting',withdrawn_at:null});
  });
 });

 await t.test('a graph is retained one minute before 168 hours and becomes eligible after the boundary',async()=>{
  await withReasoningMaintenanceSchema('seven_day_boundary',async pool=>{
   const graph=await seedWithdrawnReasoningGraph(pool);
   await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_withdrawal_clock_guard');
   try {await pool.query("UPDATE reasoning_job SET withdrawn_at=clock_timestamp()-interval '168 hours'+interval '1 minute' WHERE id=$1",[graph.jobId]);}
   finally {await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_withdrawal_clock_guard');}
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:1}),{probes:1,retiredJobs:0,purgedAccounting:0,skipped:1});
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.count,1);
   await ageWithdrawalForTest(pool,graph.jobId,168);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:1}),{probes:1,retiredJobs:1,purgedAccounting:0,skipped:0});
  });
 });

 await t.test('two workers racing one due Job erase its private graph once',async()=>{
  await withReasoningMaintenanceSchema('same_job_race',async pool=>{
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

 await t.test('post-stamp nonterminal, fair-ready, and active-attempt mutations each refuse erasure',async()=>{
  await withReasoningMaintenanceSchema('post_stamp_guards',async pool=>{
   const nonterminal=await seedWithdrawnReasoningGraph(pool);
   await ageWithdrawalForTest(pool,nonterminal.jobId);
   await pool.query("UPDATE reasoning_step SET status='pending' WHERE id=$1",[nonterminal.stepIds[0]]);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:1}),{probes:1,retiredJobs:0,purgedAccounting:0,skipped:1});
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[nonterminal.jobId])).rows[0]!.count,1);

   const ready=await seedWithdrawnReasoningGraph(pool);
   await ageWithdrawalForTest(pool,ready.jobId);await attachFairReady(pool,ready);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:3}),{probes:3,retiredJobs:0,purgedAccounting:0,skipped:3});
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[ready.jobId])).rows[0]!.count,1);

   const active=await seedWithdrawnReasoningGraph(pool);
   await ageWithdrawalForTest(pool,active.jobId);await attachActiveAttempt(pool,active);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:5}),{probes:5,retiredJobs:0,purgedAccounting:0,skipped:5});
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[active.jobId])).rows[0]!.count,1);
  });
 });

 await t.test('a locked universe is skipped and the next keyset candidate is processed in the same bounded batch',async()=>{
  await withReasoningMaintenanceSchema('locked_universe',async pool=>{
   const first=await seedWithdrawnReasoningGraph(pool),second=await seedWithdrawnReasoningGraph(pool);
   await ageWithdrawalForTest(pool,first.jobId);await ageWithdrawalForTest(pool,second.jobId);
   const ordered=[first,second].sort((a,b)=>a.jobId.localeCompare(b.jobId));
   const locked=ordered[0]!,open=ordered[1]!;
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

 await t.test('an abort after an in-flight SQL probe commits that probe and starts no next probe',async()=>{
  await withReasoningMaintenanceSchema('abort_between_probes',async pool=>{
   const first=await seedWithdrawnReasoningGraph(pool),second=await seedWithdrawnReasoningGraph(pool);
   await ageWithdrawalForTest(pool,first.jobId);await ageWithdrawalForTest(pool,second.jobId);
   const ordered=[first,second].sort((a,b)=>a.jobId.localeCompare(b.jobId));
   const blocked=ordered[0]!,untouched=ordered[1]!;
   await pool.query('CREATE TABLE maintenance_barrier(id integer PRIMARY KEY)');
   await pool.query('INSERT INTO maintenance_barrier(id) VALUES(1)');
   await pool.query(`CREATE FUNCTION block_context_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM 1 FROM maintenance_barrier WHERE id=1 FOR UPDATE; RETURN OLD; END $$`);
   await pool.query('CREATE TRIGGER block_context_retirement BEFORE DELETE ON reasoning_context FOR EACH ROW EXECUTE FUNCTION block_context_retirement()');
   const holder=await pool.connect(),stop=new AbortController();
   try {
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM maintenance_barrier WHERE id=1 FOR UPDATE');
    const pending=createReasoningMaintenance(pool).runBatch({maxProbes:3,signal:stop.signal});
    await waitFor(async()=>Number((await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
      WHERE datname=current_database() AND state='active' AND wait_event_type='Lock' AND query LIKE '%DELETE FROM reasoning_context%'`)).rows[0]!.count)===1,'context delete lock');
    stop.abort();
    await holder.query('ROLLBACK');
    assert.deepEqual(await pending,{probes:1,retiredJobs:1,purgedAccounting:0,skipped:0});
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[blocked.jobId])).rows[0]!.count,0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[untouched.jobId])).rows[0]!.count,1);
   } finally {await holder.query('ROLLBACK');holder.release();}
  });
 });
});
