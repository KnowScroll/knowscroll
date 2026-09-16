import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';

import type {AuthScope} from '../../packages/db/src/identity.ts';
import type {ResolvedReasoningPolicy} from '../../packages/db/src/reasoning-runtime-policy.ts';
import {runMigrations} from '../../packages/db/src/migrations.ts';

export const reasoningContextDatabaseUrl=process.env.DATABASE_URL??(()=>{throw new Error('DATABASE_URL required for reasoning context tests');})();
if(!new URL(reasoningContextDatabaseUrl).pathname.slice(1).startsWith('knowscroll_test_')) throw new Error('Reasoning context tests require a disposable knowscroll_test_* database');

export async function withReasoningContextSchema(name:string,fn:(pool:pg.Pool)=>Promise<void>):Promise<void> {
  const schema=`context_${name}_${randomUUID().replaceAll('-','')}`;
  const admin=new pg.Pool({connectionString:reasoningContextDatabaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(reasoningContextDatabaseUrl);
  url.searchParams.set('options',`-c search_path=${schema}`);
  const pool=new pg.Pool({connectionString:url.toString(),max:8});
  try { await runMigrations(pool,{directory:'packages/db/migrations'}); await fn(pool); }
  finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
}

export async function inTransaction<T>(pool:pg.Pool,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try { await client.query('BEGIN'); const value=await fn(client); await client.query('COMMIT'); return value; }
  catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export type DirectContextGraph={
  scope:AuthScope; jobId:string; contextId:string; keepEventIds:string[]; keepEventId:string;
  exposureId:string; assetId:string; decisionId:string; policy:ResolvedReasoningPolicy;
};

function scroll(assetId:string,revision=1) {
  return {assetId,revision,kind:'Scroll',title:'The clock that falls',summary:'A sourced Scroll',body:'Literal sourced body.',sourceTitle:'Example source',sourceUrl:'https://example.test/clock',truthState:'documented'} as const;
}

export async function seedDirectContextGraph(pool:pg.Pool,options:{universeId?:string;sessionId?:string;policyVersion?:string;secondKeep?:boolean}={}):Promise<DirectContextGraph> {
  const universeId=options.universeId??randomUUID();
  const sessionId=options.sessionId??randomUUID();
  const deviceId=randomUUID();
  const assetId=randomUUID();
  const decisionId=randomUUID();
  const exposureEventId=randomUUID();
  const exposureId=randomUUID();
  const keepEventId=randomUUID();
  const jobId=randomUUID();
  const contextId=randomUUID();
  const policyVersion=options.policyVersion??'context-fixture-v1';
  await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
  await pool.query('INSERT INTO accounts(universe_id) VALUES($1)',[universeId]);
  await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
    VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour')`,[sessionId,universeId,deviceId,createHash('sha256').update(randomUUID()).digest('hex')]);
  const asset=scroll(assetId);
  const editorialOrder=(await pool.query<{next_order:number}>('SELECT COALESCE(MAX(editorial_order),0)+1 AS next_order FROM asset')).rows[0]!.next_order;
  await pool.query(`INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[asset.assetId,asset.revision,asset.kind,asset.title,asset.summary,asset.body,asset.sourceTitle,asset.sourceUrl,asset.truthState,editorialOrder]);
  await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch)
    VALUES($1,$2,0,'editorial-unkept-v1',$3,0)`,[decisionId,universeId,JSON.stringify([asset])]);
  const exposureClientId=randomUUID();
  await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch)
    VALUES($1,$2,'exposure',$3,$4,0)`,[exposureEventId,universeId,exposureClientId,JSON.stringify({decisionId,assetId,clientExposureId:exposureClientId,exposureId})]);
  await pool.query('INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key) VALUES($1,$2,$3,$4,$5,$6)',[exposureId,universeId,decisionId,assetId,exposureEventId,exposureClientId]);
  const keepClientId=randomUUID();
  await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch)
    VALUES($1,$2,'keep',$3,$4,$5,0)`,[keepEventId,universeId,keepClientId,exposureEventId,JSON.stringify({clientEventId:keepClientId,exposureId,assetId,kind:'keep'})]);
  await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
    VALUES($1,$2,0,'queued','interactive',$2,$3,clock_timestamp()+interval '1 hour','direct',$4)`,[jobId,universeId,policyVersion,randomUUID()]);
  const dimensions=['global_budget','owner_budget','job_budget','provider_account','route_quota','remote_concurrency'] as const;
  const policy:ResolvedReasoningPolicy={version:1,routeId:'context-fixture-route',routeProfileVersion:'context-fixture-profile',policyVersion,
    maxInputTokens:1024,maxOutputTokens:1024,priceBasis:null,requiredDimensions:[...dimensions],
    buckets:dimensions.map(dimension=>({bucketId:randomUUID(),dimension,unit:dimension==='remote_concurrency'?'slots':'tokens',windowId:null,
      scope:dimension==='owner_budget'?'owner':dimension==='job_budget'?'job':'shared',scopeId:dimension==='owner_budget'?universeId:dimension==='job_budget'?jobId:null,
      basis:dimension==='remote_concurrency'?'remote_slots':'total_tokens',handling:dimension==='remote_concurrency'?'remote':'budget'})),
  };
  for(const bucket of policy.buckets) await pool.query('INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,$2,$3,100000)',[bucket.bucketId,bucket.dimension,bucket.unit]);
  const keepEventIds=[keepEventId];
  if(options.secondKeep) {
    const second=randomUUID(),clientId=randomUUID();
    await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch)
      VALUES($1,$2,'keep',$3,$4,$5,0)`,[second,universeId,clientId,exposureEventId,JSON.stringify({clientEventId:clientId,exposureId,assetId,kind:'keep'})]);
    keepEventIds.push(second);
  }
  const session=(await pool.query<{expires_at:Date}>('SELECT expires_at FROM device_session WHERE id=$1',[sessionId])).rows[0]!;
  return {scope:{sessionId,deviceId,universeId,privacyEpoch:0,expiresAt:session.expires_at.toISOString()},jobId,contextId,keepEventIds,keepEventId,exposureId,assetId,decisionId,policy};
}

export async function attachPendingStep(pool:pg.Pool,graph:DirectContextGraph,stepId=randomUUID()):Promise<string> {
  await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
    VALUES($1,$2,$3,$4,$5,1,'pending')`,[stepId,graph.jobId,graph.scope.universeId,graph.scope.privacyEpoch,graph.contextId]);
  return stepId;
}
