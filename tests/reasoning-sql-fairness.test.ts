import assert from 'node:assert/strict';
import test from 'node:test';

import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {fairnessAuthority,seedFairnessGraph,sqlFairnessPolicy,withFairnessSchema} from './helpers/reasoning-fairness-fixture.ts';

test('SQL fairness atomically claims, debits, reserves and writes no settlement delta at admission',async()=>{
 await withFairnessSchema('atomic',async pool=>{
  const graph=await seedFairnessGraph(pool);const policies=new Map([[graph.jobId,graph.policy]]);const fairness=createReasoningFairness(pool,fairnessAuthority(policies));await fairness.installPolicy(sqlFairnessPolicy);
  await fairness.enqueue({policyVersion:'fairness-v1',class:'interactive',universeId:graph.universeId,privacyEpoch:0,jobId:graph.jobId,stepId:graph.stepId,contextId:graph.contextId,requestId:graph.requestId,requestHash:'b'.repeat(64),inputTokensUpperBound:20,maxOutputTokens:20,costCeilingMicroUsd:null,deadline:new Date(Date.now()+30_000).toISOString(),permitTtlMs:20_000});
  const outcome=await fairness.schedule({policyVersion:'fairness-v1',owner:'fair-worker',leaseMs:20_000});assert.equal(outcome.kind,'admitted');
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt')).rows[0]?.n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_ready')).rows[0]?.n,0);
  assert.deepEqual((await pool.query('SELECT reserved_charge,recognized_charge FROM reasoning_fairness_attempt')).rows[0],{reserved_charge:'40',recognized_charge:'40'});
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_delta')).rows[0]?.n,0);
  assert.deepEqual((await pool.query("SELECT credit FROM reasoning_fairness_class WHERE class='interactive'")).rows[0],{credit:'460'});
 });
});
