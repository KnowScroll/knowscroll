import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {compileDirectAskContext} from '../packages/db/src/reasoning-ask-context.ts';
import {compileDirectContext} from '../packages/db/src/reasoning-context.ts';
import {ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {attachPendingStep,compileAsk,inTransaction,resolverFor,seedAskContextGraph,validateAsk,withReasoningContextSchema} from './helpers/reasoning-ask-context-fixture.ts';

const denied=(code:string)=>(error:unknown)=>error instanceof ReasoningDenied&&error.code===`context_${code}`;

test('Ask compiler preserves literal Unicode and freezes complete source without creating execution state',async()=>{
  await withReasoningContextSchema('ask_literal',async pool=>{
    const graph=await seedAskContextGraph(pool);
    const tables=['reasoning_job','reasoning_step','reasoning_fairness_ready','reasoning_attempt','reasoning_permit','reasoning_accounting','accounts','trace','ledger'];
    const snapshots=async()=>Promise.all(tables.map(async table=>(await pool.query(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value FROM ${table} t`)).rows[0]!.value));
    const before=await snapshots();
    const result=await compileAsk(pool,graph);
    assert.deepEqual(Object.keys(result).sort(),['contentHash','contextId','readSetHash']);
    assert.deepEqual(await snapshots(),before);
    const payload=JSON.parse((await pool.query('SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1',[graph.contextId])).rows[0]!.canonical_payload);
    assert.equal(payload.fact.question,graph.question);
    assert.equal(payload.intentId,graph.askId);
    assert.equal(payload.fact.askEventId,graph.askEventId);
    assert.equal(payload.asset.body,'Literal sourced body.');
    assert.equal(payload.dependencies.length,8);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM reasoning_context_dependency WHERE context_id=$1',[graph.contextId])).rows[0]!.n,8);
    const stepId=await attachPendingStep(pool,graph);
    assert.equal((await validateAsk(pool,graph,stepId)).valid,true);
    assert.equal((await validateAsk(pool,graph,stepId,'recheck')).valid,true);
    await assert.rejects(inTransaction(pool,client=>compileDirectContext(client,graph.scope,{contextId:randomUUID(),jobId:graph.jobId,keepEventIds:[graph.askEventId]},resolverFor(graph))));
  });
});

test('Ask compiler failures roll back binding and all context writes',async t=>{
  for(const variant of ['session','intent','asset','candidate','candidate_case','expired_job','obsolete_epoch'] as const) await t.test(variant,async()=>{
    await withReasoningContextSchema(`ask_${variant}`,async pool=>{
      const graph=await seedAskContextGraph(pool);
      let scope=graph.scope;
      let code='stale_lineage';
      if(variant==='session') {
        const other=randomUUID();
        await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
          SELECT $1,universe_id,device_id,$2,privacy_epoch,expires_at FROM device_session WHERE id=$3`,[other,'a'.repeat(64),graph.scope.sessionId]);
        scope={...scope,sessionId:other};code='inactive_session';
      }
      if(variant==='intent') await pool.query('UPDATE reasoning_job SET intent_id=$1 WHERE id=$2',[randomUUID(),graph.jobId]);
      if(variant==='asset') {await pool.query("UPDATE asset SET body='Drift' WHERE id=$1",[graph.assetId]);code='stale_asset';}
      if(variant==='candidate') await pool.query('UPDATE decision SET candidates=candidates||candidates WHERE id=$1',[graph.decisionId]);
      if(variant==='candidate_case') await pool.query("UPDATE decision SET candidates=candidates||jsonb_build_array(jsonb_set(candidates->0,'{assetId}',to_jsonb(upper($1::text)))) WHERE id=$2",[graph.assetId,graph.decisionId]);
      if(variant==='expired_job') {await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[graph.jobId]);code='unsupported';}
      if(variant==='obsolete_epoch') {await pool.query('UPDATE universe SET privacy_epoch=1 WHERE id=$1',[graph.scope.universeId]);code='obsolete_epoch';}
      await assert.rejects(inTransaction(pool,client=>compileDirectAskContext(client,scope,{contextId:graph.contextId,jobId:graph.jobId,askId:graph.askId},resolverFor(graph))),denied(code));
      for(const table of ['reasoning_context','reasoning_context_payload','reasoning_context_dependency','reasoning_context_job_session','reasoning_context_job_ask']) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n,0,table);
    });
  });
});

test('Ask context rechecks source, policy, session and deadline; binding cannot rebind',async()=>{
  await withReasoningContextSchema('ask_freshness',async pool=>{
    const graph=await seedAskContextGraph(pool);
    await compileAsk(pool,graph);
    const stepId=await attachPendingStep(pool,graph);
    await assert.rejects(pool.query('UPDATE reasoning_job SET intent_id=$1 WHERE id=$2',[randomUUID(),graph.jobId]));
    await assert.rejects(pool.query('DELETE FROM reasoning_context_job_ask WHERE job_id=$1',[graph.jobId]));
    await pool.query("UPDATE asset SET body='changed' WHERE id=$1",[graph.assetId]);
    assert.deepEqual(await validateAsk(pool,graph,stepId,'recheck'),{valid:false,reason:'stale_asset'});
    await pool.query("UPDATE asset SET body='Literal sourced body.' WHERE id=$1",[graph.assetId]);
    const original=graph.policy.maxInputTokens;graph.policy.maxInputTokens+=1;
    assert.deepEqual(await validateAsk(pool,graph,stepId),{valid:false,reason:'changed_policy'});graph.policy.maxInputTokens=original;
    await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[graph.jobId]);
    assert.deepEqual(await validateAsk(pool,graph,stepId),{valid:false,reason:'unsupported'});
    await pool.query("UPDATE reasoning_job SET deadline=clock_timestamp()+interval '1 hour' WHERE id=$1",[graph.jobId]);
    await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[graph.scope.sessionId]);
    assert.deepEqual(await validateAsk(pool,graph,stepId),{valid:false,reason:'inactive_session'});
  });
});

test('Ask compile rollback is deterministic and Clear cascades every private context byte',async()=>{
  await withReasoningContextSchema('ask_clear',async pool=>{
    const graph=await seedAskContextGraph(pool);
    const client=await pool.connect();
    let first:Awaited<ReturnType<typeof compileAsk>>;
    try {await client.query('BEGIN');first=await compileDirectAskContext(client,graph.scope,{contextId:graph.contextId,jobId:graph.jobId,askId:graph.askId},resolverFor(graph));await client.query('ROLLBACK');}
    finally {client.release();}
    assert.deepEqual(await compileAsk(pool,graph),first!);
    await inTransaction(pool,client=>clearScrollHistory(client,graph.scope,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'}));
    for(const table of ['reasoning_context','reasoning_context_payload','reasoning_context_dependency','reasoning_context_job_session','reasoning_context_job_ask','explicit_ask']) assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n,0,table);
  });
});
