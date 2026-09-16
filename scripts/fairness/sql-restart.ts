/** Real PostgreSQL process restart, exclusively inside a new disposable cluster.
 * All jobs and receipts are synthetic; no transport or owner database is used.
 */
import assert from 'node:assert/strict';
import {execFile as execFileCallback,execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readdir,readFile,copyFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import pg from 'pg';
import {runMigrations} from '../../packages/db/src/migrations.ts';
import {createReasoningAdmission} from '../../packages/db/src/reasoning-admission.ts';
import {createReasoningReconciliation} from '../../packages/db/src/reasoning-reconciliation.ts';
import {createReasoningFairness} from '../../packages/db/src/reasoning-fairness.ts';
import {authority,seed} from '../fixtures/reasoning-support.ts';

const execFile=promisify(execFileCallback);
const scratch=resolve(process.env.KS_DEV_ROOT??'/tmp/knowscroll-dev','tmp');
await mkdir(scratch,{recursive:true});
const dir=await mkdtemp(join(scratch,'fairness-pg-restart-'));
const data=join(dir,'data'),log=join(dir,'postgres.log');
const bindir=execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
const server=createServer();
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();
assert(address&&typeof address!=='string');
const port=address.port;
await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
const databaseUrl=`postgresql://knowscroll_test@127.0.0.1:${port}/postgres`;
let running=false,pool:pg.Pool|undefined;
const run=async(name:string,args:string[])=>{
  try {await execFile(join(bindir,name),args,{timeout:30_000,maxBuffer:1024*1024});}
  catch {throw Error(`disposable_postgres_${name}_failed`);}
};
const start=async()=>{
  running=true;
  await run('pg_ctl',['-D',data,'-l',log,'-w','-t','20','-o',`-h 127.0.0.1 -p ${port} -k ''`,'start']);
  pool=new pg.Pool({connectionString:databaseUrl});
};
const stop=async()=>{
  if(pool){await pool.end();pool=undefined;}
  let hasPid=true;try{await readFile(join(data,'postmaster.pid'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')hasPid=false;else throw error;}
  if(hasPid)await run('pg_ctl',['-D',data,'-w','-t','20','-m','fast','stop']);
  running=false;
};
const tables=['reasoning_fairness_scheduler','reasoning_fairness_class','reasoning_fairness_universe','reasoning_fairness_ready','reasoning_fairness_attempt','reasoning_fairness_delta','reasoning_accounting','reasoning_permit','reasoning_reservation','reasoning_bucket'];
const snapshot=async()=>Object.fromEntries(await Promise.all(tables.map(async name=>[name,(await pool!.query(`SELECT to_jsonb(t) AS row FROM ${name} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.row)])));
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let receipt:Record<string,unknown>|undefined;
try {
  await run('initdb',['-D',data,'-U','knowscroll_test','-A','trust','--no-locale','-E','UTF8']);
  await start();
  const oldMigrations=join(dir,'migrations');await mkdir(oldMigrations);
  for(const name of (await readdir('packages/db/migrations')).filter(name=>/^000[1-5]_.*\.sql$/.test(name))) await copyFile(join('packages/db/migrations',name),join(oldMigrations,name));
  await runMigrations(pool!,{directory:oldMigrations});
  const preservedUniverse=randomUUID();
  await pool!.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[preservedUniverse]);
  const beforeMigrations=(await pool!.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  const upgrade=await runMigrations(pool!,{directory:'packages/db/migrations'});
  assert.deepEqual(upgrade.applied,['0006_reasoning_fairness.sql']);
  assert.deepEqual((await pool!.query("SELECT name,checksum FROM schema_migrations WHERE name<'0006' ORDER BY name")).rows,beforeMigrations);
  assert.equal((await pool!.query('SELECT 1 FROM universe WHERE id=$1 AND privacy_epoch=0',[preservedUniverse])).rowCount,1);
  await pool!.query('CREATE TABLE j004_policy(job_id uuid PRIMARY KEY REFERENCES reasoning_job(id) ON DELETE CASCADE,policy jsonb NOT NULL)');
  const graph=await seed(pool!,{deadlineMs:300_000});
  const policy={version:'j004-v1',quantum:100,maxCharge:100,scale:100,basis:{input_tokens:1000,output_tokens:1000,total_tokens:1000,requests:100},maxProbes:32,maxAdmissions:16};
  const scheduler=createReasoningFairness(pool!,authority(pool!));
  await scheduler.installPolicy(policy);
  const request={...graph,policyVersion:policy.version,class:'interactive' as const,requestId:randomUUID(),requestHash:'b'.repeat(64),inputTokensUpperBound:100,maxOutputTokens:100,costCeilingMicroUsd:null,deadline:new Date(Date.now()+240_000).toISOString(),permitTtlMs:60_000};
  await scheduler.enqueue(request);
  const admitted=await scheduler.schedule({policyVersion:policy.version,owner:'restart-fixture',leaseMs:60_000});
  assert.equal(admitted.kind,'admitted');if(admitted.kind!=='admitted') throw Error('fixture_not_admitted');
  const admission=createReasoningAdmission(pool!,authority(pool!));
  const dispatchId=randomUUID();
  await admission.authorizeDispatch({...request,owner:'restart-fixture',leaseFence:admitted.claim.leaseFence,attemptId:admitted.reserved.attemptId,dispatchId});
  await admission.markAttemptUnknown({...request,owner:'restart-fixture',leaseFence:admitted.claim.leaseFence,attemptId:admitted.reserved.attemptId,reason:'transport_loss'});
  const second=await seed(pool!,{universeId:graph.universeId,deadlineMs:300_000});
  await scheduler.enqueue({...request,...second,requestId:randomUUID()});
  const before=await snapshot();
  const oldPid=Number((await readFile(join(data,'postmaster.pid'),'utf8')).split('\n')[0]);
  await stop();await start();
  const newPid=Number((await readFile(join(data,'postmaster.pid'),'utf8')).split('\n')[0]);
  assert.notEqual(newPid,oldPid);
  assert.deepEqual(await snapshot(),before);
  const restartedScheduler=createReasoningFairness(pool!,authority(pool!));
  const next=await restartedScheduler.schedule({policyVersion:policy.version,owner:'restarted-fixture',leaseMs:60_000});
  assert.equal(next.kind,'admitted');
  if(next.kind!=='admitted') throw Error('fixture_next_not_admitted');
  const correction={version:1,receiptId:randomUUID(),attemptId:admitted.reserved.attemptId,requestId:request.requestId,dispatchId,routeId:graph.policy.routeId,routeProfileVersion:graph.policy.routeProfileVersion,evidenceKind:'original_transport',observedAt:new Date().toISOString(),remoteDisposition:'terminal',outcome:'success',httpStatus:200,usage:{inputTokens:10,outputTokens:10,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}};
  const reconciliation=createReasoningReconciliation(pool!);
  await reconciliation.recordAndSettleReceipt(correction,'worker');
  const after=await snapshot();
  const replay=await reconciliation.recordAndSettleReceipt(correction,'worker');
  assert.equal(replay.replayed,true);assert.deepEqual(await snapshot(),after);
  receipt={check:'durable-sql-fairness-postgres-restart',result:'passed',observedAt:new Date().toISOString(),platform:process.platform,
    source:{revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='',
      files:await Promise.all(['scripts/fairness/sql-restart.ts','packages/db/src/reasoning-fairness.ts','packages/db/src/reasoning-fairness-accounting.ts','packages/db/src/reasoning-admission.ts','packages/db/src/reasoning-reconciliation.ts','packages/db/src/reasoning-storage.ts','packages/db/src/reasoning-runtime-policy.ts','packages/db/src/reasoning-fairness-policy.ts','scripts/fixtures/reasoning-support.ts','packages/db/migrations/0006_reasoning_fairness.sql'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},
    isolation:{kind:'new-disposable-postgresql-cluster',port,oldPid,newPid},upgrade,preservedMigrations:beforeMigrations,
    restart:{sameSnapshot:true,snapshotSha256:digest(before),unknownAttemptId:admitted.reserved.attemptId,continuedJobId:next.claim.jobId,receiptReplayNoOp:true},
    snapshots:{beforeRestart:before,afterSettlement:after},limits:['synthetic trusted fixture authority','no provider request or output application','PostgreSQL fast stop and process restart; not power-loss or storage-corruption proof','no concurrent scheduler clients, history clear, or rate-window rollover in this receipt']};
} finally {
  if(running) await stop();
  await rm(dir,{recursive:true,force:true});
}
assert(receipt);
const output=resolve(process.argv[2]??'artifacts/sql-fairness-restart.json');await mkdir(resolve(output,'..'),{recursive:true});
await writeFile(output,JSON.stringify({...receipt,cleanup:{clusterStopped:true,directoryRemoved:true}},null,2)+'\n');
console.log(JSON.stringify({check:receipt.check,result:'passed',receiptPath:output}));
