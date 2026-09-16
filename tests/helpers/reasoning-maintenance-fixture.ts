import {randomUUID} from 'node:crypto';
import pg from 'pg';

import {createReasoningAdmission} from '../../packages/db/src/reasoning-admission.ts';
import {runMigrations} from '../../packages/db/src/migrations.ts';

export const reasoningMaintenanceDatabaseUrl=process.env.DATABASE_URL??(()=>{throw new Error('DATABASE_URL required for reasoning maintenance tests');})();
if(!new URL(reasoningMaintenanceDatabaseUrl).pathname.slice(1).startsWith('knowscroll_test_')) throw new Error('Reasoning maintenance tests require a disposable knowscroll_test_* database');

export async function withReasoningMaintenanceSchema(name:string,fn:(pool:pg.Pool)=>Promise<void>):Promise<void> {
 const schema=`maintenance_${name}_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString:reasoningMaintenanceDatabaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(reasoningMaintenanceDatabaseUrl);
 url.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new pg.Pool({connectionString:url.toString(),max:8});
 try {await runMigrations(pool,{directory:'packages/db/migrations'});await fn(pool);}
 finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}

export async function inMaintenanceTransaction<T>(pool:pg.Pool,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
 const client=await pool.connect();
 try {await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}
 catch(error) {await client.query('ROLLBACK');throw error;}
 finally {client.release();}
}

export type WithdrawnReasoningGraph={universeId:string;jobId:string;contextIds:string[];stepIds:string[]};

export async function seedWithdrawnReasoningGraph(pool:pg.Pool,options:{steps?:number;contexts?:number}={}):Promise<WithdrawnReasoningGraph> {
 const steps=options.steps??1,contexts=options.contexts??1;
 if(!Number.isInteger(steps)||steps<1||!Number.isInteger(contexts)||contexts<1) throw new Error('Fixture graph counts must be positive integers');
 const universeId=randomUUID(),jobId=randomUUID(),intentId=randomUUID(),owner='maintenance-fixture';
 await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
 await pool.query(`INSERT INTO reasoning_job
  (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id,lease_owner,lease_fence,lease_expires_at)
  VALUES($1,$2,0,'running','interactive',$2,'maintenance-fixture',clock_timestamp()+interval '1 hour','direct',$3,$4,1,clock_timestamp()+interval '1 hour')`,
  [jobId,universeId,intentId,owner]);
 const contextIds:string[]=[];
 for(let index=0;index<contexts;index+=1) {
  const contextId=randomUUID();contextIds.push(contextId);
  await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
   VALUES($1,$2,$3,0,$4,'maintenance-fixture','maintenance-fixture')`,[contextId,jobId,universeId,'a'.repeat(64)]);
 }
 const stepIds:string[]=[];
 for(let ordinal=1;ordinal<=steps;ordinal+=1) {
  const stepId=randomUUID();stepIds.push(stepId);
  await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
   VALUES($1,$2,$3,0,$4,$5,'pending')`,[stepId,jobId,universeId,contextIds[(ordinal-1)%contextIds.length]!,ordinal]);
 }
 const admission=createReasoningAdmission(pool,{resolvePolicy:async()=>{throw new Error('Fixture withdrawal does not resolve policy');},validateContext:async()=>false});
 await admission.withdrawJob({universeId,privacyEpoch:0,jobId,owner,leaseFence:'1',reason:'cancelled'});
 return {universeId,jobId,contextIds,stepIds};
}

export async function ageWithdrawalForTest(pool:pg.Pool,jobId:string,hours=169):Promise<void> {
 if(!Number.isInteger(hours)||hours<168||hours>10_000) throw new Error('Fixture withdrawal age must be 168 through 10000 hours');
 await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_withdrawal_clock_guard');
 try {await pool.query("UPDATE reasoning_job SET withdrawn_at=clock_timestamp()-($2::bigint*interval '1 hour') WHERE id=$1",[jobId,hours]);}
 finally {await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_withdrawal_clock_guard');}
}

export async function seedPurgeableAccounting(pool:pg.Pool,universeId:string):Promise<string> {
 const attemptId=randomUUID();
 await pool.query(`INSERT INTO reasoning_accounting
  (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,
   state,output_authority,liability_state,remote_state,remote_disposition,reconciliation_hold,idempotency_hold,closure_basis,all_duties_closed_at)
  VALUES($1,$2,0,$3,'maintenance-fixture','maintenance-fixture',1,clock_timestamp()+interval '1 hour',
   'not_sent','withdrawn','settled','released','not_sent',false,false,'evidence',clock_timestamp()-interval '31 days')`,
  [attemptId,universeId,randomUUID()]);
 return attemptId;
}
