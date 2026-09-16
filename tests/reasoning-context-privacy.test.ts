import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import test from 'node:test';

import {authenticateAndLock,type AuthScope} from '../packages/db/src/identity.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {compileDirectContext,validateDirectContext} from '../packages/db/src/reasoning-context.ts';
import {ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';
import {
  attachPendingStep,
  inTransaction,
  seedDirectContextGraph,
  withReasoningContextSchema,
  type DirectContextGraph,
} from './helpers/reasoning-context-fixture.ts';

const tokenHash=(token:string)=>createHash('sha256').update(token,'utf8').digest('hex');
const resolverFor=(graph:DirectContextGraph)=>async()=>graph.policy;

async function retoken(pool:Parameters<typeof inTransaction>[0],sessionId:string):Promise<string> {
  const token=randomBytes(32).toString('base64url');
  await pool.query('UPDATE device_session SET token_hash=$1 WHERE id=$2',[tokenHash(token),sessionId]);
  return token;
}

async function addSession(pool:Parameters<typeof inTransaction>[0],universeId:string):Promise<{sessionId:string;token:string}> {
  const sessionId=randomUUID(),token=randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
    VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour')`,
  [sessionId,universeId,randomUUID(),tokenHash(token)]);
  return {sessionId,token};
}

async function authenticatedCompile(
  pool:Parameters<typeof inTransaction>[0],graph:DirectContextGraph,token:string,
  options:{contextId?:string;scope?: (scope:AuthScope)=>AuthScope}={},
) {
  return inTransaction(pool,async client=>{
    const authenticated=await authenticateAndLock(client,token);
    return compileDirectContext(client,options.scope?.(authenticated)??authenticated,{
      contextId:options.contextId??graph.contextId,jobId:graph.jobId,keepEventIds:graph.keepEventIds,
    },resolverFor(graph));
  });
}

async function validate(pool:Parameters<typeof inTransaction>[0],graph:DirectContextGraph,stepId:string) {
  return inTransaction(pool,async client=>{
    await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
    await client.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE',[graph.jobId]);
    await client.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE',[stepId]);
    return validateDirectContext(client,{
      universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,
      contextId:graph.contextId,policyVersion:graph.policy.policyVersion,
    },resolverFor(graph),'lock');
  });
}

async function assertNoContextRows(pool:Parameters<typeof inTransaction>[0],contextId:string) {
  for(const [table,column] of [
    ['reasoning_context','id'],['reasoning_context_payload','context_id'],['reasoning_context_dependency','context_id'],
  ] as const) {
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`,[contextId])).rows[0]!.count,0,table);
  }
}

test('direct context compilation uses the authenticated session from the same transaction',async t=>{
  await t.test('actual token authentication compiles without exposing token material',async()=>{
    await withReasoningContextSchema('auth_same_client',async pool=>{
      const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
      const result=await authenticatedCompile(pool,graph,token);
      assert.equal(result.contextId,graph.contextId);
      const stored=(await pool.query<{canonical_payload:string}>('SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1',[graph.contextId])).rows[0]!;
      assert.ok(!stored.canonical_payload.includes(token));
      assert.ok(!stored.canonical_payload.includes(tokenHash(token)));
    });
  });

  await t.test('wrong-device and foreign authenticated scopes cannot publish rows',async()=>{
    await withReasoningContextSchema('auth_foreign',async pool=>{
      const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
      await assert.rejects(authenticatedCompile(pool,graph,token,{scope:scope=>({...scope,deviceId:randomUUID()})}),
        error=>error instanceof ReasoningDenied&&error.code==='context_inactive_session');
      await assertNoContextRows(pool,graph.contextId);

      const foreign=await seedDirectContextGraph(pool),foreignToken=await retoken(pool,foreign.scope.sessionId);
      await assert.rejects(authenticatedCompile(pool,graph,foreignToken,{contextId:randomUUID()}),
        error=>error instanceof ReasoningDenied&&error.code==='context_foreign');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context')).rows[0]!.count,0);
    });
  });
});

test('sealed context retains its original session and exact literal evidence',async t=>{
  await t.test('another active same-universe session cannot replace a revoked compiling session',async()=>{
    await withReasoningContextSchema('no_session_substitution',async pool=>{
      const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
      await authenticatedCompile(pool,graph,token);
      const stepId=await attachPendingStep(pool,graph);
      await addSession(pool,graph.scope.universeId);
      await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[graph.scope.sessionId]);
      assert.deepEqual(await validate(pool,graph,stepId),{valid:false,reason:'inactive_session'});
    });
  });

  await t.test('a changed Keep payload breaks the complete lineage and rolls back publication',async()=>{
    await withReasoningContextSchema('literal_lineage',async pool=>{
      const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
      await pool.query("UPDATE ledger SET payload=jsonb_set(payload,'{assetId}',to_jsonb($2::text)) WHERE id=$1",[graph.keepEventId,randomUUID()]);
      await assert.rejects(authenticatedCompile(pool,graph,token),
        error=>error instanceof ReasoningDenied&&error.code==='context_stale_lineage');
      await assertNoContextRows(pool,graph.contextId);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_job_session WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
    });
  });
});

test('frozen candidate bytes and compiler bounds fail closed',async t=>{
  await t.test('stored body and source pointers are exact and same-revision drift invalidates them',async()=>{
    await withReasoningContextSchema('body_source',async pool=>{
      const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
      await authenticatedCompile(pool,graph,token);
      const stepId=await attachPendingStep(pool,graph);
      const stored=(await pool.query<{canonical_payload:string}>('SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1',[graph.contextId])).rows[0]!;
      const payload=JSON.parse(stored.canonical_payload) as {assets:Array<{body:string;sourceTitle:string;sourceUrl:string}>};
      assert.deepEqual(payload.assets.map(asset=>({body:asset.body,sourceTitle:asset.sourceTitle,sourceUrl:asset.sourceUrl})),[
        {body:'Literal sourced body.',sourceTitle:'Example source',sourceUrl:'https://example.test/clock'},
      ]);
      await pool.query("UPDATE asset SET body='Changed body',source_title='Changed source',source_url='https://example.test/changed' WHERE id=$1",[graph.assetId]);
      assert.deepEqual(await validate(pool,graph,stepId),{valid:false,reason:'stale_asset'});
    });
  });

  await t.test('changed historical candidate and oversized canonical payload leave no context rows',async()=>{
    await withReasoningContextSchema('candidate_bounds',async pool=>{
      const first=await seedDirectContextGraph(pool),firstToken=await retoken(pool,first.scope.sessionId);
      const candidate=(await pool.query<{candidates:unknown[]}>('SELECT candidates FROM decision WHERE id=$1',[first.decisionId])).rows[0]!.candidates[0] as Record<string,unknown>;
      await pool.query('UPDATE decision SET candidates=$2 WHERE id=$1',[first.decisionId,JSON.stringify([{...candidate,body:'Changed historical body'}])]);
      await assert.rejects(authenticatedCompile(pool,first,firstToken),
        error=>error instanceof ReasoningDenied&&error.code==='context_stale_asset');
      await assertNoContextRows(pool,first.contextId);

      const second=await seedDirectContextGraph(pool),secondToken=await retoken(pool,second.scope.sessionId);
      const oversized='x'.repeat(65_536);
      const secondCandidate=(await pool.query<{candidates:unknown[]}>('SELECT candidates FROM decision WHERE id=$1',[second.decisionId])).rows[0]!.candidates[0] as Record<string,unknown>;
      await pool.query('UPDATE asset SET body=$2 WHERE id=$1',[second.assetId,oversized]);
      await pool.query('UPDATE decision SET candidates=$2 WHERE id=$1',[second.decisionId,JSON.stringify([{...secondCandidate,body:oversized}])]);
      await assert.rejects(authenticatedCompile(pool,second,secondToken),
        error=>error instanceof ReasoningDenied&&error.code==='context_bounds_exceeded');
      await assertNoContextRows(pool,second.contextId);
    });
  });
});

test('a direct Job intent cannot be rebound to a second authenticated session',async()=>{
  await withReasoningContextSchema('job_session_binding',async pool=>{
    const graph=await seedDirectContextGraph(pool),firstToken=await retoken(pool,graph.scope.sessionId);
    await authenticatedCompile(pool,graph,firstToken);
    const second=await addSession(pool,graph.scope.universeId);
    await assert.rejects(authenticatedCompile(pool,graph,second.token,{contextId:randomUUID()}),
      error=>error instanceof ReasoningDenied);
  });
});

test('direct Job session binding is immutable, scoped to the Job lifetime, and reusable only by its session',async t=>{
  await t.test('a failure after binding insertion rolls the new binding back',async()=>{
    await withReasoningContextSchema('binding_rollback',async pool=>{
      const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
      await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
        VALUES($1,$2,$3,0,$4,$5,'preexisting-test')`,
      [graph.contextId,graph.jobId,graph.scope.universeId,'a'.repeat(64),graph.policy.policyVersion]);
      await assert.rejects(authenticatedCompile(pool,graph,token),error=>(error as {code?:string}).code==='23505');
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_job_session WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context WHERE id=$1',[graph.contextId])).rows[0]!.count,1);
    });
  });

  await t.test('the same authenticated session may compile a later context for the bound Job',async()=>{
    await withReasoningContextSchema('same_session_context',async pool=>{
      const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
      await authenticatedCompile(pool,graph,token);
      const laterContextId=randomUUID();
      await authenticatedCompile(pool,graph,token,{contextId:laterContextId});
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context WHERE job_id=$1',[graph.jobId])).rows[0]!.count,2);
      assert.deepEqual((await pool.query('SELECT session_id FROM reasoning_context_job_session WHERE job_id=$1',[graph.jobId])).rows,
        [{session_id:graph.scope.sessionId}]);
    });
  });

  await t.test('the binding cannot be updated or independently deleted',async()=>{
    await withReasoningContextSchema('immutable_binding',async pool=>{
      const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
      await authenticatedCompile(pool,graph,token);
      await assert.rejects(pool.query('UPDATE reasoning_context_job_session SET session_id=session_id WHERE job_id=$1',[graph.jobId]),
        /Direct Job session binding is immutable/);
      await assert.rejects(pool.query('DELETE FROM reasoning_context_job_session WHERE job_id=$1',[graph.jobId]),
        /Direct Job session binding erases only with its Job/);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_job_session WHERE job_id=$1',[graph.jobId])).rows[0]!.count,1);
    });
  });

  await t.test('history clear removes the private Job binding through Job deletion',async()=>{
    await withReasoningContextSchema('clear_binding',async pool=>{
      const graph=await seedDirectContextGraph(pool),token=await retoken(pool,graph.scope.sessionId);
      await authenticatedCompile(pool,graph,token);
      await inTransaction(pool,async client=>{
        const authenticated=await authenticateAndLock(client,token);
        await clearScrollHistory(client,authenticated,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});
      });
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_job_session WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
      assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!.count,0);
    });
  });

  await t.test('another same-universe session may compile only for a fresh Job and direct intent',async()=>{
    await withReasoningContextSchema('fresh_job_session',async pool=>{
      const graph=await seedDirectContextGraph(pool),firstToken=await retoken(pool,graph.scope.sessionId);
      await authenticatedCompile(pool,graph,firstToken);
      const second=await addSession(pool,graph.scope.universeId),jobId=randomUUID(),contextId=randomUUID();
      await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
        VALUES($1,$2,0,'queued','interactive',$2,$3,clock_timestamp()+interval '1 hour','direct',$4)`,
      [jobId,graph.scope.universeId,graph.policy.policyVersion,randomUUID()]);
      const policy={...graph.policy,buckets:graph.policy.buckets.map(bucket=>
        bucket.scope==='job'?{...bucket,scopeId:jobId}:bucket)};
      await authenticatedCompile(pool,{...graph,jobId,contextId,policy},second.token);
      assert.deepEqual((await pool.query('SELECT session_id FROM reasoning_context_job_session WHERE job_id=$1',[jobId])).rows,
        [{session_id:second.sessionId}]);
    });
  });
});
