/** #62: separate scheduled process, disposable SQL and synthetic local evidence only. */
import assert from 'node:assert/strict';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import pg from 'pg';

const config=Object.fromEntries((await readFile('.env','utf8').catch(()=>''))
 .split('\n').filter(line=>/^[A-Z_][A-Z0-9_]*=/.test(line)).map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));
const base=new URL(process.env.DATABASE_URL??config.DATABASE_URL??'');
const name=`knowscroll_test_retirement_${randomUUID().replaceAll('-','')}`;
assert.match(name,/^knowscroll_test_retirement_[a-f0-9]{32}$/);
const adminUrl=new URL(base);adminUrl.pathname='/postgres';
const testUrl=new URL(base);testUrl.pathname=`/${name}`;
const admin=new pg.Client({connectionString:adminUrl.toString()});
let db:pg.Pool|undefined,child:ChildProcess|undefined,created=false,interrupted=false,unexpectedPoolError=false;
let childExit:{code:number|null;signal:string|null}|undefined,childFailure=false;
const batches:Array<Record<string,number>>=[];
let stoppedEvent=false,stderrObserved=false;
admin.on('error',()=>{unexpectedPoolError=true;});
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
 if(!child?.pid||childExit)return;
 try {process.kill(-child.pid,'SIGTERM');} catch {child.kill('SIGTERM');}
 for(let i=0;i<100&&!childExit;i++)await setTimeout(50);
 if(!childExit) {
  try {process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
  for(let i=0;i<40&&!childExit;i++)await setTimeout(50);
  throw Error('retirement_worker_failed_graceful_shutdown');
 }
}
let evidence:Record<string,unknown>|undefined,failure=false,cleanupOk=false;
try {
 await admin.connect();await admin.query(`CREATE DATABASE "${name}"`);created=true;
 process.env.DATABASE_URL=testUrl.toString();
 db=new pg.Pool({connectionString:testUrl.toString()});db.on('error',()=>{unexpectedPoolError=true;});
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
 let buffer='';
 const env:NodeJS.ProcessEnv={DATABASE_URL:testUrl.toString(),REASONING_MAINTENANCE_INTERVAL_MS:'100',REASONING_MAINTENANCE_MAX_PROBES:'8'};
 for(const key of ['PATH','HOME','TMPDIR','KS_DEV_ROOT','COREPACK_HOME'])if(process.env[key])env[key]=process.env[key];
 child=spawn('pnpm',['exec','tsx','apps/worker/src/reasoning/maintenance-main.ts'],{env,detached:true,stdio:['ignore','pipe','pipe']});
 child.once('error',()=>{childFailure=true;});child.once('exit',(code,signal)=>{childExit={code,signal};});
 child.stderr!.on('data',()=>{stderrObserved=true;});
 child.stdout!.on('data',chunk=>{
  buffer+=String(chunk);if(buffer.length>8192){buffer='';childFailure=true;return;}
  let end:number;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
   try{const x=JSON.parse(line);if(x.service!=='reasoning-maintenance')continue;
    if(x.event==='stopped')stoppedEvent=true;
    if(x.event==='batch'){const counters:Record<string,number>={};for(const k of ['probes','retiredJobs','purgedAccounting','skipped']){assert(Number.isInteger(x[k])&&x[k]>=0);counters[k]=x[k];}batches.push(counters);}
   }catch{childFailure=true;}
  }
 });
 await until(async()=>batches.length>=2&&(await db!.query('SELECT 1 FROM reasoning_job WHERE id=$1',[due.jobId])).rowCount===0&&
  (await db!.query('SELECT 1 FROM reasoning_accounting WHERE attempt_id=$1',[closed.attemptId])).rowCount===0,'scheduled_deletion');
 assert.deepEqual(await snapshot(),before);
 assert.equal((await db.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=$1',[due.contextId])).rowCount,0);
 assert.equal((await db.query('SELECT 1 FROM reasoning_job WHERE id=$1',[young.jobId])).rowCount,1);
 assert.equal((await db.query('SELECT 1 FROM reasoning_context_payload WHERE context_id=$1',[young.contextId])).rowCount,1);
 const reconciliation=createReasoningReconciliation(db);
 const receipt={version:1,receiptId:randomUUID(),attemptId:due.attemptId,requestId:due.requestId,dispatchId:due.dispatchId,
  routeId:due.policy.routeId,routeProfileVersion:due.policy.routeProfileVersion,evidenceKind:'original_transport',observedAt:new Date().toISOString(),
  remoteDisposition:'terminal',outcome:'success',httpStatus:200,usage:{inputTokens:1,outputTokens:1,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}};
 await reconciliation.recordAndSettleReceipt(receipt,'worker');assert.equal((await reconciliation.recordAndSettleReceipt(receipt,'worker')).replayed,true);
 assert.equal((await db.query('SELECT 1 FROM reasoning_job WHERE id=$1',[due.jobId])).rowCount,0);
 await stopChild();assert.deepEqual(childExit,{code:0,signal:null});assert(stoppedEvent);assert(!stderrObserved);
 assert(batches.some(b=>b.retiredJobs!>0));assert(batches.some(b=>b.purgedAccounting!>0));
 evidence={check:'scheduled-withdrawn-reasoning-retirement',result:'passed',observedAt:new Date().toISOString(),
  source:{revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='',
   files:await Promise.all(['scripts/run-isolated-retirement-journey.ts','packages/db/migrations/0008_reasoning_retirement.sql','packages/db/src/reasoning-maintenance.ts','packages/db/src/reasoning-admission.ts','packages/db/src/reasoning-context.ts','packages/db/src/reasoning-storage.ts','apps/worker/src/reasoning/maintenance-main.ts','tests/helpers/reasoning-context-fixture.ts'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},
  runtime:{separateWorker:true,scheduledBatches:batches.length,intervalMs:100,gracefulShutdown:true},
  assertions:{oldPrivateGraphRemoved:true,youngPrivateGraphPreserved:true,unknownAccountingAndReservationsUnchanged:true,closedAccountingPurgedAfter31Days:true,lateReceiptSettledWithoutPrivateResurrection:true,receiptReplayNoOp:true},providerCalls:0,
  limits:['synthetic contexts and accounting, no provider request','fixture-only timestamp aging in newly created disposable DB','not seven days of elapsed wall-clock observation','no completed/failed-job retirement or owner maintenance deployment']};
} catch {failure=true;}
finally {
 try {await stopChild();await db?.end();if(created)await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  cleanupOk=(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount===0;
 }catch{failure=true;}finally{await admin.end().catch(()=>{failure=true;});}
 process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);
}
if(!evidence||failure||!cleanupOk||interrupted||unexpectedPoolError){console.error(JSON.stringify({error:'retirement_journey_failed',cleanup:cleanupOk}));process.exitCode=1;}
else {
 const output=resolve(process.argv[2]??'artifacts/reasoning-retirement.json');await mkdir(resolve(output,'..'),{recursive:true});
 await writeFile(output,JSON.stringify({...evidence,cleanup:{databaseAbsent:true,workerExited:true}},null,2)+'\n');
 console.log(JSON.stringify({check:evidence.check,result:'passed',receiptPath:output}));
}
