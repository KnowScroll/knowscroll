import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';

import {authenticateAndLock} from '../packages/db/src/identity.ts';
import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {cancelIdleDirectJob,expireIdleDirectJob,isIdleWithdrawalIneligible} from '../packages/db/src/reasoning-idle-lifecycle.ts';
import {createReasoningMaintenance} from '../packages/db/src/reasoning-maintenance.ts';
import {createReasoningReconciliation} from '../packages/db/src/reasoning-reconciliation.ts';
import {ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';
import {inTransaction,withReasoningContextSchema} from './helpers/reasoning-context-fixture.ts';
import {cancelGraph,expireGraph,makeReservedJobIdle,reserveIdleGraph,seedIdleGraph} from './helpers/reasoning-idle-fixture.ts';
import {ageWithdrawalForTest,seedPurgeableAccounting,seedWithdrawnReasoningGraph} from './helpers/reasoning-maintenance-fixture.ts';

const denied=(code:string)=>(error:unknown)=>error instanceof ReasoningDenied&&error.code===code;
async function job(pool:pg.Pool,id:string) {
 return (await pool.query('SELECT status,lease_fence::text,lease_owner,lease_expires_at,withdrawn_at FROM reasoning_job WHERE id=$1',[id])).rows[0];
}

test('idle direct closure requires original authority, fences once and has write-free replay',async()=>{
 await withReasoningContextSchema('idle_cancel',async pool=>{
  const graph=await seedIdleGraph(pool);
  // Failed Steps are terminal evidence, not unfinished work to cancel.
  await pool.query("UPDATE reasoning_step SET status='failed' WHERE id=$1",[graph.stepId]);
  assert.deepEqual(await cancelGraph(pool,graph),{status:'cancelled',changed:true,closedNotSent:0,preservedUnknown:0});
  const first=await job(pool,graph.jobId);
  assert.equal(first.lease_fence,'1');assert(first.withdrawn_at instanceof Date);
  assert.equal((await pool.query('SELECT status FROM reasoning_step WHERE id=$1',[graph.stepId])).rows[0].status,'failed');
  // A trigger makes any accidental replay write observable, including a same-value write.
  await pool.query(`CREATE FUNCTION reject_idle_replay_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'replay wrote'; END $$`);
  for(const table of ['reasoning_job','reasoning_step','reasoning_accounting','reasoning_fairness_scheduler']) {
   await pool.query(`CREATE TRIGGER reject_idle_replay BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_idle_replay_write()`);
  }
  assert.deepEqual(await cancelGraph(pool,graph),{status:'cancelled',changed:false,closedNotSent:0,preservedUnknown:0});
  assert.deepEqual(await job(pool,graph.jobId),first);
  assert.equal((await pool.query('SELECT count(*)::int n FROM ledger WHERE universe_id=$1',[graph.scope.universeId])).rows[0].n,2);
  await assert.rejects(expireGraph(pool,graph),denied('idle_job_ineligible'));
 });
});

test('trusted expiry uses actual elapsed Job deadline even with a revoked expired original session',async()=>{
 await withReasoningContextSchema('idle_expire',async pool=>{
  const graph=await seedIdleGraph(pool);
  await assert.rejects(expireGraph(pool,graph),denied('idle_deadline_not_elapsed'));
  await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[graph.jobId]);
  await pool.query("UPDATE device_session SET expires_at=created_at+interval '1 millisecond',revoked_at=clock_timestamp() WHERE id=$1",[graph.scope.sessionId]);
  await assert.rejects(inTransaction(pool,c=>cancelIdleDirectJob(c,graph.scope,{jobId:graph.jobId})),denied('idle_session_authority'));
  assert.deepEqual(await expireGraph(pool,graph),{status:'expired',changed:true,closedNotSent:0,preservedUnknown:0});
  const first=await job(pool,graph.jobId);
  assert.deepEqual(await expireGraph(pool,graph),{status:'expired',changed:false,closedNotSent:0,preservedUnknown:0});
  assert.deepEqual(await job(pool,graph.jobId),first);
 });
});

test('idle closure denies missing binding, forged device, stale epoch, running work and fence overflow',async()=>{
 await withReasoningContextSchema('idle_denials',async pool=>{
  const graph=await seedIdleGraph(pool);
  await assert.rejects(inTransaction(pool,c=>cancelIdleDirectJob(c,{...graph.scope,deviceId:randomUUID()},{jobId:graph.jobId})),denied('idle_session_authority'));
  await assert.rejects(inTransaction(pool,c=>expireIdleDirectJob(c,{jobId:graph.jobId,universeId:graph.scope.universeId,privacyEpoch:1})),denied('idle_stale_epoch'));
  await assert.rejects(inTransaction(pool,c=>cancelIdleDirectJob(c,{...graph.scope,sessionId:randomUUID()},{jobId:graph.jobId})),denied('idle_original_session_required'));
  await pool.query("UPDATE reasoning_job SET status='running' WHERE id=$1",[graph.jobId]);
  await assert.rejects(cancelGraph(pool,graph),denied('idle_job_ineligible'));
  await pool.query("UPDATE reasoning_job SET status='queued',lease_fence=9223372036854775807 WHERE id=$1",[graph.jobId]);
  await assert.rejects(cancelGraph(pool,graph),denied('idle_fence_overflow'));
  const unboundJobId=randomUUID();
  await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
    SELECT $2,universe_id,privacy_epoch,'queued',class,budget_owner_id,policy_version,deadline,wake_kind,$3 FROM reasoning_job WHERE id=$1`,
    [graph.jobId,unboundJobId,randomUUID()]);
  await assert.rejects(inTransaction(pool,c=>cancelIdleDirectJob(c,graph.scope,{jobId:unboundJobId})),denied('idle_missing_binding'));
  assert.equal((await job(pool,graph.jobId)).withdrawn_at,null);
 });
});

test('reserved closure refunds only not_sent before clamping idle fairness credit',async()=>{
 await withReasoningContextSchema('idle_refund',async pool=>{
  const graph=await seedIdleGraph(pool),fairness=createReasoningFairness(pool,graph.authority);
  const policyVersion=graph.policy.policyVersion;
  await fairness.installPolicy({version:policyVersion,quantum:100,maxCharge:100,scale:100,basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes:8,maxAdmissions:1});
  await fairness.enqueue({policyVersion,class:'interactive',universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,
   stepId:graph.stepId,contextId:graph.contextId,requestId:randomUUID(),requestHash:'c'.repeat(64),inputTokensUpperBound:1,maxOutputTokens:1,
   costCeilingMicroUsd:null,deadline:new Date(Date.now()+60_000).toISOString(),permitTtlMs:30_000});
  const scheduled=await fairness.schedule({policyVersion,owner:'idle-fixture',leaseMs:30_000});
  assert.equal(scheduled.kind,'admitted');if(scheduled.kind!=='admitted') throw new Error('Missing fixture reservation');
  await assert.rejects(cancelGraph(pool,graph),denied('idle_job_ineligible')); // running even with healthy lease
  await makeReservedJobIdle(pool,graph);
  // A proven refund may reduce debt; positive idle credit is then clamped.
  await pool.query("UPDATE reasoning_fairness_class SET credit=-1 WHERE policy_version=$1 AND class='interactive'",[policyVersion]);
  await pool.query("UPDATE reasoning_fairness_universe SET credit=-1 WHERE policy_version=$1 AND class='interactive'",[policyVersion]);
  const generation=BigInt((await pool.query('SELECT generation FROM reasoning_fairness_scheduler WHERE policy_version=$1',[policyVersion])).rows[0].generation);
  assert.deepEqual(await cancelGraph(pool,graph),{status:'cancelled',changed:true,closedNotSent:1,preservedUnknown:0});
  assert.deepEqual((await pool.query('SELECT state,output_authority,liability_state,remote_state FROM reasoning_accounting WHERE attempt_id=$1',[scheduled.reserved.attemptId])).rows[0],
   {state:'not_sent',output_authority:'withdrawn',liability_state:'settled',remote_state:'released'});
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_bucket WHERE reserved<>0 OR consumed<>0')).rows[0].n,0);
  assert.equal((await pool.query('SELECT credit FROM reasoning_fairness_universe WHERE universe_id=$1',[graph.scope.universeId])).rows[0].credit,'0');
  assert.equal((await pool.query("SELECT credit FROM reasoning_fairness_class WHERE policy_version=$1 AND class='interactive'",[policyVersion])).rows[0].credit,'0');
  assert.equal(BigInt((await pool.query('SELECT generation FROM reasoning_fairness_scheduler WHERE policy_version=$1',[policyVersion])).rows[0].generation),generation+2n);
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_delta WHERE attempt_id=$1 AND revision=0',[scheduled.reserved.attemptId])).rows[0].n,1);
 });
});

test('recovered unknown closure preserves holds and late original usage can settle without output authority',async()=>{
 await withReasoningContextSchema('idle_unknown',async pool=>{
  const graph=await seedIdleGraph(pool),reserved=await reserveIdleGraph(pool,graph),dispatchId=randomUUID();
  await graph.admission.authorizeDispatch({...reserved.input,attemptId:reserved.reserved.attemptId,dispatchId});
  await pool.query("UPDATE reasoning_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[graph.jobId]);
  await graph.admission.recoverAttempt({universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId:graph.stepId,
   attemptId:reserved.reserved.attemptId,owner:'recovery-fixture'});
  const buckets=(await pool.query('SELECT id,reserved,consumed FROM reasoning_bucket ORDER BY id')).rows;
  assert.deepEqual(await cancelGraph(pool,graph),{status:'cancelled',changed:true,closedNotSent:0,preservedUnknown:1});
  assert.deepEqual((await pool.query('SELECT id,reserved,consumed FROM reasoning_bucket ORDER BY id')).rows,buckets);
  assert.deepEqual((await pool.query('SELECT state,output_authority,liability_state,remote_state FROM reasoning_accounting WHERE attempt_id=$1',[reserved.reserved.attemptId])).rows[0],
   {state:'unknown',output_authority:'withdrawn',liability_state:'held',remote_state:'held'});
  const receipt={version:1,receiptId:randomUUID(),attemptId:reserved.reserved.attemptId,requestId:reserved.input.requestId,dispatchId,
   routeId:graph.policy.routeId,routeProfileVersion:graph.policy.routeProfileVersion,evidenceKind:'original_transport',observedAt:new Date().toISOString(),
   remoteDisposition:'terminal',outcome:'success',httpStatus:200,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}};
  const settled=await createReasoningReconciliation(pool).recordAndSettleReceipt(receipt,'worker');
  assert.equal(settled.reviewRequired,false);
  assert.deepEqual((await pool.query('SELECT state,output_authority,liability_state,remote_state FROM reasoning_accounting WHERE attempt_id=$1',[reserved.reserved.attemptId])).rows[0],
   {state:'responded',output_authority:'withdrawn',liability_state:'settled',remote_state:'released'});
  assert.equal((await job(pool,graph.jobId)).status,'cancelled');
 });
});

test('a final Job SQL failure rolls back reservations, children, fairness and withdrawal together',async()=>{
 await withReasoningContextSchema('idle_rollback',async pool=>{
  const graph=await seedIdleGraph(pool),reserved=await reserveIdleGraph(pool,graph);
  await makeReservedJobIdle(pool,graph);
  const before=await job(pool,graph.jobId),buckets=(await pool.query('SELECT id,reserved,consumed FROM reasoning_bucket ORDER BY id')).rows;
  await pool.query(`CREATE FUNCTION fail_idle_stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'forced idle rollback'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER fail_idle_stamp BEFORE UPDATE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION fail_idle_stamp()');
  await assert.rejects(cancelGraph(pool,graph),/forced idle rollback/);
  assert.deepEqual(await job(pool,graph.jobId),before);
  assert.deepEqual((await pool.query('SELECT id,reserved,consumed FROM reasoning_bucket ORDER BY id')).rows,buckets);
  assert.equal((await pool.query('SELECT state FROM reasoning_accounting WHERE attempt_id=$1',[reserved.reserved.attemptId])).rows[0].state,'reserved');
  assert.equal((await pool.query('SELECT active FROM reasoning_attempt WHERE id=$1',[reserved.reserved.attemptId])).rows[0].active,true);
 });
});

test('unsafe reservation vectors refuse closure and oversized graphs are bounded before loading children',async()=>{
 await withReasoningContextSchema('idle_unsafe_graph',async pool=>{
  const graph=await seedIdleGraph(pool),reserved=await reserveIdleGraph(pool,graph);
  await makeReservedJobIdle(pool,graph);
  await pool.query("UPDATE reasoning_reservation SET state='accounted' WHERE attempt_id=$1",[reserved.reserved.attemptId]);
  await assert.rejects(cancelGraph(pool,graph),denied('idle_unsafe_attempt'));
  assert.equal((await job(pool,graph.jobId)).withdrawn_at,null);
  const oversized=await seedIdleGraph(pool);
  await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
    SELECT gen_random_uuid(),$1,$2,0,$3,ordinal,'pending' FROM generate_series(2,129) ordinal`,
    [oversized.jobId,oversized.scope.universeId,oversized.contextId]);
  await assert.rejects(cancelGraph(pool,oversized),denied('idle_graph_too_large'));
  for(const candidate of [graph,oversized]) await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[candidate.jobId]);
  assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:4}),{probes:4,expiredJobs:0,retiredJobs:0,purgedAccounting:0,skipped:4});
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_step WHERE job_id=$1',[oversized.jobId])).rows[0].n,129);
 });
});

test('maintenance rotates three lanes across one-probe batches and counts only changed expiry',async()=>{
 await withReasoningContextSchema('idle_three_lanes',async pool=>{
  const idle=await seedIdleGraph(pool),aged=await seedWithdrawnReasoningGraph(pool);
  await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[idle.jobId]);
  await ageWithdrawalForTest(pool,aged.jobId);
  const accountingId=await seedPurgeableAccounting(pool,aged.universeId),maintenance=createReasoningMaintenance(pool);
  const aborted=new AbortController();aborted.abort();
  assert.deepEqual(await maintenance.runBatch({maxProbes:1,signal:aborted.signal}),{probes:0,expiredJobs:0,retiredJobs:0,purgedAccounting:0,skipped:0});
  assert.deepEqual(await maintenance.runBatch({maxProbes:1}),{probes:1,expiredJobs:1,retiredJobs:0,purgedAccounting:0,skipped:0});
  // Retirement may first see the newly stamped, too-young Job; bounded keyset
  // progress reaches the aged candidate on the next retirement turn.
  const totals={expiredJobs:0,retiredJobs:0,purgedAccounting:0};
  for(let probe=0;probe<8;probe+=1) {
   const result=await maintenance.runBatch({maxProbes:1});
   assert.equal(result.probes,1);for(const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key]+=result[key];
  }
  assert.deepEqual(totals,{expiredJobs:0,retiredJobs:1,purgedAccounting:1});
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_accounting WHERE attempt_id=$1',[accountingId])).rows[0].n,0);
 });
});

test('expiry probes advance past a healthy lease and locked universe, but unexpected SQL errors surface',async()=>{
 await withReasoningContextSchema('idle_progress',async pool=>{
  const graphs=[await seedIdleGraph(pool),await seedIdleGraph(pool),await seedIdleGraph(pool)].sort((a,b)=>a.jobId.localeCompare(b.jobId));
  for(const graph of graphs) await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[graph.jobId]);
  const [locked,healthy,open]=graphs;assert(locked&&healthy&&open);
  await pool.query("UPDATE reasoning_job SET lease_owner='healthy-fixture',lease_fence=1,lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[healthy.jobId]);
  const holder=await pool.connect();
  try {
   await holder.query('BEGIN');await holder.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[locked.scope.universeId]);
   const result=await createReasoningMaintenance(pool).runBatch({maxProbes:7});
   assert.equal(result.probes,7);assert.equal(result.expiredJobs,1);assert.equal(result.retiredJobs,0);
   assert.equal((await job(pool,open.jobId)).status,'expired');assert.equal((await job(pool,healthy.jobId)).status,'queued');
  } finally {await holder.query('ROLLBACK');holder.release();}
  await pool.query(`CREATE FUNCTION fail_idle_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'expiry SQL failed'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER fail_idle_expiry BEFORE UPDATE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION fail_idle_expiry()');
  await assert.rejects(createReasoningMaintenance(pool).runBatch({maxProbes:1}),/expiry SQL failed/);
  assert.equal((await job(pool,locked.jobId)).status,'queued');
  assert.equal(isIdleWithdrawalIneligible(new Error('unexpected')),false);
 });
});

test('scope is rechecked after a resource wait and cancellation does not retain expired session authority',async()=>{
 await withReasoningContextSchema('idle_session_wait',async pool=>{
  const graph=await seedIdleGraph(pool);await reserveIdleGraph(pool,graph);await makeReservedJobIdle(pool,graph);
  await pool.query("UPDATE device_session SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[graph.scope.sessionId]);
  const holder=await pool.connect();
  try {
   await holder.query('BEGIN');await holder.query('SELECT id FROM reasoning_bucket WHERE id=$1 FOR UPDATE',[graph.policy.buckets[0]!.bucketId]);
   const pending=cancelGraph(pool,graph);void pending.catch(()=>{});
   let waited=false;
   for(let probe=0;probe<100;probe+=1) {
    if((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM reasoning_bucket%' ")).rowCount) {waited=true;break;}
    await new Promise(resolve=>setTimeout(resolve,5));
   }
   assert(waited,'cancellation reached the physical resource wait');
   for(let probe=0;probe<200;probe+=1) {
    if((await pool.query('SELECT expires_at<=clock_timestamp() AS elapsed FROM device_session WHERE id=$1',[graph.scope.sessionId])).rows[0].elapsed) break;
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   await holder.query('ROLLBACK');
   await assert.rejects(pending,denied('idle_session_authority'));
   assert.equal((await job(pool,graph.jobId)).withdrawn_at,null);
   assert.equal((await pool.query("SELECT count(*)::int n FROM reasoning_accounting WHERE state='reserved'")).rows[0].n,1);
  } finally {await holder.query('ROLLBACK');holder.release();}
 });
});
