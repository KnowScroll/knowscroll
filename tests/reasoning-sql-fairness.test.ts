import assert from 'node:assert/strict';
import test from 'node:test';

import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {fairnessAuthority,seedFairnessGraph,sqlFairnessPolicy,withFairnessSchema} from './helpers/reasoning-fairness-fixture.ts';

async function enqueue(fairness:ReturnType<typeof createReasoningFairness>,graph:Awaited<ReturnType<typeof seedFairnessGraph>>,tokens=20) {
 await fairness.enqueue({policyVersion:'fairness-v1',class:'interactive',universeId:graph.universeId,privacyEpoch:0,jobId:graph.jobId,stepId:graph.stepId,contextId:graph.contextId,requestId:graph.requestId,requestHash:'b'.repeat(64),inputTokensUpperBound:tokens,maxOutputTokens:tokens,costCeilingMicroUsd:null,deadline:new Date(Date.now()+30_000).toISOString(),permitTtlMs:20_000});
}

test('SQL fairness atomically claims, debits, reserves and writes no settlement delta at admission',async()=>{
 await withFairnessSchema('atomic',async pool=>{
  const graph=await seedFairnessGraph(pool);const policies=new Map([[graph.jobId,graph.policy]]);const fairness=createReasoningFairness(pool,fairnessAuthority(policies));await fairness.installPolicy(sqlFairnessPolicy);
  await fairness.enqueue({policyVersion:'fairness-v1',class:'interactive',universeId:graph.universeId,privacyEpoch:0,jobId:graph.jobId,stepId:graph.stepId,contextId:graph.contextId,requestId:graph.requestId,requestHash:'b'.repeat(64),inputTokensUpperBound:20,maxOutputTokens:20,costCeilingMicroUsd:null,deadline:new Date(Date.now()+30_000).toISOString(),permitTtlMs:20_000});
  const outcome=await fairness.schedule({policyVersion:'fairness-v1',owner:'fair-worker',leaseMs:20_000});assert.equal(outcome.kind,'admitted');
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt')).rows[0]?.n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_ready')).rows[0]?.n,0);
  assert.deepEqual((await pool.query('SELECT reserved_charge,recognized_charge FROM reasoning_fairness_attempt')).rows[0],{reserved_charge:'40',recognized_charge:'40'});
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_delta')).rows[0]?.n,0);
  assert.deepEqual((await pool.query("SELECT credit FROM reasoning_fairness_class WHERE class='interactive'")).rows[0],{credit:'0'});
 });
});

test('SQL fairness bypasses permanently impossible work and serializes competing workers',async t=>{
 await t.test('an impossible head is recorded and a fitting universe is admitted in the bounded probe loop',async()=>{
  await withFairnessSchema('impossible_bypass',async pool=>{
   const impossible=await seedFairnessGraph(pool,'interactive',50),fitting=await seedFairnessGraph(pool);
   const fairness=createReasoningFairness(pool,fairnessAuthority(new Map([[impossible.jobId,impossible.policy],[fitting.jobId,fitting.policy]])));await fairness.installPolicy(sqlFairnessPolicy);
   await enqueue(fairness,impossible,50);await enqueue(fairness,fitting,20);
   const result=await fairness.schedule({policyVersion:'fairness-v1',owner:'fair-worker',leaseMs:20_000});
   const skipped=await fairness.schedule({policyVersion:'fairness-v1',owner:'fair-worker',leaseMs:20_000});
   assert.ok([result,skipped].some(value=>value.kind==='admitted'));assert.equal((await pool.query("SELECT status FROM reasoning_job WHERE id=$1",[impossible.jobId])).rows[0]?.status,'queued');
   assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt')).rows[0]?.n,1);
   assert.equal([...result.observations,...skipped.observations].filter(observation=>observation.kind==='impossible'&&observation.jobId===impossible.jobId).length,1);
   assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt WHERE job_id=$1',[impossible.jobId])).rows[0]?.n,0);
  });
 });
 await t.test('two concurrent schedulers never duplicate a claim or fairness debit',async()=>{
  await withFairnessSchema('contention',async pool=>{
   const first=await seedFairnessGraph(pool),second=await seedFairnessGraph(pool);
   const fairness=createReasoningFairness(pool,fairnessAuthority(new Map([[first.jobId,first.policy],[second.jobId,second.policy]])));await fairness.installPolicy(sqlFairnessPolicy);await enqueue(fairness,first);await enqueue(fairness,second);
   const settled=await Promise.all([fairness.schedule({policyVersion:'fairness-v1',owner:'worker-a',leaseMs:20_000}),fairness.schedule({policyVersion:'fairness-v1',owner:'worker-b',leaseMs:20_000})]);
   assert.equal(settled.filter(value=>value.kind==='admitted').length,2);assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt')).rows[0]?.n,2);
   assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_attempt')).rows[0]?.n,2);
  });
 });
});
