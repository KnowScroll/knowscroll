import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';
import {test} from 'node:test';
import pg from 'pg';
import {runMigrations} from '../packages/db/src/migrations.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {createReasoningAdmission} from '../packages/db/src/reasoning-admission.ts';
import {createReasoningReconciliation} from '../packages/db/src/reasoning-reconciliation.ts';
import {type ResolvedReasoningPolicy} from '../packages/db/src/reasoning-runtime-policy.ts';
import {invokeReasoningOnce} from '../apps/worker/src/reasoning/invoke.ts';

const databaseUrl=process.env.DATABASE_URL!;
if(!new URL(databaseUrl).pathname.startsWith('/knowscroll_test_')) throw new Error('Disposable test database required');

// Real SQL and HTTP; provider responses are explicitly local synthetic fixtures, not MiniMax evidence.
test('one committed HTTP fixture invocation settles original usage after concurrent privacy clear',async()=>{
 const schema='invocation_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:databaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
 const db=new pg.Pool({connectionString:url.toString(),max:8});
 let response:ServerResponse|undefined,requestCount=0;
 let arrive!:()=>void;
 const arrived=new Promise<void>(resolve=>{arrive=resolve;});
 const server=createServer((_req,res)=>{requestCount++;response=res;arrive();});
 let invocation:Promise<unknown>|undefined;
 try {
  await runMigrations(db,{directory:'packages/db/migrations'});
  const universeId=randomUUID(),jobId=randomUUID(),stepId=randomUUID(),contextId=randomUUID(),sessionId=randomUUID(),deviceId=randomUUID();
  await db.query('INSERT INTO universe(id) VALUES($1)',[universeId]);
  await db.query('INSERT INTO accounts(universe_id) VALUES($1)',[universeId]);
  await db.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at) VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour')`,[sessionId,universeId,deviceId,createHash('sha256').update(randomUUID()).digest('hex')]);
  await db.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id) VALUES($1,$2,0,'queued','interactive',$2,'fixture-v1',clock_timestamp()+interval '1 hour','direct',$3)`,[jobId,universeId,randomUUID()]);
  await db.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version) VALUES($1,$2,$3,0,$4,'fixture-v1','fixture-v1')`,[contextId,jobId,universeId,'a'.repeat(64)]);
  await db.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status) VALUES($1,$2,$3,0,$4,1,'pending')`,[stepId,jobId,universeId,contextId]);
  const dimensions=['global_budget','owner_budget','job_budget','provider_account','route_quota','remote_concurrency'] as const;
  const policy:ResolvedReasoningPolicy={version:1,routeId:'local-fixture',routeProfileVersion:'fixture-v1',policyVersion:'fixture-v1',maxInputTokens:1000,maxOutputTokens:1000,priceBasis:null,requiredDimensions:[...dimensions],buckets:dimensions.map(d=>({bucketId:randomUUID(),dimension:d,unit:d==='remote_concurrency'?'slots':'tokens',windowId:null,scope:d==='owner_budget'?'owner':d==='job_budget'?'job':'shared',scopeId:d==='owner_budget'?universeId:d==='job_budget'?jobId:null,basis:d==='remote_concurrency'?'remote_slots':'total_tokens',handling:d==='remote_concurrency'?'remote':'budget'}))};
  for(const b of policy.buckets) await db.query('INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,$2,$3,10000)',[b.bucketId,b.dimension,b.unit]);
  const admission=createReasoningAdmission(db,{resolvePolicy:async()=>policy,validateContext:async(client,scope)=>!!(await client.query('SELECT 1 FROM reasoning_context WHERE id=$1 AND job_id=$2 AND universe_id=$3 AND privacy_epoch=$4',[scope.contextId,scope.jobId,scope.universeId,scope.privacyEpoch])).rowCount});
  const reconciliation=createReasoningReconciliation(db);
  const claim=await admission.claimJob({owner:'fixture-worker',leaseMs:60000});assert.ok(claim);assert.equal(claim.jobId,jobId);
  const body=Buffer.from(JSON.stringify({synthetic:true,maxOutputTokens:100})),requestHash=createHash('sha256').update(body).digest('hex'),requestId=randomUUID();
  const reserved=await admission.reserveAttempt({universeId,privacyEpoch:0,jobId,stepId,contextId,owner:'fixture-worker',leaseFence:claim.leaseFence,requestId,requestHash,inputTokensUpperBound:body.byteLength,maxOutputTokens:100,costCeilingMicroUsd:null,deadline:new Date(Date.now()+45000).toISOString(),permitTtlMs:45000});
  const authorization={universeId,privacyEpoch:0,jobId,stepId,attemptId:reserved.attemptId,owner:'fixture-worker',leaseFence:claim.leaseFence,requestId,requestHash,inputTokensUpperBound:body.byteLength,maxOutputTokens:100,dispatchId:randomUUID()};
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  invocation=invokeReasoningOnce({admission,reconciliation,authorization,body,signal:new AbortController().signal,transport:{invoke:async input=>{
   const result=await fetch(`http://127.0.0.1:${address.port}`,{method:'POST',body:Buffer.from(input.body),signal:input.signal});return result.json();
  }}});
  await Promise.race([arrived,invocation.then(()=>{throw new Error('Invocation ended before HTTP fixture arrived');})]);
  assert.equal((await db.query('SELECT state FROM reasoning_accounting WHERE attempt_id=$1',[reserved.attemptId])).rows[0].state,'dispatch_committed');
  assert.equal((await db.query('SELECT state FROM reasoning_permit WHERE attempt_id=$1',[reserved.attemptId])).rows[0].state,'consumed');
  const clearing=await db.connect();
  try {
   await clearing.query('BEGIN');await clearing.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[universeId]);
   await clearScrollHistory(clearing,{universeId,privacyEpoch:0,sessionId,deviceId,expiresAt:new Date(Date.now()+3600000).toISOString()},{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});
   await clearing.query('COMMIT');
  } catch(error) {await clearing.query('ROLLBACK');throw error;} finally {clearing.release();}
  response!.setHeader('content-type','application/json');response!.end(JSON.stringify({remoteDisposition:'terminal',outcome:'success',httpStatus:200,usage:{inputTokens:7,outputTokens:3,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}}));
  assert.equal((await invocation as {kind:string}).kind,'recorded');
  assert.equal(requestCount,1);
  await assert.rejects(admission.authorizeDispatch(authorization));assert.equal(requestCount,1);
  for(const table of ['reasoning_job','reasoning_step','reasoning_context','reasoning_attempt']) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table} WHERE universe_id=$1`,[universeId])).rows[0].n,0);
  assert.deepEqual((await db.query('SELECT privacy_epoch,state,output_authority,liability_state,remote_state FROM reasoning_accounting WHERE attempt_id=$1',[reserved.attemptId])).rows[0],{privacy_epoch:0,state:'responded',output_authority:'withdrawn',liability_state:'settled',remote_state:'released'});
  assert.equal((await db.query('SELECT count(*)::int n FROM reasoning_settlement WHERE attempt_id=$1',[reserved.attemptId])).rows[0].n,1);
  for(const b of policy.buckets) assert.deepEqual((await db.query('SELECT reserved,consumed FROM reasoning_bucket WHERE id=$1',[b.bucketId])).rows[0],{reserved:'0',consumed:b.handling==='remote'?'0':'10'});
 } finally {
  response?.destroy();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(invocation) await invocation.catch(()=>undefined);
  await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
 }
});
