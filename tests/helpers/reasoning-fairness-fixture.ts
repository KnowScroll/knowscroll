import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {runMigrations} from '../../packages/db/src/migrations.ts';
import type {ResolvedReasoningPolicy,ReasoningAuthority} from '../../packages/db/src/reasoning-runtime-policy.ts';

export const sqlFairnessPolicy={version:'fairness-v1',quantum:100,maxCharge:100,scale:100,basis:{input_tokens:100,output_tokens:100,total_tokens:100,requests:100},maxProbes:8,maxAdmissions:1};
export const sqlFairnessDatabaseUrl=process.env.DATABASE_URL??(()=>{throw new Error('DATABASE_URL required for SQL fairness tests');})();
if(!new URL(sqlFairnessDatabaseUrl).pathname.slice(1).startsWith('knowscroll_test_')) throw new Error('SQL fairness tests require a disposable knowscroll_test_* database');
export async function withFairnessSchema(name:string,fn:(pool:pg.Pool)=>Promise<void>) {
 const schema=`fair_${name}_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:sqlFairnessDatabaseUrl});await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(sqlFairnessDatabaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);const pool=new pg.Pool({connectionString:url.toString(),max:8});
 try {await runMigrations(pool,{directory:'packages/db/migrations'});await fn(pool);} finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
export function fairnessAuthority(policies:Map<string,ResolvedReasoningPolicy>):ReasoningAuthority {return {async resolvePolicy(_c,scope){return policies.get(scope.jobId);},async validateContext(){return true;}};}
export async function seedFairnessGraph(pool:pg.Pool,klass:'interactive'|'active_continuity'|'accumulated_interpretation'|'background_inquiry'|'housekeeping'='interactive',capacity=1000,existingUniverseId?:string) {
 const universeId=existingUniverseId??randomUUID(),jobId=randomUUID(),contextId=randomUUID(),stepId=randomUUID(),requestId=randomUUID();
 if(!existingUniverseId) {await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);await pool.query('INSERT INTO accounts(universe_id) VALUES($1)',[universeId]);}
 await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id) VALUES($1,$2,0,'queued',$3,$2,'fairness-v1',clock_timestamp()+interval '1 hour','direct',$4)`,[jobId,universeId,klass,randomUUID()]);
 await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version) VALUES($1,$2,$3,0,$4,'fairness-v1','source-v1')`,[contextId,jobId,universeId,'a'.repeat(64)]);
 await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status) VALUES($1,$2,$3,0,$4,1,'pending')`,[stepId,jobId,universeId,contextId]);
 const defs=[['global_budget','tokens','total_tokens','budget'],['owner_budget','tokens','total_tokens','budget'],['job_budget','tokens','total_tokens','budget'],['provider_account','requests','requests','budget'],['route_quota','requests','requests','budget'],['remote_concurrency','slots','remote_slots','remote']] as const;
 const buckets=defs.map(([dimension,unit,basis,handling])=>({bucketId:randomUUID(),dimension,unit,windowId:null,scope:dimension==='owner_budget'?'owner':dimension==='job_budget'?'job':'shared',scopeId:dimension==='owner_budget'?universeId:dimension==='job_budget'?jobId:null,basis,handling}));
 for(const b of buckets) await pool.query('INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,$2,$3,$4)',[b.bucketId,b.dimension,b.unit,capacity]);
 const policy:ResolvedReasoningPolicy={version:1,routeId:'route',routeProfileVersion:'profile',policyVersion:'fairness-v1',maxInputTokens:100,maxOutputTokens:100,priceBasis:null,requiredDimensions:['global_budget','owner_budget','job_budget','provider_account','route_quota','remote_concurrency'],buckets:buckets as ResolvedReasoningPolicy['buckets']};
 return {universeId,jobId,contextId,stepId,requestId,policy};
}
