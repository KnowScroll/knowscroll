import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {
  compileDirectContext,
  createDirectContextAuthority,
  validateDirectContext,
} from '../packages/db/src/reasoning-context.ts';
import {createReasoningAdmission} from '../packages/db/src/reasoning-admission.ts';
import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {attachPendingStep,inTransaction,seedDirectContextGraph,withReasoningContextSchema} from './helpers/reasoning-context-fixture.ts';

function resolverFor(graph:Awaited<ReturnType<typeof seedDirectContextGraph>>) {
  return async () => graph.policy;
}

async function compile(pool:Parameters<typeof inTransaction>[0],graph:Awaited<ReturnType<typeof seedDirectContextGraph>>,contextId=graph.contextId,keepEventIds=graph.keepEventIds) {
  return inTransaction(pool,client=>compileDirectContext(client,graph.scope,{contextId,jobId:graph.jobId,keepEventIds},resolverFor(graph)));
}

async function validation(pool:Parameters<typeof inTransaction>[0],graph:Awaited<ReturnType<typeof seedDirectContextGraph>>,stepId:string,phase:'lock'|'recheck'='lock') {
  return inTransaction(pool,async client=>{
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
    await client.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE',[graph.jobId]);
    await client.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE',[stepId]);
    return validateDirectContext(client,{universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,contextId:graph.contextId,policyVersion:graph.policy.policyVersion},resolverFor(graph),phase);
  });
}

test('sealed direct context compiles literal Keep lineage canonically and validates exact dependencies', async t => {
  await t.test('caller permutation does not change the sealed result for the same snapshot identity', async () => {
    await withReasoningContextSchema('canonical',async pool=>{
      const graph=await seedDirectContextGraph(pool,{secondKeep:true});
      const client=await pool.connect();
      let first:{contentHash:string;readSetHash:string};
      try {
        await client.query('BEGIN');
        first=await compileDirectContext(client,graph.scope,{contextId:graph.contextId,jobId:graph.jobId,keepEventIds:[...graph.keepEventIds].reverse()},resolverFor(graph));
        await client.query('ROLLBACK');
      } finally { client.release(); }
      const second=await compile(pool,graph);
      assert.deepEqual(second,first!);
      const stored=await pool.query('SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1',[graph.contextId]);
      assert.equal(stored.rowCount,1);
      assert.ok(!stored.rows[0]!.canonical_payload.includes('token_hash'));
    });
  });

  await t.test('same-revision asset drift and session revocation make the context unusable', async () => {
    await withReasoningContextSchema('freshness',async pool=>{
      const graph=await seedDirectContextGraph(pool);
      const result=await compile(pool,graph);
      assert.deepEqual(Object.keys(result).sort(),['contentHash','contextId','readSetHash']);
      const stepId=await attachPendingStep(pool,graph);
      const fresh=await validation(pool,graph,stepId);
      assert.equal(fresh.valid,true,JSON.stringify(fresh));
      await pool.query("UPDATE asset SET title='Changed without revision' WHERE id=$1",[graph.assetId]);
      assert.deepEqual(await validation(pool,graph,stepId,'recheck'),{valid:false,reason:'stale_asset'});
      await pool.query("UPDATE asset SET title='The clock that falls' WHERE id=$1",[graph.assetId]);
      await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[graph.scope.sessionId]);
      assert.deepEqual(await validation(pool,graph,stepId),{valid:false,reason:'inactive_session'});
    });
  });

  await t.test('unrelated later Keep does not rewrite a sealed direct read set', async () => {
    await withReasoningContextSchema('unrelated',async pool=>{
      const graph=await seedDirectContextGraph(pool);
      await compile(pool,graph);
      const stepId=await attachPendingStep(pool,graph);
      await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch)
        SELECT $1,universe_id,'keep',$2,event_id,$3,0 FROM exposure WHERE id=$4`,
        [randomUUID(),randomUUID(),JSON.stringify({exposureId:graph.exposureId,assetId:graph.assetId,kind:'keep'}),graph.exposureId]);
      assert.equal((await validation(pool,graph,stepId)).valid,true);
    });
  });
  await t.test('an expired queued direct job cannot publish a context', async () => {
    await withReasoningContextSchema('expired_job',async pool=>{
      const graph=await seedDirectContextGraph(pool);
      await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 millisecond' WHERE id=$1",[graph.jobId]);
      await assert.rejects(compile(pool,graph),error=>error instanceof ReasoningDenied&&error.code==='context_unsupported');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context')).rows[0]!.count,0);
    });
  });
  await t.test('session expiry while a selected asset lock waits rolls back compilation', async () => {
    await withReasoningContextSchema('expiry_wait',async pool=>{
      const graph=await seedDirectContextGraph(pool);
      await pool.query("UPDATE device_session SET expires_at=clock_timestamp()+interval '75 milliseconds' WHERE id=$1",[graph.scope.sessionId]);
      const blocker=await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT id FROM asset WHERE id=$1 FOR UPDATE',[graph.assetId]);
        const pending=compile(pool,graph);
        void pending.catch(()=>{});
        let observed=false;
        for(let probe=0;probe<100;probe+=1) {
          const waiting=await pool.query<{count:number}>("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM asset%'");
          if(waiting.rows[0]!.count>0) { observed=true; break; }
        }
        assert.equal(observed,true,'compiler must wait on the selected asset lock');
        let expired=false;
        for(let probe=0;probe<5_000;probe+=1) {
          const current=await pool.query<{expired:boolean}>('SELECT clock_timestamp()>=expires_at AS expired FROM device_session WHERE id=$1',[graph.scope.sessionId]);
          if(current.rows[0]!.expired) { expired=true; break; }
        }
        assert.equal(expired,true,'test clock must pass the session expiry while the asset remains locked');
        await blocker.query('COMMIT');
        await assert.rejects(pending,error=>error instanceof ReasoningDenied&&error.code==='context_inactive_session');
      } finally {
        try { await blocker.query('ROLLBACK'); } catch {}
        blocker.release();
      }
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context')).rows[0]!.count,0);
    });
  });
});

test('direct context authority is exercised through fair scheduling and dispatch authorization', async t => {
  await t.test('a fair scheduled reservation can receive a concrete dispatch grant', async () => {
  await withReasoningContextSchema('authority_grant',async pool=>{
    const graph=await seedDirectContextGraph(pool);
    await compile(pool,graph);
    const stepId=await attachPendingStep(pool,graph);
    const authority=createDirectContextAuthority(resolverFor(graph));
    const fairness=createReasoningFairness(pool,authority);
    await fairness.installPolicy({version:graph.policy.policyVersion,quantum:100,maxCharge:100,scale:100,basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes:8,maxAdmissions:1});
    const requestId=randomUUID(),requestHash='a'.repeat(64),deadline=new Date(Date.now()+60_000).toISOString();
    await fairness.enqueue({policyVersion:graph.policy.policyVersion,class:'interactive',
      universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,contextId:graph.contextId,
      requestId,requestHash,inputTokensUpperBound:1,maxOutputTokens:1,costCeilingMicroUsd:null,deadline,permitTtlMs:30_000,
    });
    const scheduled=await fairness.schedule({policyVersion:graph.policy.policyVersion,owner:'context-worker',leaseMs:30_000});
    assert.equal(scheduled.kind,'admitted',JSON.stringify(scheduled));
    const admission=createReasoningAdmission(pool,authority), reserved=scheduled.reserved;
    const grant=await admission.authorizeDispatch({
      universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,attemptId:reserved.attemptId,
      owner:'context-worker',leaseFence:scheduled.claim.leaseFence,requestId,
      requestHash,inputTokensUpperBound:1,maxOutputTokens:1,dispatchId:randomUUID(),
    });
    assert.equal(grant.attemptId,reserved.attemptId);
  });
  });

  await t.test('revocation after fair reservation blocks dispatch without consuming its permit', async () => {
    await withReasoningContextSchema('authority_revoke',async pool=>{
      const graph=await seedDirectContextGraph(pool);
      await compile(pool,graph);
      const stepId=await attachPendingStep(pool,graph),authority=createDirectContextAuthority(resolverFor(graph)),fairness=createReasoningFairness(pool,authority);
      await fairness.installPolicy({version:graph.policy.policyVersion,quantum:100,maxCharge:100,scale:100,basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes:8,maxAdmissions:1});
      const requestId=randomUUID(),requestHash='b'.repeat(64),deadline=new Date(Date.now()+60_000).toISOString();
      await fairness.enqueue({policyVersion:graph.policy.policyVersion,class:'interactive',universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,contextId:graph.contextId,requestId,requestHash,inputTokensUpperBound:1,maxOutputTokens:1,costCeilingMicroUsd:null,deadline,permitTtlMs:30_000});
      const scheduled=await fairness.schedule({policyVersion:graph.policy.policyVersion,owner:'context-worker',leaseMs:30_000});
      assert.equal(scheduled.kind,'admitted',JSON.stringify(scheduled));
      await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[graph.scope.sessionId]);
      await assert.rejects(createReasoningAdmission(pool,authority).authorizeDispatch({universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,attemptId:scheduled.reserved.attemptId,owner:'context-worker',leaseFence:scheduled.claim.leaseFence,requestId,requestHash,inputTokensUpperBound:1,maxOutputTokens:1,dispatchId:randomUUID()}),error=>error instanceof ReasoningDenied&&error.code==='context_inactive_session');
      assert.deepEqual((await pool.query('SELECT state,dispatch_id FROM reasoning_accounting WHERE attempt_id=$1',[scheduled.reserved.attemptId])).rows[0],{state:'reserved',dispatch_id:null});
      assert.deepEqual((await pool.query('SELECT state,dispatch_id FROM reasoning_permit WHERE id=$1',[scheduled.reserved.permitId])).rows[0],{state:'reserved',dispatch_id:null});
    });
  });
});

test('direct compiler rejects foreign jobs and clear erases every sealed private row', async t => {
  await t.test('foreign job identity produces a typed context denial', async () => {
    await withReasoningContextSchema('foreign',async pool=>{
      const first=await seedDirectContextGraph(pool), second=await seedDirectContextGraph(pool);
      await assert.rejects(inTransaction(pool,client=>compileDirectContext(client,first.scope,{contextId:randomUUID(),jobId:second.jobId,keepEventIds:first.keepEventIds},resolverFor(first))),error=>error instanceof ReasoningDenied && error.code==='context_foreign');
    });
  });
  await t.test('history clear cascades the sealed payload and every typed dependency', async () => {
    await withReasoningContextSchema('clear',async pool=>{
      const graph=await seedDirectContextGraph(pool);
      await compile(pool,graph);
      await inTransaction(pool,client=>clearScrollHistory(client,graph.scope,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'}));
      for(const [table,column] of [['reasoning_context','id'],['reasoning_context_payload','context_id'],['reasoning_context_dependency','context_id']] as const) {
        assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`,[graph.contextId])).rows[0]!.count,0,table);
      }
    });
  });
});
