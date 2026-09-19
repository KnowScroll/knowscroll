import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';
import {compileDirectContext} from '../packages/db/src/reasoning-context.ts';
import {createSealedContextAuthority} from '../packages/db/src/reasoning-context-authority.ts';
import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {createReasoningMaintenance} from '../packages/db/src/reasoning-maintenance.ts';
import {attachPendingStep,inTransaction,seedDirectContextGraph,withReasoningContextSchema,type DirectContextGraph} from './helpers/reasoning-context-fixture.ts';

async function setup(pool:pg.Pool,maxProbes=1,requestExpired=false,universeId?:string) {
 const graph=await seedDirectContextGraph(pool,{universeId});
 await inTransaction(pool,client=>compileDirectContext(client,graph.scope,{contextId:graph.contextId,jobId:graph.jobId,keepEventIds:graph.keepEventIds},async()=>graph.policy));
 const stepId=await attachPendingStep(pool,graph);
 const fairness=createReasoningFairness(pool,createSealedContextAuthority(async()=>graph.policy));
 await fairness.installPolicy({version:graph.policy.policyVersion,quantum:100,maxCharge:100,scale:100,basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes,maxAdmissions:1});
 await fairness.enqueue({policyVersion:graph.policy.policyVersion,class:'interactive',universeId:graph.scope.universeId,privacyEpoch:0,
  jobId:graph.jobId,stepId,contextId:graph.contextId,requestId:randomUUID(),requestHash:'a'.repeat(64),inputTokensUpperBound:1,
  maxOutputTokens:1,costCeilingMicroUsd:null,deadline:new Date(Date.now()+(requestExpired?-60_000:60_000)).toISOString(),permitTtlMs:30_000});
 return {graph,stepId,fairness,schedule:()=>fairness.schedule({policyVersion:graph.policy.policyVersion,owner:'idle-scheduler-test',leaseMs:30_000})};
}
async function expire(pool:pg.Pool,graph:DirectContextGraph) {
 await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[graph.jobId]);
}
async function snapshot(pool:pg.Pool,graph:DirectContextGraph) {
 return (await pool.query(`SELECT j.status,j.lease_fence::text,j.withdrawn_at,
  (SELECT count(*)::int FROM reasoning_fairness_ready WHERE job_id=j.id) AS ready,
  (SELECT count(*)::int FROM reasoning_attempt WHERE job_id=j.id) AS attempts,
  (SELECT status FROM reasoning_step WHERE job_id=j.id ORDER BY ordinal LIMIT 1) AS step,
  s.generation::text,s.class_cursor FROM reasoning_job j JOIN reasoning_fairness_scheduler s ON s.policy_version=j.policy_version WHERE j.id=$1`,[graph.jobId])).rows[0];
}

test('scheduler expires actual bound Job at its DB deadline without an extra bounded-scan class yield',async()=>{
 await withReasoningContextSchema('idle_scheduler_clock',async pool=>{
  const {graph,schedule}=await setup(pool);
  await expire(pool,graph);
  const before=await snapshot(pool,graph),result=await schedule(),after=await snapshot(pool,graph);
  assert.equal(result.probes,1);
  assert.ok(result.observations.some(o=>o.reason==='deadline_missed'));
  assert.equal(after.status,'expired');assert.ok(after.withdrawn_at instanceof Date);
  assert.equal(after.lease_fence,'1');assert.equal(after.ready,0);assert.equal(after.attempts,0);assert.equal(after.step,'cancelled');
  assert.equal(BigInt(after.generation),BigInt(before.generation)+1n);
  assert.equal(after.class_cursor,before.class_cursor);
 });
});

test('shorter request expiry only dequeues; maintenance later closes the actual Job with no ready membership',async()=>{
 await withReasoningContextSchema('idle_scheduler_request',async pool=>{
  const {graph,schedule}=await setup(pool,1,true);
  await schedule();
  const pending=await snapshot(pool,graph);
  assert.equal(pending.status,'queued');assert.equal(pending.withdrawn_at,null);assert.equal(pending.ready,0);assert.equal(pending.step,'pending');
  await expire(pool,graph);
  const batch=await createReasoningMaintenance(pool).runBatch({maxProbes:1});
  assert.equal(batch.expiredJobs,1);
  const closed=await snapshot(pool,graph);
  assert.equal(closed.status,'expired');assert.ok(closed.withdrawn_at);assert.equal(closed.step,'cancelled');
 });
});

test('expired queued Job with a healthy lease is bypassed without withdrawal or removal',async()=>{
 await withReasoningContextSchema('idle_scheduler_lease',async pool=>{
  const {graph,schedule}=await setup(pool);
  await pool.query("UPDATE reasoning_job SET lease_owner='live-worker',lease_fence=1,lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[graph.jobId]);
  await expire(pool,graph);
  const result=await schedule(),after=await snapshot(pool,graph);
  assert.ok(result.observations.some(o=>o.reason==='idle_healthy_lease'));
  assert.equal(after.status,'queued');assert.equal(after.lease_fence,'1');assert.equal(after.withdrawn_at,null);assert.equal(after.ready,1);assert.equal(after.step,'pending');
 });
});

test('oversized expired head remains intact while another eligible universe makes progress',async()=>{
 await withReasoningContextSchema('idle_scheduler_bypass',async pool=>{
  const bad=await setup(pool,8,false,'10000000-0000-4000-8000-000000000001');
  const good=await setup(pool,8,false,'f0000000-0000-4000-8000-000000000001');
  await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
   SELECT gen_random_uuid(),$1,$2,0,$3,n,'pending' FROM generate_series(2,129) n`,[bad.graph.jobId,bad.graph.scope.universeId,bad.graph.contextId]);
  await expire(pool,bad.graph);
  const result=await good.schedule();
  assert.equal(result.kind,'admitted',JSON.stringify(result));
  if(result.kind!=='admitted')throw new Error('Expected admission');
  assert.equal(result.claim.jobId,good.graph.jobId);
  assert.ok(result.observations.some(o=>o.jobId===bad.graph.jobId&&o.reason==='idle_graph_too_large'));
  const after=await snapshot(pool,bad.graph);
  assert.equal(after.status,'queued');assert.equal(after.withdrawn_at,null);assert.equal(after.lease_fence,'0');assert.equal(after.ready,1);assert.equal(after.step,'pending');
 });
});

test('SQL failure after closure writes rolls back graph and fairness instead of becoming a skippable head',async()=>{
 await withReasoningContextSchema('idle_scheduler_rollback',async pool=>{
  const {graph,schedule}=await setup(pool);
  await expire(pool,graph);
  await pool.query(`CREATE FUNCTION reject_idle_stamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'scheduler injected stamp failure'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER reject_idle_stamp BEFORE UPDATE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION reject_idle_stamp()`);
  const before=await snapshot(pool,graph);
  await assert.rejects(schedule(),/scheduler injected stamp failure/);
  assert.deepEqual(await snapshot(pool,graph),before);
 });
});
