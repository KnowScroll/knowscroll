import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {compileDirectContext} from '../packages/db/src/reasoning-context.ts';
import {lockBoundContextSession} from '../packages/db/src/reasoning-context-session.ts';
import {compileDirectAskContext} from '../packages/db/src/reasoning-ask-context.ts';
import {createSealedContextAuthority} from '../packages/db/src/reasoning-context-authority.ts';
import {recordExplicitAsk} from '../packages/db/src/explicit-ask.ts';
import {createReasoningAdmission} from '../packages/db/src/reasoning-admission.ts';
import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';
import {attachPendingStep,inTransaction,seedDirectContextGraph,withReasoningContextSchema} from './helpers/reasoning-context-fixture.ts';
const resolverFor=(graph:Awaited<ReturnType<typeof seedDirectContextGraph>>)=>async()=>graph.policy;
async function compile(pool:Parameters<typeof inTransaction>[0],graph:Awaited<ReturnType<typeof seedDirectContextGraph>>) {
 await inTransaction(pool,async client=>{
  await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
  const ask=await recordExplicitAsk(client,graph.scope,{clientAskId:randomUUID(),exposureId:graph.exposureId,expectedPrivacyEpoch:0,question:'Why does the clock fall?'});
  await client.query('UPDATE reasoning_job SET intent_id=$2 WHERE id=$1',[graph.jobId,ask.askId]);
 });
 const askId=(await pool.query('SELECT intent_id FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0].intent_id as string;
 return inTransaction(pool,client=>compileDirectAskContext(client,graph.scope,{contextId:graph.contextId,jobId:graph.jobId,askId},resolverFor(graph)));
}

test('Ask context authority is exercised through fair scheduling and dispatch authorization', async t => {
  await t.test('a fair scheduled reservation can receive a concrete dispatch grant', async () => {
  await withReasoningContextSchema('ask_authority_grant',async pool=>{
    const graph=await seedDirectContextGraph(pool);
    await compile(pool,graph);
    const stepId=await attachPendingStep(pool,graph);
    const authority=createSealedContextAuthority(resolverFor(graph));
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
    await withReasoningContextSchema('ask_authority_revoke',async pool=>{
      const graph=await seedDirectContextGraph(pool);
      await compile(pool,graph);
      const stepId=await attachPendingStep(pool,graph),authority=createSealedContextAuthority(resolverFor(graph)),fairness=createReasoningFairness(pool,authority);
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


test('routed Ask fair admission and dispatch wait on original session before locking Job',async()=>{
 await withReasoningContextSchema('ask_lock_order',async pool=>{
  const graph=await seedDirectContextGraph(pool);
  await compile(pool,graph);
  const stepId=await attachPendingStep(pool,graph),authority=createSealedContextAuthority(resolverFor(graph));
  const fairness=createReasoningFairness(pool,authority);
  await fairness.installPolicy({version:graph.policy.policyVersion,quantum:100,maxCharge:100,scale:100,basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes:8,maxAdmissions:1});
  const requestId=randomUUID(),requestHash='c'.repeat(64),deadline=new Date(Date.now()+60_000).toISOString();
  await fairness.enqueue({policyVersion:graph.policy.policyVersion,class:'interactive',universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,contextId:graph.contextId,requestId,requestHash,inputTokensUpperBound:1,maxOutputTokens:1,costCeilingMicroUsd:null,deadline,permitTtlMs:30_000});
  async function whileSessionBlocked<T>(operation:()=>Promise<T>):Promise<T>{
   const blocker=await pool.connect();
   let pending:Promise<T>|undefined;
   try{
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
    pending=operation(); void pending.catch(()=>{});
    let observed=false;
    for(let i=0;i<300;i++){
     const waits=await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
      AND query LIKE 'SELECT s.id FROM reasoning_context_job_session%'`);
     if(waits.rowCount){observed=true;break;}
     await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(observed,true,'must wait for original session');
    // A distinct real transaction can still acquire the Job while admission
    // waits on the session. NOWAIT makes reversed order fail deterministically.
    await inTransaction(pool,client=>client.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE NOWAIT',[graph.jobId]));
    await blocker.query('COMMIT');
    return await pending;
   }finally{
    await blocker.query('ROLLBACK'); blocker.release();
    if(pending)await pending.catch(()=>{});
   }
  }
  const scheduled=await whileSessionBlocked(()=>fairness.schedule({policyVersion:graph.policy.policyVersion,owner:'ask-lock-worker',leaseMs:30_000}));
  assert.equal(scheduled.kind,'admitted',JSON.stringify(scheduled));
  const grant=await whileSessionBlocked(()=>createReasoningAdmission(pool,authority).authorizeDispatch({universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,attemptId:scheduled.reserved.attemptId,owner:'ask-lock-worker',leaseFence:scheduled.claim.leaseFence,requestId,requestHash,inputTokensUpperBound:1,maxOutputTokens:1,dispatchId:randomUUID()}));
  assert.equal(grant.attemptId,scheduled.reserved.attemptId);
 });
});


test('family router preserves Keep V1 and refuses an unknown metadata family',async()=>{
 await withReasoningContextSchema('ask_family_router',async pool=>{
  const graph=await seedDirectContextGraph(pool);
  await inTransaction(pool,client=>compileDirectContext(client,graph.scope,{contextId:graph.contextId,jobId:graph.jobId,keepEventIds:graph.keepEventIds},resolverFor(graph)));
  const stepId=await attachPendingStep(pool,graph),authority=createSealedContextAuthority(resolverFor(graph));
  const scope={universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,contextId:graph.contextId,policyVersion:graph.policy.policyVersion};
  await inTransaction(pool,async client=>{
   await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[scope.universeId]);
   await lockBoundContextSession(client,scope);
   await client.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE',[scope.jobId]);
   assert.equal(await authority.validateContext(client,scope,'lock'),true);
   assert.equal(await authority.validateContext(client,scope,'recheck'),true);
  });
  const unknown=randomUUID();
  await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
   VALUES($1,$2,$3,0,$4,$5,'unknown-family-v1')`,[unknown,graph.jobId,graph.scope.universeId,'d'.repeat(64),graph.policy.policyVersion]);
  await assert.rejects(inTransaction(pool,client=>authority.validateContext(client,{...scope,contextId:unknown},'recheck')),
   error=>error instanceof ReasoningDenied&&error.code==='context_unsupported');
 });
});
