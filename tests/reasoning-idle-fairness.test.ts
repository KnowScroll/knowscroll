import assert from 'node:assert/strict';
import test from 'node:test';

import {finalizeIdleJobFairness} from '../packages/db/src/reasoning-idle-fairness.ts';
import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {fairnessAuthority,seedFairnessGraph,sqlFairnessPolicy,withFairnessSchema} from './helpers/reasoning-fairness-fixture.ts';

type Graph=Awaited<ReturnType<typeof seedFairnessGraph>>;

async function enqueue(fairness:ReturnType<typeof createReasoningFairness>,graph:Graph) {
  await fairness.enqueue({
    policyVersion:sqlFairnessPolicy.version,class:'interactive',universeId:graph.universeId,privacyEpoch:0,
    jobId:graph.jobId,stepId:graph.stepId,contextId:graph.contextId,requestId:graph.requestId,
    requestHash:'d'.repeat(64),inputTokensUpperBound:1,maxOutputTokens:1,costCeilingMicroUsd:null,
    deadline:new Date(Date.now()+60_000).toISOString(),permitTtlMs:1_000,
  });
}

async function inTransaction<T>(pool:import('pg').Pool,body:(client:import('pg').PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try { await client.query('BEGIN'); const result=await body(client); await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

test('idle fairness finalizer removes arbitrary membership without dequeuing siblings or inventing credit', async t => {
  await t.test('non-head removal leaves a sibling lane and every cursor/open allowance intact', async () => {
    await withFairnessSchema('idle_finalizer_sibling', async pool => {
      const first=await seedFairnessGraph(pool),second=await seedFairnessGraph(pool,'interactive',1_000_000,first.universeId);
      const policies=new Map([[first.jobId,first.policy],[second.jobId,second.policy]]);
      const fairness=createReasoningFairness(pool,fairnessAuthority(policies));
      await fairness.installPolicy(sqlFairnessPolicy);
      await enqueue(fairness,first); await enqueue(fairness,second);
      await pool.query(`UPDATE reasoning_fairness_universe SET credit=17,candidate_cursor=987
        WHERE policy_version=$1 AND class='interactive' AND universe_id=$2`,[sqlFairnessPolicy.version,first.universeId]);
      await pool.query(`UPDATE reasoning_fairness_class SET credit=29,remaining=41,open_universe_id=$2,
        universe_remaining=37,universe_cursor=$2 WHERE policy_version=$1 AND class='interactive'`,[sqlFairnessPolicy.version,first.universeId]);
      const before=(await pool.query(`SELECT s.generation,u.ready_count,u.credit,u.candidate_cursor,
        c.credit AS class_credit,c.remaining,c.open_universe_id,c.universe_remaining,c.universe_cursor
        FROM reasoning_fairness_scheduler s
        JOIN reasoning_fairness_universe u ON (u.policy_version=s.policy_version AND u.class='interactive' AND u.universe_id=$2)
        JOIN reasoning_fairness_class c ON (c.policy_version=s.policy_version AND c.class='interactive')
        WHERE s.policy_version=$1`,[sqlFairnessPolicy.version,first.universeId])).rows[0]!;
      await inTransaction(pool,client=>finalizeIdleJobFairness(client,{jobId:first.jobId,universeId:first.universeId,attemptIds:[]}));
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_fairness_ready WHERE job_id=$1',[first.jobId])).rows[0]!.count,0);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_fairness_ready WHERE job_id=$1',[second.jobId])).rows[0]!.count,1);
      const after=(await pool.query(`SELECT s.generation,u.ready_count,u.credit,u.candidate_cursor,
        c.credit AS class_credit,c.remaining,c.open_universe_id,c.universe_remaining,c.universe_cursor
        FROM reasoning_fairness_scheduler s
        JOIN reasoning_fairness_universe u ON (u.policy_version=s.policy_version AND u.class='interactive' AND u.universe_id=$2)
        JOIN reasoning_fairness_class c ON (c.policy_version=s.policy_version AND c.class='interactive')
        WHERE s.policy_version=$1`,[sqlFairnessPolicy.version,first.universeId])).rows[0]!;
      assert.deepEqual({...after,generation:(BigInt(before.generation)+1n).toString(),ready_count:'1'},
        {...before,generation:(BigInt(before.generation)+1n).toString(),ready_count:'1'});
    });
  });

  await t.test('last membership clamps idle lane state exactly once and rejects scope substitution', async () => {
    await withFairnessSchema('idle_finalizer_last', async pool => {
      const graph=await seedFairnessGraph(pool),foreign=await seedFairnessGraph(pool);
      const policies=new Map([[graph.jobId,graph.policy],[foreign.jobId,foreign.policy]]);
      const fairness=createReasoningFairness(pool,fairnessAuthority(policies));
      await fairness.installPolicy(sqlFairnessPolicy);
      await enqueue(fairness,graph);
      await pool.query(`UPDATE reasoning_fairness_universe SET credit=17,candidate_cursor=8
        WHERE policy_version=$1 AND class='interactive' AND universe_id=$2`,[sqlFairnessPolicy.version,graph.universeId]);
      await pool.query(`UPDATE reasoning_fairness_class SET credit=31,remaining=43,open_universe_id=$2,
        universe_remaining=39,universe_cursor=$2 WHERE policy_version=$1 AND class='interactive'`,[sqlFairnessPolicy.version,graph.universeId]);
      await assert.rejects(inTransaction(pool,client=>finalizeIdleJobFairness(client,{
        jobId:graph.jobId,universeId:foreign.universeId,attemptIds:[],
      })),/idle_fairness_scope_mismatch/);
      await inTransaction(pool,client=>finalizeIdleJobFairness(client,{jobId:graph.jobId,universeId:graph.universeId,attemptIds:[]}));
      assert.deepEqual((await pool.query(`SELECT credit,candidate_cursor::text,ready_count::text FROM reasoning_fairness_universe
        WHERE policy_version=$1 AND class='interactive' AND universe_id=$2`,[sqlFairnessPolicy.version,graph.universeId])).rows[0],
        {credit:'0',candidate_cursor:'0',ready_count:'0'});
      assert.deepEqual((await pool.query(`SELECT credit,remaining,open_universe_id,universe_remaining::text,universe_cursor
        FROM reasoning_fairness_class WHERE policy_version=$1 AND class='interactive'`,[sqlFairnessPolicy.version])).rows[0],
        {credit:'0',remaining:null,open_universe_id:null,universe_remaining:'0',universe_cursor:null});
      assert.deepEqual((await pool.query('SELECT generation::text FROM reasoning_fairness_scheduler WHERE policy_version=$1',[sqlFairnessPolicy.version])).rows[0],
        {generation:'2'},'enqueue increments once and final closure increments once');
      await inTransaction(pool,client=>finalizeIdleJobFairness(client,{jobId:graph.jobId,universeId:graph.universeId,attemptIds:[]}));
      assert.deepEqual((await pool.query('SELECT generation::text FROM reasoning_fairness_scheduler WHERE policy_version=$1',[sqlFairnessPolicy.version])).rows[0],
        {generation:'2'},'an already-removed Job has no finalizer side effect');
    });
  });
});
