import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';

import {recordExplicitAsk} from '../packages/db/src/explicit-ask.ts';
import {authenticateAndLock} from '../packages/db/src/identity.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {compileDirectAskContext,validateDirectAskContext} from '../packages/db/src/reasoning-ask-context.ts';
import {createReasoningAdmission} from '../packages/db/src/reasoning-admission.ts';
import {createReasoningMaintenance} from '../packages/db/src/reasoning-maintenance.ts';
import {ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';
import {
  attachPendingStep,
  inTransaction,
  seedDirectContextGraph,
  withReasoningContextSchema,
  type DirectContextGraph,
} from './helpers/reasoning-context-fixture.ts';

type AskGraph=DirectContextGraph&{askId:string;askEventId:string;clientAskId:string;token:string;question:string};

const tokenHash=(token:string)=>createHash('sha256').update(token,'utf8').digest('hex');
const resolverFor=(graph:DirectContextGraph)=>async()=>graph.policy;

async function retoken(pool:pg.Pool,sessionId:string):Promise<string> {
 const token=randomBytes(32).toString('base64url');
 await pool.query('UPDATE device_session SET token_hash=$1 WHERE id=$2',[tokenHash(token),sessionId]);
 return token;
}

async function addSession(pool:pg.Pool,universeId:string):Promise<{sessionId:string;token:string}> {
 const sessionId=randomUUID(),token=randomBytes(32).toString('base64url');
 await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
  VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour')`,[sessionId,universeId,randomUUID(),tokenHash(token)]);
 return {sessionId,token};
}

async function seedAskGraph(pool:pg.Pool,question='  e\u0301\r\nWhat is actually changing?  '):Promise<AskGraph> {
 const graph=await seedDirectContextGraph(pool);
 const token=await retoken(pool,graph.scope.sessionId);
 const clientAskId=randomUUID();
 const ask=await inTransaction(pool,async client=>{
  await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
  await client.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
  return recordExplicitAsk(client,graph.scope,{
   clientAskId,exposureId:graph.exposureId,expectedPrivacyEpoch:0,question,
  });
 });
 await pool.query('UPDATE reasoning_job SET intent_id=$2 WHERE id=$1',[graph.jobId,ask.askId]);
 return {...graph,askId:ask.askId,askEventId:ask.eventId,clientAskId,token,question};
}

async function compile(pool:pg.Pool,graph:AskGraph,contextId=graph.contextId):Promise<{contextId:string;contentHash:string;readSetHash:string}> {
 return inTransaction(pool,async client=>{
  const authenticated=await authenticateAndLock(client,graph.token);
  return compileDirectAskContext(client,authenticated,{contextId,jobId:graph.jobId,askId:graph.askId},resolverFor(graph));
 });
}

async function validate(pool:pg.Pool,graph:AskGraph,stepId:string,phase:'lock'|'recheck'='lock') {
 return inTransaction(pool,async client=>{
  // Callers own this ordered prerequisite. The Ask validator only adds source
  // asset locks in `lock`, and it adds none in `recheck`.
  await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
  await client.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
  await client.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE',[graph.jobId]);
  await client.query('SELECT id FROM reasoning_step WHERE id=$1 FOR UPDATE',[stepId]);
  return validateDirectAskContext(client,{
   universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,
   contextId:graph.contextId,policyVersion:graph.policy.policyVersion,
  },resolverFor(graph),phase);
 });
}

async function count(pool:pg.Pool,table:string,column:string,value:string):Promise<number> {
 return (await pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`,[value])).rows[0]!.count;
}

async function assertNoExecutionMutation(pool:pg.Pool,graph:AskGraph):Promise<void> {
 assert.equal(await count(pool,'reasoning_step','job_id',graph.jobId),0);
 assert.equal(await count(pool,'reasoning_attempt','job_id',graph.jobId),0);
 assert.equal(await count(pool,'reasoning_accounting','universe_id',graph.scope.universeId),0);
 assert.equal((await pool.query<{count:number}>('SELECT count(*)::int AS count FROM job WHERE universe_id=$1',[graph.scope.universeId])).rows[0]!.count,0);
 assert.equal((await pool.query<{count:number}>('SELECT count(*)::int AS count FROM trace WHERE universe_id=$1',[graph.scope.universeId])).rows[0]!.count,0);
}

async function assertNoAskContext(pool:pg.Pool,graph:AskGraph):Promise<void> {
 for(const [table,column,value] of [
  ['reasoning_context','id',graph.contextId],
  ['reasoning_context_payload','context_id',graph.contextId],
  ['reasoning_context_dependency','context_id',graph.contextId],
  ['reasoning_context_job_session','job_id',graph.jobId],
  ['reasoning_context_job_ask','job_id',graph.jobId],
 ] as const) assert.equal(await count(pool,table,column,value),0,table);
}

async function waitForBlocked(pool:pg.Pool,blockerPid:number,message:string):Promise<void> {
 const deadline=Date.now()+2_000;
 while(Date.now()<deadline) {
  if((await pool.query(`SELECT 1 FROM pg_stat_activity
   WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`,[blockerPid])).rowCount) return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail(message);
}

async function ageWithdrawalForTest(pool:pg.Pool,jobId:string):Promise<void> {
 await pool.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_withdrawal_clock_guard');
 try { await pool.query("UPDATE reasoning_job SET withdrawn_at=clock_timestamp()-interval '169 hours' WHERE id=$1",[jobId]); }
 finally { await pool.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_withdrawal_clock_guard'); }
}

test('sealed Ask context retains the literal fact and cannot substitute its original session',async t=>{
 await withReasoningContextSchema('ask_context_original_session',async pool=>{
  const graph=await seedAskGraph(pool);
  const result=await compile(pool,graph);
  assert.equal(result.contextId,graph.contextId);
  const payload=JSON.parse((await pool.query<{canonical_payload:string}>('SELECT canonical_payload FROM reasoning_context_payload WHERE context_id=$1',[graph.contextId])).rows[0]!.canonical_payload);
  assert.equal(payload.kind,'direct_ask_evidence_v1');
  assert.equal(payload.fact.askId,graph.askId);
  assert.equal(payload.fact.askEventId,graph.askEventId);
  assert.equal(payload.fact.question,graph.question);
  assert.equal(payload.sessionId,graph.scope.sessionId);
  assert.deepEqual(payload.dependencies.map((dependency:{kind:string})=>dependency.kind).sort(),[
   'ask','ask_binding','asset','decision_candidate','exposure','exposure_event','runtime_policy','session',
  ]);
  await assertNoExecutionMutation(pool,graph);

  const other=await addSession(pool,graph.scope.universeId);
  await assert.rejects(inTransaction(pool,async client=>{
   const authenticated=await authenticateAndLock(client,other.token);
   return compileDirectAskContext(client,authenticated,{contextId:randomUUID(),jobId:graph.jobId,askId:graph.askId},resolverFor(graph));
  }),error=>error instanceof ReasoningDenied&&error.code==='context_inactive_session');

  const stepId=await attachPendingStep(pool,graph);
  await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[graph.scope.sessionId]);
  assert.deepEqual(await validate(pool,graph,stepId),{valid:false,reason:'inactive_session'});
 });
});

test('Ask context rejects foreign universes and stale epochs before publishing a binding',async t=>{
 await t.test('a different universe cannot compile the caller-supplied Job',async()=>{
  await withReasoningContextSchema('ask_context_foreign',async pool=>{
   const graph=await seedAskGraph(pool),foreign=await seedAskGraph(pool);
   await assert.rejects(inTransaction(pool,client=>compileDirectAskContext(client,foreign.scope,{
    contextId:randomUUID(),jobId:graph.jobId,askId:graph.askId,
   },resolverFor(graph))),error=>error instanceof ReasoningDenied&&error.code==='context_foreign');
   await assertNoAskContext(pool,graph);
  });
 });

 await t.test('an old authenticated scope cannot recreate an Ask context after its privacy epoch advances',async()=>{
  await withReasoningContextSchema('ask_context_old_epoch',async pool=>{
   const graph=await seedAskGraph(pool);
   await pool.query('UPDATE universe SET privacy_epoch=1 WHERE id=$1',[graph.scope.universeId]);
   await assert.rejects(inTransaction(pool,client=>compileDirectAskContext(client,graph.scope,{
    contextId:graph.contextId,jobId:graph.jobId,askId:graph.askId,
   },resolverFor(graph))),error=>error instanceof ReasoningDenied&&error.code==='context_obsolete_epoch');
   await assertNoAskContext(pool,graph);
  });
 });
});

test('a compiler blocked on its final source lock rechecks expiry and cannot outrun Clear History',async()=>{
 await withReasoningContextSchema('ask_context_expiry_clear_race',async pool=>{
  const graph=await seedAskGraph(pool),clearer=await addSession(pool,graph.scope.universeId);
  await pool.query("UPDATE device_session SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[graph.scope.sessionId]);
  const blocker=await pool.connect();
  let blockerOpen=true;
  try {
   await blocker.query('BEGIN');
   await blocker.query('SELECT id FROM asset WHERE id=$1 FOR UPDATE',[graph.assetId]);
   const pid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
   const pendingCompile=inTransaction(pool,client=>compileDirectAskContext(client,graph.scope,{
    contextId:graph.contextId,jobId:graph.jobId,askId:graph.askId,
   },resolverFor(graph)));
   void pendingCompile.catch(()=>{});
   await waitForBlocked(pool,pid,'Ask compiler never waited on the locked source asset');

   const pendingClear=inTransaction(pool,async client=>{
    const scope=await authenticateAndLock(client,clearer.token);
    return clearScrollHistory(client,scope,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});
   });
   void pendingClear.catch(()=>{});
   await new Promise(resolve=>setTimeout(resolve,600));
   await blocker.query('COMMIT');blockerOpen=false;
   await assert.rejects(pendingCompile,error=>error instanceof ReasoningDenied&&error.code==='context_inactive_session');
   const receipt=await pendingClear;
   assert.equal(receipt.privacyEpoch,1);
  } finally {
   if(blockerOpen) await blocker.query('ROLLBACK');
   blocker.release();
  }
  await assertNoAskContext(pool,graph);
  assert.equal(await count(pool,'explicit_ask','id',graph.askId),0);
  assert.equal(await count(pool,'ledger','id',graph.askEventId),0);
  assert.equal(await count(pool,'reasoning_job','id',graph.jobId),0);
  await assertNoExecutionMutation(pool,graph);
 });
});

test('a failed Ask compiler transaction rolls back immutable bindings while retaining its source fact',async()=>{
 await withReasoningContextSchema('ask_context_rollback',async pool=>{
  const graph=await seedAskGraph(pool);
  await pool.query(`CREATE FUNCTION reject_ask_context_payload() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN RAISE EXCEPTION 'forced Ask context rollback'; END $$`);
  await pool.query('CREATE TRIGGER reject_ask_context_payload BEFORE INSERT ON reasoning_context_payload FOR EACH ROW EXECUTE FUNCTION reject_ask_context_payload()');
  try { await assert.rejects(compile(pool,graph),/forced Ask context rollback/); }
  finally {
   await pool.query('DROP TRIGGER reject_ask_context_payload ON reasoning_context_payload');
   await pool.query('DROP FUNCTION reject_ask_context_payload()');
  }
  await assertNoAskContext(pool,graph);
  assert.equal(await count(pool,'explicit_ask','id',graph.askId),1);
  assert.equal(await count(pool,'ledger','id',graph.askEventId),1);
  await assertNoExecutionMutation(pool,graph);
 });
});

test('Clear History immediately erases a sealed Ask graph',async()=>{
 await withReasoningContextSchema('ask_context_clear',async pool=>{
  const graph=await seedAskGraph(pool);
  await compile(pool,graph);
  await inTransaction(pool,async client=>{
   const authenticated=await authenticateAndLock(client,graph.token);
   await clearScrollHistory(client,authenticated,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});
  });
  await assertNoAskContext(pool,graph);
  assert.equal(await count(pool,'explicit_ask','id',graph.askId),0);
  assert.equal(await count(pool,'ledger','id',graph.askEventId),0);
  assert.equal(await count(pool,'reasoning_job','id',graph.jobId),0);
  await assertNoExecutionMutation(pool,graph);
 });
});

test('seven-day retirement removes only private Ask execution context and leaves source replay recorded-only',async()=>{
 await withReasoningContextSchema('ask_context_retirement',async pool=>{
  const graph=await seedAskGraph(pool);
  await compile(pool,graph);
  await pool.query(`UPDATE reasoning_job SET status='running',lease_owner='ask-context-retirement',lease_fence=1,
   lease_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1`,[graph.jobId]);
  await createReasoningAdmission(pool,{
   resolvePolicy:async()=>{throw new Error('retirement fixture must not resolve a policy');},
   validateContext:async()=>false,
  }).withdrawJob({
   universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,
   owner:'ask-context-retirement',leaseFence:'1',reason:'cancelled',
  });
  await ageWithdrawalForTest(pool,graph.jobId);
  assert.equal((await createReasoningMaintenance(pool).runBatch({maxProbes:1})).retiredJobs,1);
  await assertNoAskContext(pool,graph);
  assert.equal(await count(pool,'reasoning_job','id',graph.jobId),0);
  assert.equal(await count(pool,'explicit_ask','id',graph.askId),1);
  assert.equal(await count(pool,'ledger','id',graph.askEventId),1);

  const replay=await inTransaction(pool,async client=>{
   await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
   await client.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
   return recordExplicitAsk(client,graph.scope,{
    clientAskId:graph.clientAskId,
    exposureId:graph.exposureId,expectedPrivacyEpoch:0,question:graph.question,
   });
  });
  assert.deepEqual(replay,{askId:graph.askId,eventId:graph.askEventId,status:'recorded_only'});
  assert.equal(await count(pool,'reasoning_job','id',graph.jobId),0);
  await assertNoAskContext(pool,graph);
  await assertNoExecutionMutation(pool,graph);
 });
});
