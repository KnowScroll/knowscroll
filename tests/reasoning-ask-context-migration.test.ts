import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';

import {recordExplicitAsk} from '../packages/db/src/explicit-ask.ts';
import {inTransaction,seedDirectContextGraph,withReasoningContextSchema} from './helpers/reasoning-context-fixture.ts';

type AskGraph={
 universeId:string;sessionId:string;askId:string;jobId:string;policyVersion:string;
};

async function seedAskJob(pool:pg.Pool):Promise<AskGraph> {
 const graph=await seedDirectContextGraph(pool);
 const ask=await inTransaction(pool,async client=>{
  await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
  await client.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
  return recordExplicitAsk(client,graph.scope,{
   clientAskId:randomUUID(),exposureId:graph.exposureId,expectedPrivacyEpoch:0,question:'  literal Ask\n',
  });
 });
 const jobId=randomUUID();
 await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
  VALUES($1,$2,0,'queued','interactive',$2,$3,clock_timestamp()+interval '1 hour','direct',$4)`,
 [jobId,graph.scope.universeId,graph.policy.policyVersion,ask.askId]);
 await pool.query(`INSERT INTO reasoning_context_job_session(job_id,universe_id,privacy_epoch,session_id)
  VALUES($1,$2,0,$3)`,[jobId,graph.scope.universeId,graph.scope.sessionId]);
 return {universeId:graph.scope.universeId,sessionId:graph.scope.sessionId,askId:ask.askId,jobId,policyVersion:graph.policy.policyVersion};
}

async function bind(pool:pg.Pool,graph:AskGraph):Promise<void> {
 await pool.query(`INSERT INTO reasoning_context_job_ask(job_id,universe_id,privacy_epoch,session_id,ask_id)
  VALUES($1,$2,0,$3,$4)`,[graph.jobId,graph.universeId,graph.sessionId,graph.askId]);
}

test('0010 binds only the original Ask/session/queued Job and freezes its family identity',async t=>{
 await t.test('accepts the scoped binding but rejects rebinding and direct-Scroll context substitution',async()=>{
  await withReasoningContextSchema('ask_context_binding',async pool=>{
   const graph=await seedAskJob(pool);
   await bind(pool,graph);
   assert.deepEqual((await pool.query(`SELECT job_id,universe_id,privacy_epoch,session_id,ask_id
     FROM reasoning_context_job_ask WHERE job_id=$1`,[graph.jobId])).rows[0],{
    job_id:graph.jobId,universe_id:graph.universeId,privacy_epoch:0,session_id:graph.sessionId,ask_id:graph.askId,
   });
   await assert.rejects(pool.query('UPDATE reasoning_context_job_ask SET ask_id=$2 WHERE job_id=$1',[graph.jobId,randomUUID()]),/immutable/);
   await assert.rejects(pool.query('DELETE FROM reasoning_context_job_ask WHERE job_id=$1',[graph.jobId]),/erases only with its Job/);
   await assert.rejects(pool.query('UPDATE reasoning_job SET intent_id=$2 WHERE id=$1',[graph.jobId,randomUUID()]),/identity is immutable/);
   await assert.rejects(pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,0,$4,$5,'editorial-asset-pointer-v1')`,
    [randomUUID(),graph.jobId,graph.universeId,'a'.repeat(64),graph.policyVersion]),/cannot change context family/);
   await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,0,$4,$5,'ask-editorial-asset-pointer-v1')`,
    [randomUUID(),graph.jobId,graph.universeId,'b'.repeat(64),graph.policyVersion]);
  });
 });

 await t.test('a pre-existing Keep family prevents Ask binding and failure leaves no partial row',async()=>{
  await withReasoningContextSchema('ask_context_rollback',async pool=>{
   const graph=await seedAskJob(pool);
   await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,0,$4,$5,'editorial-asset-pointer-v1')`,
    [randomUUID(),graph.jobId,graph.universeId,'c'.repeat(64),graph.policyVersion]);
   await assert.rejects(bind(pool,graph),/already uses another context family/);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_job_ask WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
  });
 });

 await t.test('Job deletion cascades only the private binding and preserves recorded Ask source history',async()=>{
  await withReasoningContextSchema('ask_context_retirement_shape',async pool=>{
   const graph=await seedAskJob(pool);
   await bind(pool,graph);
   await pool.query('DELETE FROM reasoning_job WHERE id=$1',[graph.jobId]);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_job_ask WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE id=$1',[graph.askId])).rows[0]!.count,1);
   assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger l JOIN explicit_ask a ON a.event_id=l.id WHERE a.id=$1`,[graph.askId])).rows[0]!.count,1);
  });
 });
});
