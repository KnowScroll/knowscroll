import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';

import {compileDirectContext,createDirectContextAuthority,validateDirectContext} from '../packages/db/src/reasoning-context.ts';
import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import {ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';
import {attachPendingStep,inTransaction,seedDirectContextGraph,withReasoningContextSchema} from './helpers/reasoning-context-fixture.ts';

type Graph=Awaited<ReturnType<typeof seedDirectContextGraph>>;

function resolverFor(graph:Graph) {
 return async () => graph.policy;
}

function sha256(value:string) {
 return createHash('sha256').update(value,'utf8').digest('hex');
}

async function compile(pool:Parameters<typeof inTransaction>[0],graph:Graph) {
 return inTransaction(pool,client=>compileDirectContext(client,graph.scope,{contextId:graph.contextId,jobId:graph.jobId,keepEventIds:graph.keepEventIds},resolverFor(graph)));
}

async function lockAdmissionRows(client:pg.PoolClient,graph:Graph,stepId:string) {
 await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
 await client.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE',[graph.jobId]);
 await client.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE',[stepId]);
}

async function validate(pool:Parameters<typeof inTransaction>[0],graph:Graph,stepId:string,contextId=graph.contextId,phase:'lock'|'recheck'='lock') {
 return inTransaction(pool,async client=>{
  await lockAdmissionRows(client,graph,stepId);
  return validateDirectContext(client,{universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,contextId,policyVersion:graph.policy.policyVersion},resolverFor(graph),phase);
 });
}

test('sealed context adversarial SQL boundaries',async t=>{
 await t.test('a malformed initial seal is classified as corrupt through the concrete validator',async()=>{
  await withReasoningContextSchema('corrupt_seal',async pool=>{
   const graph=await seedDirectContextGraph(pool);
   const contextId=randomUUID(),stepId=randomUUID(),payload='{}';
   await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,0,$4,$5,'editorial-asset-pointer-v1')`,[contextId,graph.jobId,graph.scope.universeId,sha256(payload),graph.policy.policyVersion]);
   await pool.query(`INSERT INTO reasoning_context_payload(context_id,universe_id,privacy_epoch,canonical_payload,content_hash,read_set_hash)
     VALUES($1,$2,0,$3,$4,$5)`,[contextId,graph.scope.universeId,payload,sha256(payload),'a'.repeat(64)]);
   await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
     VALUES($1,$2,$3,0,$4,1,'pending')`,[stepId,graph.jobId,graph.scope.universeId,contextId]);
   assert.deepEqual(await validate(pool,graph,stepId,contextId),{valid:false,reason:'corrupt_seal'});
  });
 });

 await t.test('typed publication serializes a generic append and seals it out',async()=>{
  await withReasoningContextSchema('seal_race',async pool=>{
   const graph=await seedDirectContextGraph(pool);
   const canonicalPayload='{}',contentHash=sha256(canonicalPayload);
   const publisher=await pool.connect(),generic=await pool.connect();
   try {
    await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
      VALUES($1,$2,$3,0,$4,$5,'editorial-asset-pointer-v1')`,[graph.contextId,graph.jobId,graph.scope.universeId,contentHash,graph.policy.policyVersion]);
    await publisher.query('BEGIN');
    await publisher.query(`INSERT INTO reasoning_context_dependency(context_id,universe_id,privacy_epoch,identity,canonical_dependency)
      VALUES($1,$2,0,'fixture','{}')`,[graph.contextId,graph.scope.universeId]);
    await generic.query('BEGIN');
    await generic.query("SET LOCAL lock_timeout='150ms'");
    await assert.rejects(generic.query(`INSERT INTO reasoning_context_read(context_id,universe_id,privacy_epoch,kind,scope_kind,scope_universe_id,entity_key,revision)
      VALUES($1,$2,0,'entity','universe',$2,'fixture',0)`,[graph.contextId,graph.scope.universeId]),error=>(error as {code?:string}).code==='55P03');
    await generic.query('ROLLBACK');
    await publisher.query(`INSERT INTO reasoning_context_payload(context_id,universe_id,privacy_epoch,canonical_payload,content_hash,read_set_hash)
      VALUES($1,$2,0,$3,$4,$5)`,[graph.contextId,graph.scope.universeId,canonicalPayload,contentHash,'b'.repeat(64)]);
    await publisher.query('COMMIT');
    await assert.rejects(pool.query(`INSERT INTO reasoning_context_read(context_id,universe_id,privacy_epoch,kind,scope_kind,scope_universe_id,entity_key,revision)
      VALUES($1,$2,0,'entity','universe',$2,'fixture',0)`,[graph.contextId,graph.scope.universeId]),/Context is sealed/);
    assert.deepEqual((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_dependency WHERE context_id=$1',[graph.contextId])).rows[0],{count:1});
   } finally {
    await Promise.allSettled([publisher.query('ROLLBACK'),generic.query('ROLLBACK')]);
    publisher.release();generic.release();
   }
  });
 });

 await t.test('lock retains the sealed asset lock while recheck itself adds none',async()=>{
  await withReasoningContextSchema('recheck_locks',async pool=>{
   const graph=await seedDirectContextGraph(pool);
   await compile(pool,graph);
   const stepId=await attachPendingStep(pool,graph);
   const holder=await pool.connect(),writer=await pool.connect();
   try {
    await holder.query('BEGIN');
    await lockAdmissionRows(holder,graph,stepId);
    const locked=await validateDirectContext(holder,{universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,contextId:graph.contextId,policyVersion:graph.policy.policyVersion},resolverFor(graph),'lock');
    assert.equal(locked.valid,true);
    await writer.query('BEGIN');
    await writer.query("SET LOCAL lock_timeout='150ms'");
    await assert.rejects(writer.query('UPDATE asset SET title=title WHERE id=$1',[graph.assetId]),error=>(error as {code?:string}).code==='55P03');
    await writer.query('ROLLBACK');
    await writer.query('BEGIN');
    await writer.query("SET LOCAL lock_timeout='150ms'");
    await assert.rejects(writer.query('UPDATE device_session SET expires_at=expires_at WHERE id=$1',[graph.scope.sessionId]),error=>(error as {code?:string}).code==='55P03');
    await writer.query('ROLLBACK');
    const rechecked=await validateDirectContext(holder,{universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,contextId:graph.contextId,policyVersion:graph.policy.policyVersion},resolverFor(graph),'recheck');
    assert.equal(rechecked.valid,true);
    await holder.query('ROLLBACK');

    await holder.query('BEGIN');
    await lockAdmissionRows(holder,graph,stepId);
    const onlyRecheck=await validateDirectContext(holder,{universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,contextId:graph.contextId,policyVersion:graph.policy.policyVersion},resolverFor(graph),'recheck');
    assert.equal(onlyRecheck.valid,true);
    await writer.query('BEGIN');
    const sessionUpdated=await writer.query('UPDATE device_session SET expires_at=expires_at WHERE id=$1',[graph.scope.sessionId]);
    assert.equal(sessionUpdated.rowCount,1);
    const updated=await writer.query('UPDATE asset SET title=title WHERE id=$1',[graph.assetId]);
    assert.equal(updated.rowCount,1);
    await writer.query('ROLLBACK');
   } finally {
    await Promise.allSettled([holder.query('ROLLBACK'),writer.query('ROLLBACK')]);
    holder.release();writer.release();
   }
  });
 });

 await t.test('scope-bound policy drift denies validation even when no other policy field changes',async()=>{
  await withReasoningContextSchema('scope_digest',async pool=>{
   const graph=await seedDirectContextGraph(pool);
   await compile(pool,graph);
   const stepId=await attachPendingStep(pool,graph);
   const owner=graph.policy.buckets.find(bucket=>bucket.dimension==='owner_budget')!;
   owner.scopeId=randomUUID();
   assert.deepEqual(await validate(pool,graph,stepId),{valid:false,reason:'changed_policy'});
  });
 });

 await t.test('fair admission carries its same-client lock forward into read-only rechecks',async()=>{
  await withReasoningContextSchema('fair_recheck_phase',async pool=>{
   const graph=await seedDirectContextGraph(pool);
   await compile(pool,graph);
   const stepId=await attachPendingStep(pool,graph);
   const direct=createDirectContextAuthority(resolverFor(graph));
   const phases:Array<'lock'|'recheck'>=[];
   const authority={
    resolvePolicy:direct.resolvePolicy,
    async validateContext(...args:Parameters<typeof direct.validateContext>) {
     phases.push(args[2]);
     return direct.validateContext(...args);
    },
   };
   const fairness=createReasoningFairness(pool,authority);
   await fairness.installPolicy({version:graph.policy.policyVersion,quantum:100,maxCharge:100,scale:100,basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes:8,maxAdmissions:1});
   await fairness.enqueue({
    policyVersion:graph.policy.policyVersion,class:'interactive',universeId:graph.scope.universeId,privacyEpoch:0,
    jobId:graph.jobId,stepId,contextId:graph.contextId,requestId:randomUUID(),requestHash:'a'.repeat(64),
    inputTokensUpperBound:1,maxOutputTokens:1,costCeilingMicroUsd:null,deadline:new Date(Date.now()+60_000).toISOString(),permitTtlMs:30_000,
   });
   const scheduled=await fairness.schedule({policyVersion:graph.policy.policyVersion,owner:'adversarial-context-worker',leaseMs:30_000});
   assert.equal(scheduled.kind,'admitted',JSON.stringify(scheduled));
   assert.deepEqual(phases,['lock','recheck','recheck','recheck']);
  });
 });
});
