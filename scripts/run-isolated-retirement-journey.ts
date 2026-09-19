/** #62: separate scheduled process, disposable SQL and synthetic local evidence only. */
import assert from 'node:assert/strict';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import pg from 'pg';
import {trackPoolDisconnect} from './lib/pg-disconnect.ts';

const config=Object.fromEntries((await readFile('.env','utf8').catch(()=>''))
 .split('\n').filter(line=>/^[A-Z_][A-Z0-9_]*=/.test(line)).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
let base:URL;
try {base=new URL(process.env.DATABASE_URL??config.DATABASE_URL??'');}
catch {console.error(JSON.stringify({error:'retirement_fixture_invalid_database_config'}));process.exit(1);}
const name=`knowscroll_test_retirement_${randomUUID().replaceAll('-','')}`;
assert.match(name,/^knowscroll_test_retirement_[a-f0-9]{32}$/);
const adminUrl=new URL(base);adminUrl.pathname='/postgres';
const testUrl=new URL(base);testUrl.pathname=`/${name}`;
const admin=new pg.Client({connectionString:adminUrl.toString()});
let db:pg.Pool|undefined,child:ChildProcess|undefined,created=false,interrupted=false,unexpectedPoolError=false;
let childExit:{code:number|null;signal:string|null}|undefined,childClose:{code:number|null;signal:string|null}|undefined,childClosed=false,childFailure=false;
let poolDisconnect:ReturnType<typeof trackPoolDisconnect>|undefined;
const batches:Array<Record<string,number>>=[];
let stoppedEvent=false,stderrObserved=false,buffer='';
type FailureCode='worker_graceful_shutdown_timeout'|'worker_stdio_close_timeout'|'worker_exit_not_zero'|'worker_close_not_zero'|'worker_stop_ack_missing'|
 'worker_stderr_observed'|'worker_stdout_incomplete'|'retirement_counter_missing'|'purge_counter_missing'|'expiry_counter_missing'|
 'worker_spawn_error'|'worker_stdout_limit_exceeded'|'worker_stdout_invalid'|'runner_interrupted'|'pool_error'|
 'pool_disconnect_timeout'|'database_drop_failed'|'cleanup_incomplete'|'cleanup_failed'|'evidence_missing'|'unexpected_harness_failure';
class RetirementJourneyFailure extends Error {constructor(readonly code:FailureCode){super(code);}}
function requireJourney(condition:unknown,code:FailureCode):asserts condition {
 if(!condition)throw new RetirementJourneyFailure(code);
}
let failureCode:FailureCode|undefined;
type CleanupFailure='worker_stop_failed'|'pool_close_failed'|'pool_disconnect_failed'|'database_drop_graceful_failed'|'database_drop_force_failed'|'database_verify_failed'|'admin_close_failed';
const cleanupFailures:CleanupFailure[]=[];
type CleanupPhase='not_started'|'worker_stop'|'pool_close'|'pool_disconnect'|'database_drop'|'database_verify'|'admin_close'|'complete';
type PoolErrorEvidence={origin:'admin_client'|'db_pool';phase:string;sqlState:'57P01'|'unknown'};
let stage='connect',cleanupPhase:CleanupPhase='not_started',firstPoolError:PoolErrorEvidence|undefined;
let poolDisconnectVerified=false,databaseDropForced=false;
const safeSqlState=(error:unknown):'57P01'|'unknown'=>(error&&typeof error==='object'&&'code' in error&&(error as {code?:unknown}).code==='57P01')?'57P01':'unknown';
const recordPoolError=(origin:PoolErrorEvidence['origin'],error:unknown)=>{
 unexpectedPoolError=true;
 firstPoolError??={origin,phase:cleanupPhase==='not_started'?stage:cleanupPhase,sqlState:safeSqlState(error)};
};
admin.on('error',error=>{recordPoolError('admin_client',error);});
const onSignal=()=>{interrupted=true;};
process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
async function until(check:()=>Promise<boolean>,label:string,limit=200) {
 for(let i=0;i<limit;i++) {
  if(interrupted||unexpectedPoolError||childFailure) throw Error('retirement_fixture_interrupted_or_failed');
  if(await check())return;
  await setTimeout(50);
 }
 throw Error(`retirement_fixture_timeout_${label}`);
}
async function stopChild() {
 if(!child?.pid||childClosed)return;
 if(!childExit)try {process.kill(-child.pid,'SIGTERM');} catch {child.kill('SIGTERM');}
 for(let i=0;i<100&&!childExit;i++)await setTimeout(50);
 if(!childExit) {
  try {process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
  for(let i=0;i<40&&!childExit;i++)await setTimeout(50);
  for(let i=0;i<40&&!childClosed;i++)await setTimeout(50);
  throw new RetirementJourneyFailure('worker_graceful_shutdown_timeout');
 }
 for(let i=0;i<100&&!childClosed;i++)await setTimeout(50);
 if(!childClosed) {
  try {process.kill(-child.pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')child.kill('SIGKILL');}
  for(let i=0;i<40&&!childClosed;i++)await setTimeout(50);
  throw new RetirementJourneyFailure('worker_stdio_close_timeout');
 }
}
async function waitForPoolDisconnect() {
 if(!poolDisconnect){poolDisconnectVerified=true;return;}
 if(await poolDisconnect.wait(admin,name)){poolDisconnectVerified=true;return;}
 throw new RetirementJourneyFailure('pool_disconnect_timeout');
}
let evidence:Record<string,unknown>|undefined,failure=false,cleanupOk=false;
let failureSnapshot:Record<string,unknown>|undefined;
try {
 await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);created=true;
 process.env.DATABASE_URL=testUrl.toString();
 db=new pg.Pool({connectionString:testUrl.toString()});
 poolDisconnect=trackPoolDisconnect(db);
 db.on('error',error=>{recordPoolError('db_pool',error);});
 const {runMigrations}=await import('../packages/db/src/migrations.ts');
 await runMigrations(db,{directory:'packages/db/migrations'});
 const {seedDirectContextGraph,attachPendingStep,inTransaction}=await import('../tests/helpers/reasoning-context-fixture.ts');
 const {compileDirectContext,createDirectContextAuthority}=await import('../packages/db/src/reasoning-context.ts');
 const {createReasoningAdmission}=await import('../packages/db/src/reasoning-admission.ts');
 const {createReasoningReconciliation}=await import('../packages/db/src/reasoning-reconciliation.ts');
 async function seedWithdrawn(possibleSend:boolean) {
  const graph=await seedDirectContextGraph(db!);
  const authority=createDirectContextAuthority(async()=>graph.policy);
  await inTransaction(db!,c=>compileDirectContext(c,graph.scope,{jobId:graph.jobId,contextId:graph.contextId,keepEventIds:graph.keepEventIds},authority.resolvePolicy));
  const stepId=await attachPendingStep(db!,graph),admission=createReasoningAdmission(db!,authority);
  const owner='retirement-fixture',claimed=await admission.claimJob({owner,leaseMs:60_000});assert(claimed);
  assert.equal(claimed.jobId,graph.jobId);
  const requestId=randomUUID(),requestHash='a'.repeat(64),dispatchId=randomUUID();
  const scope={universeId:graph.scope.universeId,privacyEpoch:0,jobId:graph.jobId,stepId,owner,leaseFence:claimed.leaseFence};
  const reserved=await admission.reserveAttempt({...scope,contextId:graph.contextId,requestId,requestHash,
   inputTokensUpperBound:1,maxOutputTokens:1,costCeilingMicroUsd:null,deadline:new Date(Date.now()+30_000).toISOString(),permitTtlMs:30_000});
  if(possibleSend)await admission.authorizeDispatch({...scope,attemptId:reserved.attemptId,requestId,requestHash,inputTokensUpperBound:1,maxOutputTokens:1,dispatchId});
  await admission.withdrawJob({...scope,reason:'cancelled'});
  const timestamp=(await db!.query('SELECT withdrawn_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0].withdrawn_at;assert(timestamp);
  return {...graph,attemptId:reserved.attemptId,requestId,dispatchId};
 }
 async function seedFinished(outcome:'completed'|'failed') {
  const graph=await seedDirectContextGraph(db!);
  const authority=createDirectContextAuthority(async()=>graph.policy);
  await inTransaction(db!,c=>compileDirectContext(c,graph.scope,{jobId:graph.jobId,contextId:graph.contextId,keepEventIds:graph.keepEventIds},authority.resolvePolicy));
  const stepId=await attachPendingStep(db!,graph);
  const claimed=await createReasoningAdmission(db!,authority).claimJob({owner:'terminal-process-fixture',leaseMs:60_000});
  assert.equal(claimed?.jobId,graph.jobId);
  // Local fixture models a safe terminal consumer; no provider or result application.
  await inTransaction(db!,async c=>{
   await c.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
   await c.query('SELECT id FROM reasoning_job WHERE id=$1 FOR UPDATE',[graph.jobId]);
   await c.query('UPDATE reasoning_step SET status=$2 WHERE id=$1',[stepId,outcome==='completed'?'succeeded':'failed']);
   await c.query('UPDATE reasoning_job SET status=$2,lease_owner=NULL,lease_expires_at=NULL WHERE id=$1',[graph.jobId,outcome]);
  });
  assert((await db!.query('SELECT finished_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0].finished_at);
  return graph;
 }
 stage='seed';
 const completed=await seedFinished('completed'),failed=await seedFinished('failed'),youngFinished=await seedFinished('completed');
 await inTransaction(db,async c=>{
  await c.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_finished_clock_guard');
  await c.query("UPDATE reasoning_job SET finished_at=clock_timestamp()-interval '168 hours' WHERE id=ANY($1::uuid[])",[[completed.jobId,failed.jobId]]);
  await c.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_finished_clock_guard');
 });
 const sourceSnapshot=async()=>Promise.all(['ledger','decision','exposure','trace','explicit_ask'].map(async table=>
  (await db!.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE universe_id=ANY($1::uuid[]) ORDER BY to_jsonb(t)::text`,[[completed.scope.universeId,failed.scope.universeId]])).rows));
 const terminalSourcesBefore=await sourceSnapshot();
 const due=await seedWithdrawn(true),young=await seedWithdrawn(false),closed=await seedWithdrawn(false);
 // Fixture-only time travel in this newly created test DB; production has no clock override.
 await inTransaction(db,async c=>{
  await c.query('ALTER TABLE reasoning_job DISABLE TRIGGER reasoning_withdrawal_clock_guard');
  await c.query("UPDATE reasoning_job SET withdrawn_at=clock_timestamp()-interval '8 days' WHERE id=ANY($1::uuid[])",[[due.jobId,closed.jobId]]);
  await c.query('ALTER TABLE reasoning_job ENABLE TRIGGER reasoning_withdrawal_clock_guard');
  await c.query("UPDATE reasoning_accounting SET all_duties_closed_at=clock_timestamp()-interval '31 days' WHERE attempt_id=$1",[closed.attemptId]);
 });
 const retainedTables=['reasoning_accounting','reasoning_permit','reasoning_reservation'];
 const snapshot=async()=>Promise.all(retainedTables.map(async table=>(await db!.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE attempt_id=$1 ORDER BY to_jsonb(t)::text`,[due.attemptId])).rows));
 const before=await snapshot();
 // #75: a separate worker must close an actual expired idle Job, including
 // when its original session is revoked. No request or provider is created.
 const idle=await seedDirectContextGraph(db);
 await inTransaction(db,c=>compileDirectContext(c,idle.scope,{jobId:idle.jobId,contextId:idle.contextId,keepEventIds:idle.keepEventIds},async()=>idle.policy));
 const idleStep=await attachPendingStep(db,idle);
 await db.query("UPDATE reasoning_job SET deadline=clock_timestamp()-interval '1 second' WHERE id=$1",[idle.jobId]);
 await db.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[idle.scope.sessionId]);
 stage='worker_start';
 const env:NodeJS.ProcessEnv={DATABASE_URL:testUrl.toString(),REASONING_MAINTENANCE_INTERVAL_MS:'100',REASONING_MAINTENANCE_MAX_PROBES:'8'};
 for(const key of ['PATH','HOME','TMPDIR','KS_DEV_ROOT','COREPACK_HOME'])if(process.env[key])env[key]=process.env[key];
 child=spawn(process.execPath,['--import','tsx','apps/worker/src/reasoning/maintenance-main.ts'],{env,detached:true,stdio:['ignore','pipe','pipe']});
 child.once('error',()=>{childFailure=true;failureCode??='worker_spawn_error';});
 child.once('exit',(code,signal)=>{childExit={code,signal};});
 child.once('close',(code,signal)=>{childClose={code,signal};childClosed=true;});
 child.stderr!.on('data',()=>{stderrObserved=true;});
 child.stdout!.on('data',chunk=>{
  buffer+=String(chunk);if(buffer.length>8192){buffer='';childFailure=true;failureCode??='worker_stdout_limit_exceeded';return;}
  let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
   try{const x=JSON.parse(line);if(x.service!=='reasoning-maintenance')continue;
    if(x.event==='stopped')stoppedEvent=true;
    if(x.event==='batch'){const counters:Record<string,number>={};for(const k of ['probes','expiredJobs','retiredJobs','purgedAccounting','skipped']){assert(Number.isInteger(x[k])&&x[k]>=0);counters[k]=x[k];}batches.push(counters);}
   }catch{childFailure=true;failureCode??='worker_stdout_invalid';}
  }
 });
 stage='scheduled_deletion';
 await until(async()=>batches.length>=2&&(await db!.query('SELECT 1 FROM reasoning_job WHERE id=$1',[due.jobId])).rowCount===0&&
  (await db!.query('SELECT 1 FROM reasoning_accounting WHERE attempt_id=$1',[closed.attemptId])).rowCount===0&&
  (await db!.query('SELECT 1 FROM reasoning_job WHERE id=ANY($1::uuid[])',[[completed.jobId,failed.jobId]])).rowCount===0&&
  (await db!.query("SELECT 1 FROM reasoning_job WHERE id=$1 AND status='expired' AND withdrawn_at IS NOT NULL",[idle.jobId])).rowCount===1,'scheduled_deletion');
 stage='retention_assertions';
 assert.deepEqual(await sourceSnapshot(),terminalSourcesBefore);
 assert.equal((await db.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=ANY($1::uuid[])',[[completed.contextId,failed.contextId]])).rowCount,0);
 assert.equal((await db.query('SELECT 1 FROM reasoning_context_job_session WHERE job_id=ANY($1::uuid[])',[[completed.jobId,failed.jobId]])).rowCount,0);
 assert.equal((await db.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=$1',[youngFinished.contextId])).rowCount,1);
 assert.equal((await db.query('SELECT 1 FROM reasoning_job WHERE id=$1',[youngFinished.jobId])).rowCount,1);
 assert.deepEqual(await snapshot(),before);
 assert.equal((await db.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=$1',[due.contextId])).rowCount,0);
 assert.equal((await db.query('SELECT 1 FROM reasoning_job WHERE id=$1',[young.jobId])).rowCount,1);
 assert.equal((await db.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=$1',[young.contextId])).rowCount,1);
 assert.deepEqual((await db.query('SELECT status,lease_fence::text,lease_owner,lease_expires_at FROM reasoning_job WHERE id=$1',[idle.jobId])).rows[0],
  {status:'expired',lease_fence:'1',lease_owner:null,lease_expires_at:null});
 assert.equal((await db.query('SELECT status FROM reasoning_step WHERE id=$1',[idleStep])).rows[0].status,'cancelled');
 assert.equal((await db.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=$1',[idle.contextId])).rowCount,1);
 assert.equal((await db.query('SELECT 1 FROM reasoning_attempt WHERE job_id=$1',[idle.jobId])).rowCount,0);
 stage='late_receipt';
 const reconciliation=createReasoningReconciliation(db);
 const receipt={version:1,receiptId:randomUUID(),attemptId:due.attemptId,requestId:due.requestId,dispatchId:due.dispatchId,
  routeId:due.policy.routeId,routeProfileVersion:due.policy.routeProfileVersion,evidenceKind:'original_transport',observedAt:new Date().toISOString(),
  remoteDisposition:'terminal',outcome:'success',httpStatus:200,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}};
 await reconciliation.recordAndSettleReceipt(receipt,'worker');
 assert.deepEqual((await db.query('SELECT state,output_authority,liability_state,remote_state FROM reasoning_accounting WHERE attempt_id=$1',[due.attemptId])).rows[0],{state:'responded',output_authority:'withdrawn',liability_state:'settled',remote_state:'released'});
 assert.equal((await reconciliation.recordAndSettleReceipt(receipt,'worker')).replayed,true);
 assert.equal((await db.query('SELECT 1 FROM reasoning_job WHERE id=$1',[due.jobId])).rowCount,0);
 stage='shutdown';
 await stopChild();
 requireJourney(childExit?.code===0&&childExit.signal===null,'worker_exit_not_zero');
 requireJourney(childClose?.code===0&&childClose.signal===null,'worker_close_not_zero');
 requireJourney(stoppedEvent,'worker_stop_ack_missing');
 requireJourney(!stderrObserved,'worker_stderr_observed');
 requireJourney(buffer.length===0,'worker_stdout_incomplete');
 requireJourney(batches.some(b=>b.retiredJobs!>0),'retirement_counter_missing');
 requireJourney(batches.some(b=>b.purgedAccounting!>0),'purge_counter_missing');
 requireJourney(batches.some(b=>b.expiredJobs!>0),'expiry_counter_missing');
 stage='source_evidence';
 evidence={check:'scheduled-withdrawn-reasoning-retirement',result:'passed',observedAt:new Date().toISOString(),
  source:{revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='',
   files:await Promise.all(['scripts/run-isolated-retirement-journey.ts','scripts/lib/pg-disconnect.ts','packages/db/migrations/0008_reasoning_retirement.sql','packages/db/migrations/0011_idle_direct_withdrawal.sql','packages/db/migrations/0012_terminal_private_retirement.sql','packages/db/src/reasoning-maintenance.ts','packages/db/src/reasoning-idle-lifecycle.ts','packages/db/src/reasoning-idle-lifecycle-contract.ts','packages/db/src/reasoning-idle-fairness.ts','packages/db/src/reasoning-admission.ts','packages/db/src/reasoning-context.ts','packages/db/src/reasoning-storage.ts','apps/worker/src/reasoning/maintenance-main.ts','tests/helpers/reasoning-context-fixture.ts'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},
  runtime:{separateWorker:true,scheduledBatches:batches.length,intervalMs:100,idleGracefulShutdown:true,workerStdioClosed:true,finalStoppedAcknowledgement:true},
  assertions:{completedPrivateGraphRetiredAt168Hours:true,failedPrivateGraphRetiredAt168Hours:true,youngFinishedGraphPreserved:true,terminalSourceHistoryUnchanged:true,idleDirectJobExpiredWithRevokedOriginalSession:true,idleExpiryFencedAndClocked:true,idleContextRetainedUntilRetirement:true,expiryAggregateObserved:true,oldPrivateGraphRemoved:true,youngPrivateGraphPreserved:true,unknownAccountingAndReservationsUnchangedDuringRetirement:true,closedAccountingPurgedAfter31Days:true,lateReceiptSettledWithoutPrivateResurrection:true,receiptReplayNoOp:true},providerCalls:0,
  limits:['synthetic contexts and accounting, no provider request','fixture-only timestamp aging in newly created disposable DB','not seven days of elapsed wall-clock observation','idle SIGTERM shutdown; no in-flight signal barrier in this receipt','safe terminal transitions are local SQL fixtures, not product completion/application or owner deployment']};
} catch(error) {
 failure=true;failureCode??=error instanceof RetirementJourneyFailure?error.code:'unexpected_harness_failure';
 failureSnapshot={childExit,childClose,childClosed,stoppedEvent,stderrObserved,interrupted,unexpectedPoolError,childFailure,batches:batches.length,
  retirementCounterObserved:batches.some(b=>b.retiredJobs!>0),purgeCounterObserved:batches.some(b=>b.purgedAccounting!>0),
  stdoutPending:buffer.length>0};
}
finally {
 const cleanupAttempt=async(code:CleanupFailure,fn:()=>Promise<void>)=>{try{await fn();}catch(error){cleanupFailures.push(code);failure=true;failureCode??=error instanceof RetirementJourneyFailure?error.code:'cleanup_failed';}};
 cleanupPhase='worker_stop';
 await cleanupAttempt('worker_stop_failed',stopChild);
 cleanupPhase='pool_close';
 await cleanupAttempt('pool_close_failed',async()=>{await db?.end();});
 cleanupPhase='pool_disconnect';
 await cleanupAttempt('pool_disconnect_failed',waitForPoolDisconnect);
 cleanupPhase='database_drop';
 if(created) {
  try {await admin.query(`DROP DATABASE IF EXISTS "${name}"`);}
  catch {
   cleanupFailures.push('database_drop_graceful_failed');failure=true;failureCode??='database_drop_failed';databaseDropForced=true;
   await cleanupAttempt('database_drop_force_failed',async()=>{await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);});
  }
 }
 cleanupPhase='database_verify';
 await cleanupAttempt('database_verify_failed',async()=>{cleanupOk=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount===0;if(!cleanupOk)throw Error('database_present');});
 cleanupPhase='admin_close';
 await cleanupAttempt('admin_close_failed',async()=>{await admin.end();});
 cleanupPhase='complete';
 process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);
}
if(interrupted)failureCode??='runner_interrupted';
if(unexpectedPoolError)failureCode??='pool_error';
if(!cleanupOk)failureCode??='cleanup_incomplete';
if(!evidence)failureCode??='evidence_missing';
if(!evidence||failure||!cleanupOk||interrupted||unexpectedPoolError||childFailure){console.error(JSON.stringify({error:'retirement_journey_failed',failureCode,stage,cleanupPhase,cleanup:cleanupOk,cleanupFailures,firstPoolError,failureSnapshot,childExit,childClose,childClosed,stoppedEvent,stderrObserved,interrupted,unexpectedPoolError,childFailure,poolDisconnectVerified,databaseDropForced,poolClientsPending:poolDisconnect?.pendingCount()??0,batches:batches.length}));process.exitCode=1;}
else {
 const output=resolve(process.argv[2]??'artifacts/reasoning-retirement.json');await mkdir(resolve(output,'..'),{recursive:true});
 await writeFile(output,JSON.stringify({...evidence,cleanup:{databaseAbsent:true,workerExited:true,poolDisconnectVerified,databaseDropForced}},null,2)+'\n',{flag:'wx'});
 console.log(JSON.stringify({check:evidence.check,result:'passed',receiptPath:output}));
}
