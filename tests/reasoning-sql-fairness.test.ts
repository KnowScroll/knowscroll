import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import {runMigrations} from '../packages/db/src/migrations.ts';
import {createReasoningFairness} from '../packages/db/src/reasoning-fairness.ts';
import type {ResolvedReasoningPolicy, ReasoningAuthority} from '../packages/db/src/reasoning-runtime-policy.ts';

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl) throw new Error('DATABASE_URL required for SQL fairness tests');
const fairnessPolicy={version:'fairness-v1',quantum:100,maxCharge:100,scale:100,basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes:8,maxAdmissions:1};

async function withSchema(name:string,fn:(pool:pg.Pool)=>Promise<void>) {
 const schema=`fair_${name}_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:databaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`); const url=new URL(databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);const pool=new pg.Pool({connectionString:url.toString(),max:6});
 try {await runMigrations(pool,{directory:'packages/db/migrations'});await fn(pool);} finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
function authorityFor(policies:Map<string,ResolvedReasoningPolicy>):ReasoningAuthority {
 return {async resolvePolicy(_c,scope){return policies.get(scope.jobId);},async validateContext(){return true;}};
}
async function seed(pool:pg.Pool,klass:'interactive'|'active_continuity'='interactive',capacity=1000) {
 const universeId=randomUUID(),jobId=randomUUID(),contextId=randomUUID(),stepId=randomUUID(),requestId=randomUUID();
 await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);await pool.query('INSERT INTO accounts(universe_id) VALUES($1)',[universeId]);
 await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
  VALUES($1,$2,0,'queued',$3,$2,'fairness-v1',clock_timestamp()+interval '1 hour','direct',$4)`,[jobId,universeId,klass,randomUUID()]);
 await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
  VALUES($1,$2,$3,0,$4,'fairness-v1','source-v1')`,[contextId,jobId,universeId,'a'.repeat(64)]);
 await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status) VALUES($1,$2,$3,0,$4,1,'pending')`,[stepId,jobId,universeId,contextId]);
 const buckets=[['global_budget','tokens','total_tokens','budget'],['owner_budget','tokens','total_tokens','budget'],['job_budget','tokens','total_tokens','budget'],['provider_account','requests','requests','budget'],['route_quota','requests','requests','budget'],['remote_concurrency','slots','remote_slots','remote']] as const;
 const bindings=buckets.map(([dimension,unit,basis,handling])=>({bucketId:randomUUID(),dimension,unit,windowId:null,
  scope:dimension==='owner_budget'?'owner':dimension==='job_budget'?'job':'shared',scopeId:dimension==='owner_budget'?universeId:dimension==='job_budget'?jobId:null,basis,handling}));
 for(const b of bindings) await pool.query('INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,$2,$3,$4)',[b.bucketId,b.dimension,b.unit,capacity]);
 const policy:ResolvedReasoningPolicy={version:1,routeId:'route',routeProfileVersion:'profile',policyVersion:'fairness-v1',maxInputTokens:100,maxOutputTokens:100,priceBasis:null,requiredDimensions:['global_budget','owner_budget','job_budget','provider_account','route_quota','remote_concurrency'],buckets:bindings as ResolvedReasoningPolicy['buckets']};
 return {universeId,jobId,contextId,stepId,requestId,policy};
}

test('SQL fairness atomically claims, debits, reserves and writes no settlement delta at admission',async()=>{
 await withSchema('atomic',async pool=>{
  const graph=await seed(pool);const policies=new Map([[graph.jobId,graph.policy]]);const fairness=createReasoningFairness(pool,authorityFor(policies));await fairness.installPolicy(fairnessPolicy);
  await fairness.enqueue({policyVersion:'fairness-v1',class:'interactive',universeId:graph.universeId,privacyEpoch:0,jobId:graph.jobId,stepId:graph.stepId,contextId:graph.contextId,requestId:graph.requestId,requestHash:'b'.repeat(64),inputTokensUpperBound:20,maxOutputTokens:20,costCeilingMicroUsd:null,deadline:new Date(Date.now()+30_000).toISOString(),permitTtlMs:20_000});
  const outcome=await fairness.schedule({policyVersion:'fairness-v1',owner:'fair-worker',leaseMs:20_000});assert.equal(outcome.kind,'admitted');
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt')).rows[0]?.n,1);
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_ready')).rows[0]?.n,0);
  assert.deepEqual((await pool.query('SELECT reserved_charge,recognized_charge FROM reasoning_fairness_attempt')).rows[0],{reserved_charge:'40',recognized_charge:'40'});
  assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_fairness_delta')).rows[0]?.n,0);
  assert.deepEqual((await pool.query("SELECT credit FROM reasoning_fairness_class WHERE class='interactive'")).rows[0],{credit:'460'});
 });
});
