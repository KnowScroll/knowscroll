import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';
import {createReasoningMaintenance} from '../packages/db/src/reasoning-maintenance.ts';
import {createReasoningReconciliation} from '../packages/db/src/reasoning-reconciliation.ts';
import {authenticateAndLock} from '../packages/db/src/identity.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {seedIdleGraph,reserveIdleGraph,type IdleGraph} from './helpers/reasoning-idle-fixture.ts';
import {inTransaction} from './helpers/reasoning-context-fixture.ts';
import {withReasoningMaintenanceSchema} from './helpers/reasoning-maintenance-fixture.ts';

async function finish(pool:pg.Pool,graph:IdleGraph,outcome:'completed'|'failed') {
 await inTransaction(pool,async c=>{
  await c.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
  await c.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE',[graph.jobId]);
  await c.query("UPDATE reasoning_step SET status=$2 WHERE job_id=$1",[graph.jobId,outcome==='completed'?'succeeded':'failed']);
  await c.query('UPDATE reasoning_job SET status=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1',[graph.jobId,outcome]);
 });
}
async function terminal(pool:pg.Pool,outcome:'completed'|'failed') {
 const graph=await seedIdleGraph(pool);
 const claim=await graph.admission.claimJob({owner:'terminal-fixture',leaseMs:60_000});
 assert.equal(claim?.jobId,graph.jobId);
 await finish(pool,graph,outcome);return graph;
}
async function age(pool:pg.Pool,jobId:string,hours:number) {
 // Explicit time travel only inside the helper's disposable, isolated schema.
 await inTransaction(pool,async c=>{
  await c.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_finished_clock_guard');
  await c.query("UPDATE reasoning_job SET finished_at=clock_timestamp()-($2::numeric*interval '1 hour') WHERE id=$1",[jobId,hours]);
  await c.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_finished_clock_guard');
 });
}
async function exists(pool:pg.Pool,id:string) {
 return (await pool.query('SELECT 1 FROM reasoning_job WHERE id=$1',[id])).rowCount===1;
}
async function sourceHistory(pool:pg.Pool,universeId:string) {
 return Promise.all(['ledger','exposure','decision','trace','explicit_ask'].map(async table=>
  (await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE universe_id=$1 ORDER BY to_jsonb(t)::text`,[universeId])).rows));
}

test('completed and failed private context retire at 168 hours while young graphs and source history survive',async()=>{
 await withReasoningMaintenanceSchema('terminal_age',async pool=>{
  const completed=await terminal(pool,'completed'),failed=await terminal(pool,'failed'),young=await terminal(pool,'completed'),legacy=await terminal(pool,'failed');
  await inTransaction(pool,async c=>{
   await c.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_finished_clock_guard');
   await c.query('UPDATE reasoning_job SET finished_at=NULL WHERE id=$1',[legacy.jobId]);
   await c.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_finished_clock_guard');
  });
  await age(pool,completed.jobId,168);await age(pool,failed.jobId,169);await age(pool,young.jobId,167);
  const before=await sourceHistory(pool,completed.scope.universeId);
  const result=await createReasoningMaintenance(pool).runBatch({maxProbes:24});
  assert.equal(result.retiredJobs,2);assert.equal(await exists(pool,completed.jobId),false);assert.equal(await exists(pool,failed.jobId),false);
  assert.equal(await exists(pool,young.jobId),true);assert.equal(await exists(pool,legacy.jobId),true);
  assert.equal((await pool.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[legacy.jobId])).rows[0].finished_at,null);
  assert.equal((await pool.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=$1',[completed.contextId])).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM reasoning_context_job_session WHERE job_id=$1',[completed.jobId])).rowCount,0);
  assert.deepEqual(await sourceHistory(pool,completed.scope.universeId),before);
 });
});

test('finished context retirement preserves unknown accounting and late settlement cannot resurrect private state',async()=>{
 await withReasoningMaintenanceSchema('terminal_unknown',async pool=>{
  const graph=await seedIdleGraph(pool),{input,reserved}=await reserveIdleGraph(pool,graph),dispatchId=randomUUID();
  await graph.admission.authorizeDispatch({...input,attemptId:reserved.attemptId,dispatchId});
  await graph.admission.markAttemptUnknown({...input,attemptId:reserved.attemptId,reason:'local_cancel'});
  await finish(pool,graph,'failed');await age(pool,graph.jobId,169);
  const retained=async()=>Promise.all(['reasoning_accounting','reasoning_permit','reasoning_reservation'].map(async table=>
   (await pool.query(`SELECT to_jsonb(t) row FROM ${table} t WHERE attempt_id=$1 ORDER BY to_jsonb(t)::text`,[reserved.attemptId])).rows));
  const before=await retained();
  const buckets=(await pool.query('SELECT to_jsonb(b) row FROM reasoning_bucket b ORDER BY id')).rows;
  assert.equal((await createReasoningMaintenance(pool).runBatch({maxProbes:6})).retiredJobs,1);
  assert.deepEqual(await retained(),before);assert.deepEqual((await pool.query('SELECT to_jsonb(b) row FROM reasoning_bucket b ORDER BY id')).rows,buckets);
  assert.equal(await exists(pool,graph.jobId),false);
  const receipt={version:1 as const,receiptId:randomUUID(),attemptId:reserved.attemptId,requestId:input.requestId,dispatchId,
   routeId:graph.policy.routeId,routeProfileVersion:graph.policy.routeProfileVersion,evidenceKind:'original_transport' as const,
   observedAt:new Date().toISOString(),remoteDisposition:'terminal' as const,outcome:'success' as const,httpStatus:200,
   usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}};
  const reconciliation=createReasoningReconciliation(pool);
  await reconciliation.recordAndSettleReceipt(receipt,'worker');assert.equal((await reconciliation.recordAndSettleReceipt(receipt,'worker')).replayed,true);
  assert.equal(await exists(pool,graph.jobId),false);
  assert.equal((await pool.query('SELECT output_authority FROM reasoning_accounting WHERE attempt_id=$1',[reserved.attemptId])).rows[0].output_authority,'withdrawn');
 });
});

test('terminal retirement skips a locked universe, unsafe steps and oversized context graphs',async()=>{
 await withReasoningMaintenanceSchema('terminal_refusal',async pool=>{
  const locked=await terminal(pool,'failed'),unsafe=await terminal(pool,'completed'),large=await terminal(pool,'completed'),other=await terminal(pool,'completed');
  for(const graph of [locked,unsafe,large,other])await age(pool,graph.jobId,169);
  await pool.query("UPDATE reasoning_step SET status='pending' WHERE id=$1",[unsafe.stepId]);
  await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
   SELECT gen_random_uuid(),job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version
   FROM reasoning_context CROSS JOIN generate_series(1,128) WHERE id=$1`,[large.contextId]);
  const blocker=await pool.connect();await blocker.query('BEGIN');
  try {
   await blocker.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[locked.scope.universeId]);
   assert.equal((await createReasoningMaintenance(pool).runBatch({maxProbes:24})).retiredJobs,1);
   assert.equal(await exists(pool,other.jobId),false);
   for(const graph of [locked,unsafe,large])assert.equal(await exists(pool,graph.jobId),true);
  } finally {await blocker.query('ROLLBACK');blocker.release();}
 });
});

test('a rejected private deletion rolls back the entire graph and Clear erases a young finished graph immediately',async()=>{
 await withReasoningMaintenanceSchema('terminal_rollback_clear',async pool=>{
  const graph=await terminal(pool,'completed');await age(pool,graph.jobId,169);
  await pool.query("CREATE FUNCTION reject_terminal_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture deletion rejected'; END $$");
  await pool.query('CREATE TRIGGER reject_terminal_delete BEFORE DELETE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION reject_terminal_delete()');
  await assert.rejects(createReasoningMaintenance(pool).runBatch({maxProbes:2}),/fixture deletion rejected/);
  assert.equal(await exists(pool,graph.jobId),true);assert.equal((await pool.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=$1',[graph.contextId])).rowCount,1);
  await pool.query('DROP TRIGGER reject_terminal_delete ON reasoning_job');
  const young=await terminal(pool,'failed'),requestId=randomUUID();
  const clear=()=>inTransaction(pool,async c=>clearScrollHistory(c,await authenticateAndLock(c,young.token),{requestId,expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'}));
  const original=await clear();assert.equal(await exists(pool,young.jobId),false);assert.deepEqual(await clear(),original);
 });
});

test('terminal retirement rechecks unsafe children after an actual lock wait',async()=>{
 await withReasoningMaintenanceSchema('terminal_wait',async pool=>{
  const graph=await terminal(pool,'completed');await age(pool,graph.jobId,169);
  const blocker=await pool.connect();await blocker.query('BEGIN');
  let pending:Promise<unknown>|undefined;
  try {
   const pid=Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
   await blocker.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE',[graph.stepId]);
   pending=createReasoningMaintenance(pool).runBatch({maxProbes:2});void pending.catch(()=>{});
   let observed=false;
   for(let probe=0;probe<40;probe++) {
    observed=(await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount!==0;
    if(observed)break;
    await new Promise(resolve=>setTimeout(resolve,5));
   }
   assert(observed,'maintenance reached the child resource wait');
   // Deliberately bypass the normal universe-first writer discipline as an adversary.
   await blocker.query("UPDATE reasoning_step SET status='pending' WHERE id=$1",[graph.stepId]);
   await blocker.query('COMMIT');
   const result=await pending as {retiredJobs:number};assert.equal(result.retiredJobs,0);
   assert.equal(await exists(pool,graph.jobId),true);
   assert.equal((await pool.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=$1',[graph.contextId])).rowCount,1);
  } finally {await blocker.query('ROLLBACK');blocker.release();if(pending)await pending.catch(()=>{});}
 });
});

test('finish clock refuses a lease that expires while terminal safety inspection is blocked',async()=>{
 await withReasoningMaintenanceSchema('finish_clock_wait',async pool=>{
  const graph=await seedIdleGraph(pool);
  const claim=await graph.admission.claimJob({owner:'finish-clock-wait',leaseMs:60_000});assert.equal(claim?.jobId,graph.jobId);
  await pool.query("UPDATE reasoning_step SET status='succeeded' WHERE id=$1",[graph.stepId]);
  await pool.query("UPDATE reasoning_job SET lease_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[graph.jobId]);
  const blocker=await pool.connect();await blocker.query('BEGIN');
  let pending:Promise<pg.QueryResult>|undefined;
  try {
   const pid=Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid);
   await blocker.query('LOCK TABLE reasoning_fairness_ready IN ACCESS EXCLUSIVE MODE');
   pending=pool.query("UPDATE reasoning_job SET status='completed',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[graph.jobId]);
   void pending.catch(()=>{});
   let observed=false;
   for(let probe=0;probe<100;probe++) {
    observed=(await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount!==0;
    if(observed)break;
    await new Promise(resolve=>setTimeout(resolve,5));
   }
   assert(observed,'terminal guard encountered the blocked safety relation');
   for(let probe=0;probe<150;probe++) {
    if((await pool.query('SELECT lease_expires_at<=clock_timestamp() expired FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0].expired)break;
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   assert.equal((await pool.query('SELECT lease_expires_at<=clock_timestamp() expired FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0].expired,true);
   await blocker.query('COMMIT');await assert.rejects(pending,/safely terminal|live lease/);
   assert.deepEqual((await pool.query('SELECT status,finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0],{status:'running',finished_at:null});
  } finally {await blocker.query('ROLLBACK');blocker.release();if(pending)await pending.catch(()=>{});}
 });
});
