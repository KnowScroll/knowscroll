import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {withReasoningContextSchema} from './helpers/reasoning-context-fixture.ts';
import {seedIdleGraph} from './helpers/reasoning-idle-fixture.ts';

test('one scheduler probe expires a bound Job with a not_sent fairness refund and no stale class yield',async()=>{
 await withReasoningContextSchema('idle_scheduler_refund',async pool=>{
  const graph=await seedIdleGraph(pool),policyVersion=graph.policy.policyVersion;
  const fairness=createReasoningFairness(pool,graph.authority);
  await fairness.installPolicy({version:policyVersion,quantum:100,maxCharge:100,scale:100,
   basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes:1,maxAdmissions:1});
  const enqueue=(stepId:string)=>fairness.enqueue({policyVersion,class:'interactive',universeId:graph.scope.universeId,
   privacyEpoch:0,jobId:graph.jobId,stepId,contextId:graph.contextId,requestId:randomUUID(),requestHash:'d'.repeat(64),
   inputTokensUpperBound:1,maxOutputTokens:1,costCeilingMicroUsd:null,deadline:new Date(Date.now()+60_000).toISOString(),permitTtlMs:30_000});
  await enqueue(graph.stepId);
  const reserved=await fairness.schedule({policyVersion,owner:'idle-refund-scheduler',leaseMs:30_000});
  assert.equal(reserved.kind,'admitted',JSON.stringify(reserved));
  if(reserved.kind!=='admitted') throw new Error('Fixture needs a real fair reservation');
  assert.equal(reserved.probes,1);assert.equal(reserved.charge,2);
  assert.equal((await pool.query("SELECT count(*)::int n FROM reasoning_reservation WHERE attempt_id=$1 AND state='held'",[reserved.reserved.attemptId])).rows[0].n,6);

  // Model an idle queued graph with its original provably unsent Attempt still
  // present and a pending replacement Step. No recovery or provider is faked.
  await pool.query("UPDATE reasoning_job SET status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[graph.jobId]);
  const replacementStepId=randomUUID();
  await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
   VALUES($1,$2,$3,0,$4,2,'pending')`,[replacementStepId,graph.jobId,graph.scope.universeId,graph.contextId]);
  await enqueue(replacementStepId);
  await pool.query("UPDATE reasoning_fairness_class SET credit=-1 WHERE policy_version=$1 AND class='interactive'",[policyVersion]);
  await pool.query("UPDATE reasoning_fairness_universe SET credit=-1 WHERE policy_version=$1 AND class='interactive' AND universe_id=$2",[policyVersion,graph.scope.universeId]);
  await pool.query('UPDATE reasoning_fairness_scheduler SET class_cursor=0 WHERE policy_version=$1',[policyVersion]);
  await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[graph.jobId]);
  const before=(await pool.query('SELECT generation::text,class_cursor,visit_generation::text,inner_generation::text FROM reasoning_fairness_scheduler WHERE policy_version=$1',[policyVersion])).rows[0];
  const beforeClock=(await pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  // Capture committed scheduler writes, so an extra final class yield is visible.
  await pool.query(`CREATE TABLE idle_refund_scheduler_updates(old_generation bigint,new_generation bigint,old_cursor integer,new_cursor integer);
   CREATE FUNCTION record_idle_refund_scheduler_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    INSERT INTO idle_refund_scheduler_updates VALUES(OLD.generation,NEW.generation,OLD.class_cursor,NEW.class_cursor);
    RETURN NEW; END $$;
   CREATE TRIGGER record_idle_refund_scheduler_update AFTER UPDATE ON reasoning_fairness_scheduler
    FOR EACH ROW EXECUTE FUNCTION record_idle_refund_scheduler_update()`);

  const result=await fairness.schedule({policyVersion,owner:'idle-refund-scheduler',leaseMs:30_000});
  assert.equal(result.probes,1);assert.equal(result.kind,'ineligible');
  assert(result.observations.some(observation=>observation.jobId===graph.jobId&&observation.reason==='deadline_missed'));
  const after=(await pool.query('SELECT generation::text,class_cursor,visit_generation::text,inner_generation::text FROM reasoning_fairness_scheduler WHERE policy_version=$1',[policyVersion])).rows[0];
  assert.equal(BigInt(after.generation),BigInt(before.generation)+2n,'one proven refund and one idle finalizer generation');
  assert.equal(after.class_cursor,before.class_cursor,'bounded scan must not yield the closed class again');
  assert.equal(after.visit_generation,before.visit_generation);assert.equal(after.inner_generation,before.inner_generation);
  const writes=(await pool.query('SELECT old_generation::text,new_generation::text,old_cursor,new_cursor FROM idle_refund_scheduler_updates ORDER BY old_generation')).rows;
  assert.equal(writes.length,2,'no third scheduler save after terminal expiry');
  for(const write of writes) {
   assert.equal(BigInt(write.new_generation),BigInt(write.old_generation)+1n);
   assert.equal(write.old_cursor,before.class_cursor);assert.equal(write.new_cursor,before.class_cursor);
  }
  const job=(await pool.query('SELECT status,lease_fence::text,lease_owner,lease_expires_at,withdrawn_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0];
  assert.equal(job.status,'expired');assert.equal(BigInt(job.lease_fence),BigInt(reserved.claim.leaseFence)+1n);
  assert.equal(job.lease_owner,null);assert.equal(job.lease_expires_at,null);
  const afterClock=(await pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  assert(job.withdrawn_at instanceof Date&&job.withdrawn_at>=beforeClock&&job.withdrawn_at<=afterClock);
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_ready WHERE job_id=$1',[graph.jobId])).rows[0].n,0);
  assert.deepEqual((await pool.query('SELECT credit::text,ready_count::text,candidate_cursor::text FROM reasoning_fairness_universe WHERE policy_version=$1 AND universe_id=$2',[policyVersion,graph.scope.universeId])).rows[0],
   {credit:'0',ready_count:'0',candidate_cursor:'0'});
  assert.deepEqual((await pool.query("SELECT credit::text,remaining,open_universe_id,universe_remaining::text,universe_cursor FROM reasoning_fairness_class WHERE policy_version=$1 AND class='interactive'",[policyVersion])).rows[0],
   {credit:'0',remaining:null,open_universe_id:null,universe_remaining:'0',universe_cursor:null});
  assert.deepEqual((await pool.query('SELECT state,output_authority,liability_state,remote_state FROM reasoning_accounting WHERE attempt_id=$1',[reserved.reserved.attemptId])).rows[0],
   {state:'not_sent',output_authority:'withdrawn',liability_state:'settled',remote_state:'released'});
  assert.equal((await pool.query('SELECT active FROM reasoning_attempt WHERE id=$1',[reserved.reserved.attemptId])).rows[0].active,false);
  assert.equal((await pool.query('SELECT state FROM reasoning_permit WHERE id=$1',[reserved.reserved.permitId])).rows[0].state,'revoked');
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_bucket WHERE reserved<>0 OR consumed<>0')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_delta WHERE attempt_id=$1 AND revision=0',[reserved.reserved.attemptId])).rows[0].n,1);
  assert.deepEqual((await pool.query('SELECT status FROM reasoning_step WHERE job_id=$1 ORDER BY ordinal',[graph.jobId])).rows,[{status:'cancelled'},{status:'cancelled'}]);
 });
});
