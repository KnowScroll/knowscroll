/**
 * Shared disposable helpers for #81 terminal private retirement tests.
 *
 * Issue81 is the completed/failed branch of ADR-0019. This fixture only
 * exercises the database-authoritative finished_at clock trigger and the
 * 0011→0012 migration preservation slice. Coordinator owns maintenance
 * integration; tests do not assert the retirement batch's finished-branch
 * predicate yet.
 */
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';

import {runMigrations} from '../../packages/db/src/migrations.ts';

export const reasoningTerminalDatabaseUrl=process.env.DATABASE_URL??(()=>{throw new Error('DATABASE_URL required for terminal retirement tests');})();
if(!new URL(reasoningTerminalDatabaseUrl).pathname.slice(1).startsWith('knowscroll_test_')) {
 throw new Error('Terminal retirement tests require a disposable knowscroll_test_* database');
}

/** Builds a disposable schema with every numbered migration including 0012. */
export async function withReasoningTerminalSchema(
 name:string,
 fn:(pool:pg.Pool)=>Promise<void>,
):Promise<void> {
 const schema=`terminal_${name}_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString:reasoningTerminalDatabaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(reasoningTerminalDatabaseUrl);
 url.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new pg.Pool({connectionString:url.toString(),max:8});
 try {
  await runMigrations(pool,{directory:'packages/db/migrations'});
  await fn(pool);
 } finally {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
 }
}

export type TerminalGraph={
 universeId:string;
 sessionId:string;
 jobId:string;
 stepIds:string[];
 contextIds:string[];
 attemptIds:string[];
 permitIds:string[];
 policyVersion:string;
};

/** Builds the smallest private graph that satisfies every safe-terminal
 * predicate: live lease, no fair-ready membership, terminal Steps, inactive
 * Attempts whose retained accounting exists with withdrawn output authority
 * and state in not_sent/unknown/responded. */
export async function seedTerminalGraph(
 pool:pg.Pool,
 options:{
  terminalStatus?:'completed'|'failed';
  accountingState?:'not_sent'|'unknown'|'responded';
  jobStatus?:'running'|'waiting';
 }={},
):Promise<TerminalGraph> {
 const terminalStatus=options.terminalStatus??'completed';
 const accountingState=options.accountingState??'not_sent';
 const jobStatus=options.jobStatus??'running';
 if(!['completed','failed'].includes(terminalStatus)) throw new Error('Fixture terminal status must be completed or failed');
 if(!['not_sent','unknown','responded'].includes(accountingState)) throw new Error('Fixture accounting state must be terminal retained');
 if(!['running','waiting'].includes(jobStatus)) throw new Error('Fixture job status must be running or waiting');
 const universeId=randomUUID();
 const sessionId=randomUUID();
 const deviceId=randomUUID();
 const jobId=randomUUID();
 const intentId=randomUUID();
 const policyVersion='terminal-fixture-v1';
 const owner='terminal-fixture';
 const contextId=randomUUID();
 const stepId=randomUUID();
 const attemptId=randomUUID();
 const permitId=randomUUID();
 const reservationSetId=randomUUID();
 await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
 await pool.query('INSERT INTO accounts(universe_id) VALUES($1)',[universeId]);
 await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
   VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour')`,
  [sessionId,universeId,deviceId,createHash('sha256').update(`terminal-fixture:${randomUUID()}`).digest('hex')]);
 // A live old lease with positive fence: prerequisite for the safe-terminal
 // branch the migration draft relies on.
 await pool.query(`INSERT INTO reasoning_job
  (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id,
   lease_owner,lease_fence,lease_expires_at)
  VALUES($1,$2,0,$6,'interactive',$2,$3,clock_timestamp()+interval '1 hour','direct',$4,$5,1,clock_timestamp()+interval '1 hour')`,
  [jobId,universeId,policyVersion,intentId,owner,jobStatus]);
 await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
  VALUES($1,$2,$3,0,$4,$5,$6)`,[contextId,jobId,universeId,'a'.repeat(64),policyVersion,policyVersion]);
 await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
  VALUES($1,$2,$3,0,$4,1,'succeeded')`,[stepId,jobId,universeId,contextId]);
 // Inactive attempt, retained accounting, withdrawn output authority.
 await pool.query(`INSERT INTO reasoning_accounting
  (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,
   state,output_authority,liability_state,remote_state,remote_disposition,reconciliation_hold,idempotency_hold)
  VALUES($1,$2,0,$3,$4,$5,1,clock_timestamp()+interval '1 hour',$6,'withdrawn','settled','released','not_sent',false,false)`,
  [attemptId,universeId,randomUUID(),'terminal-fixture','terminal-fixture',accountingState]);
 await pool.query(`INSERT INTO reasoning_permit(id,attempt_id,universe_id,privacy_epoch,reservation_set_id,expires_at)
  VALUES($1,$2,$3,0,$4,clock_timestamp()-interval '1 hour')`,
  [permitId,attemptId,universeId,reservationSetId]);
 await pool.query(`INSERT INTO reasoning_attempt
  (id,job_id,step_id,context_id,universe_id,privacy_epoch,ordinal,lease_fence,request_hash,permit_id,reservation_set_id,active)
  VALUES($1,$2,$3,$4,$5,0,1,1,$6,$7,$8,false)`,
  [attemptId,jobId,stepId,contextId,universeId,'b'.repeat(64),permitId,reservationSetId]);
 return {
  universeId,sessionId,jobId,stepIds:[stepId],contextIds:[contextId],
  attemptIds:[attemptId],permitIds:[permitId],policyVersion,
 };
}

/** Reads the current Job row in a fixture-stable shape. */
export async function readJob(pool:pg.Pool,jobId:string):Promise<{
 status:string;lease_fence:string;lease_owner:string|null;lease_expires_at:Date|null;
 withdrawn_at:Date|null;finished_at:Date|null;
}> {
 const row=(await pool.query(
  `SELECT status,lease_fence::text,lease_owner,lease_expires_at,withdrawn_at,finished_at
   FROM reasoning_job WHERE id=$1`,[jobId],
 )).rows[0]!;
 return {
  status:row.status,lease_fence:row.lease_fence,lease_owner:row.lease_owner,
  lease_expires_at:row.lease_expires_at,withdrawn_at:row.withdrawn_at,finished_at:row.finished_at,
 };
}

/** Marks the Job's attempt active and accounting eligible so a stamp attempt
 * must fail the safe-terminal predicate. The accounting and attempt
 * reactivations are forbidden by the original guards, so this bypasses both
 * triggers for the duration of the helper. */
export async function corruptTerminalClosure(pool:pg.Pool,jobId:string):Promise<void> {
 await pool.query('ALTER TABLE reasoning_accounting DISABLE TRIGGER reasoning_accounting_guard');
 await pool.query('ALTER TABLE reasoning_attempt DISABLE TRIGGER ALL');
 try {
  await pool.query(`UPDATE reasoning_accounting SET state='reserved',output_authority='eligible',remote_disposition='unconfirmed' WHERE attempt_id IN (SELECT id FROM reasoning_attempt WHERE job_id=$1)`,[jobId]);
 } finally {
  await pool.query('ALTER TABLE reasoning_accounting ENABLE TRIGGER reasoning_accounting_guard');
  await pool.query('ALTER TABLE reasoning_attempt ENABLE TRIGGER ALL');
 }
 await pool.query('ALTER TABLE reasoning_attempt DISABLE TRIGGER ALL');
 try {await pool.query('UPDATE reasoning_attempt SET active=true WHERE job_id=$1',[jobId]);}
 finally {await pool.query('ALTER TABLE reasoning_attempt ENABLE TRIGGER ALL');}
}
