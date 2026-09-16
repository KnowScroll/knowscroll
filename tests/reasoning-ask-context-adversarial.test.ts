import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';

import {validateDirectAskContext} from '../packages/db/src/reasoning-ask-context.ts';
import {attachPendingStep,compileAsk,inTransaction,resolverFor,seedAskContextGraph,withReasoningContextSchema} from './helpers/reasoning-ask-context-fixture.ts';

function sha256(value:string) { return createHash('sha256').update(value,'utf8').digest('hex'); }

async function lockForValidation(client:import('pg').PoolClient,graph:Awaited<ReturnType<typeof seedAskContextGraph>>,stepId:string,session=true) {
 await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
 if(session) await client.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
 await client.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE',[graph.jobId]);
 await client.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE',[stepId]);
}

function scope(graph:Awaited<ReturnType<typeof seedAskContextGraph>>,stepId:string) {
 return {universeId:graph.scope.universeId,privacyEpoch:graph.scope.privacyEpoch,jobId:graph.jobId,stepId,contextId:graph.contextId,policyVersion:graph.policy.policyVersion};
}

test('Ask validator fails closed on malformed seals and changed literal source',async t=>{
 await t.test('a manually malformed first seal is corrupt, never a fallback context family',async()=>{
  await withReasoningContextSchema('ask_corrupt_seal',async pool=>{
   const graph=await seedAskContextGraph(pool),stepId=randomUUID(),payload='{}',hash=sha256(payload);
   await pool.query(`INSERT INTO reasoning_context_job_session(job_id,universe_id,privacy_epoch,session_id)
     VALUES($1,$2,0,$3)`,[graph.jobId,graph.scope.universeId,graph.scope.sessionId]);
   await pool.query(`INSERT INTO reasoning_context_job_ask(job_id,universe_id,privacy_epoch,session_id,ask_id)
     VALUES($1,$2,0,$3,$4)`,[graph.jobId,graph.scope.universeId,graph.scope.sessionId,graph.askId]);
   await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,0,$4,$5,'ask-editorial-asset-pointer-v1')`,[graph.contextId,graph.jobId,graph.scope.universeId,hash,graph.policy.policyVersion]);
   await pool.query(`INSERT INTO reasoning_context_payload(context_id,universe_id,privacy_epoch,canonical_payload,content_hash,read_set_hash)
     VALUES($1,$2,0,$3,$4,$5)`,[graph.contextId,graph.scope.universeId,payload,hash,'a'.repeat(64)]);
   await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
     VALUES($1,$2,$3,0,$4,1,'pending')`,[stepId,graph.jobId,graph.scope.universeId,graph.contextId]);
   const result=await inTransaction(pool,async client=>{
    await lockForValidation(client,graph,stepId);
    return validateDirectAskContext(client,scope(graph,stepId),resolverFor(graph),'lock');
   });
   assert.deepEqual(result,{valid:false,reason:'corrupt_seal'});
  });
 });

 await t.test('changed Ask payload and exposure source refuse the sealed context',async()=>{
  await withReasoningContextSchema('ask_source_tamper',async pool=>{
   const graph=await seedAskContextGraph(pool);
   await compileAsk(pool,graph);
   const stepId=await attachPendingStep(pool,graph);
   await assert.rejects(pool.query("UPDATE ledger SET payload=jsonb_set(payload,'{question}',to_jsonb('rewritten'::text)) WHERE id=$1",[graph.askEventId]),/immutable/);
   await pool.query('ALTER TABLE ledger DISABLE TRIGGER ask_ledger_no_update');
   try {
    await pool.query("UPDATE ledger SET payload=jsonb_set(payload,'{question}',to_jsonb('rewritten'::text)) WHERE id=$1",[graph.askEventId]);
   } finally { await pool.query('ALTER TABLE ledger ENABLE TRIGGER ask_ledger_no_update'); }
   const changedAsk=await inTransaction(pool,async client=>{
    await lockForValidation(client,graph,stepId);
    return validateDirectAskContext(client,scope(graph,stepId),resolverFor(graph),'lock');
   });
   assert.deepEqual(changedAsk,{valid:false,reason:'stale_lineage'});
  });
 });
});

test('Ask validator rejects surgery on every sealed storage representation',async t=>{
 for(const variant of ['missing_dependency','extra_dependency','changed_dependency','payload','metadata_hash'] as const) await t.test(variant,async()=>{
  await withReasoningContextSchema(`ask_seal_${variant}`,async pool=>{
   const graph=await seedAskContextGraph(pool);
   await compileAsk(pool,graph);
   const stepId=await attachPendingStep(pool,graph);
   if(variant==='missing_dependency') {
    await assert.rejects(pool.query('DELETE FROM reasoning_context_dependency WHERE context_id=$1',[graph.contextId]),/sealed/i);
    await pool.query('ALTER TABLE reasoning_context_dependency DISABLE TRIGGER reasoning_context_dependency_guard');
    try { await pool.query('DELETE FROM reasoning_context_dependency WHERE context_id=$1',[graph.contextId]); }
    finally { await pool.query('ALTER TABLE reasoning_context_dependency ENABLE TRIGGER reasoning_context_dependency_guard'); }
   }
   if(variant==='extra_dependency') {
    await pool.query('ALTER TABLE reasoning_context_dependency DISABLE TRIGGER reasoning_context_dependency_guard');
    try { await pool.query(`INSERT INTO reasoning_context_dependency(context_id,universe_id,privacy_epoch,identity,canonical_dependency)
      VALUES($1,$2,0,'extra:tamper','{}')`,[graph.contextId,graph.scope.universeId]); }
    finally { await pool.query('ALTER TABLE reasoning_context_dependency ENABLE TRIGGER reasoning_context_dependency_guard'); }
   }
   if(variant==='changed_dependency') {
    const original=(await pool.query<{canonical_dependency:string}>('SELECT canonical_dependency FROM reasoning_context_dependency WHERE context_id=$1 ORDER BY identity LIMIT 1',[graph.contextId])).rows[0]!;
    const changed={...JSON.parse(original.canonical_dependency),hash:'b'.repeat(64)};
    await pool.query('ALTER TABLE reasoning_context_dependency DISABLE TRIGGER reasoning_context_dependency_guard');
    try { await pool.query('UPDATE reasoning_context_dependency SET canonical_dependency=$2 WHERE context_id=$1',[graph.contextId,JSON.stringify(changed)]); }
    finally { await pool.query('ALTER TABLE reasoning_context_dependency ENABLE TRIGGER reasoning_context_dependency_guard'); }
   }
   if(variant==='payload') {
    await assert.rejects(pool.query('UPDATE reasoning_context_payload SET canonical_payload=$2 WHERE context_id=$1',[graph.contextId,'{}']),/sealed/i);
    await pool.query('ALTER TABLE reasoning_context_payload DISABLE TRIGGER reasoning_context_payload_guard');
    try { await pool.query('UPDATE reasoning_context_payload SET canonical_payload=$2 WHERE context_id=$1',[graph.contextId,'{}']); }
    finally { await pool.query('ALTER TABLE reasoning_context_payload ENABLE TRIGGER reasoning_context_payload_guard'); }
   }
   if(variant==='metadata_hash') {
    await assert.rejects(pool.query('UPDATE reasoning_context SET content_hash=$2 WHERE id=$1',[graph.contextId,'b'.repeat(64)]),/immutable/i);
    await pool.query('ALTER TABLE reasoning_context DISABLE TRIGGER reasoning_context_guard');
    try { await pool.query('UPDATE reasoning_context SET content_hash=$2 WHERE id=$1',[graph.contextId,'b'.repeat(64)]); }
    finally { await pool.query('ALTER TABLE reasoning_context ENABLE TRIGGER reasoning_context_guard'); }
   }
   const result=await inTransaction(pool,async client=>{
    await lockForValidation(client,graph,stepId);
    return validateDirectAskContext(client,scope(graph,stepId),resolverFor(graph),'lock');
   });
   assert.deepEqual(result,{valid:false,reason:'corrupt_seal'});
  });
 });
});

test('Ask validator locks assets only during lock phase',async()=>{
 await withReasoningContextSchema('ask_recheck_no_locks',async pool=>{
  const graph=await seedAskContextGraph(pool);
  await compileAsk(pool,graph);
  const stepId=await attachPendingStep(pool,graph);
  const holder=await pool.connect(),writer=await pool.connect();
  try {
   await holder.query('BEGIN');
   await lockForValidation(holder,graph,stepId);
   assert.equal((await validateDirectAskContext(holder,scope(graph,stepId),resolverFor(graph),'lock')).valid,true);
   await writer.query('BEGIN');await writer.query("SET LOCAL lock_timeout='150ms'");
   await assert.rejects(writer.query('UPDATE asset SET title=title WHERE id=$1',[graph.assetId]),error=>(error as {code?:string}).code==='55P03');
   await writer.query('ROLLBACK');
   await holder.query('ROLLBACK');

   await holder.query('BEGIN');
   await lockForValidation(holder,graph,stepId,false);
   assert.equal((await validateDirectAskContext(holder,scope(graph,stepId),resolverFor(graph),'recheck')).valid,true);
   await writer.query('BEGIN');
   assert.equal((await writer.query('UPDATE device_session SET expires_at=expires_at WHERE id=$1',[graph.scope.sessionId])).rowCount,1);
   assert.equal((await writer.query('UPDATE asset SET title=title WHERE id=$1',[graph.assetId])).rowCount,1);
   await writer.query('ROLLBACK');
   await holder.query('ROLLBACK');
  } finally {
   await Promise.allSettled([holder.query('ROLLBACK'),writer.query('ROLLBACK')]);
   holder.release();writer.release();
  }
 });
});
