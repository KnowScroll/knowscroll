/**
 * J002's product verifier. It intentionally talks to the API over HTTP and
 * only uses PostgreSQL to establish disposable operator/lifecycle conditions
 * and to inspect persisted outcomes. Never point it at a personal database.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { pool } from '../packages/db/src/index.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=process.env.JOURNEY_API_BASE ?? `http://127.0.0.1:${process.env.PORT ?? 4310}`;
const databaseUrl=process.env.JOURNEY_DATABASE_URL ?? process.env.DATABASE_URL;
if(!databaseUrl) throw new Error('JOURNEY_DATABASE_URL or DATABASE_URL is required');
const database=new URL(databaseUrl);
if(!['127.0.0.1','localhost','::1'].includes(database.hostname)) throw new Error('J002 only inspects a loopback disposable PostgreSQL database');

type Scope={sessionId:string;deviceId:string;universeId:string;privacyEpoch:number;expiresAt:string};
type Feed={decisionId:string;universeId:string;privacyEpoch:number;items:Array<{assetId:string}>};
type Exposure={exposureId:string;eventId:string};
type Keep={eventId:string;jobId:string;status:string};
type Snapshot={accountsRevision:number;traceCount:number;universeRevision:number};
type ProvisionedIdentity={token:string;scope:Scope};
type ProvisionIdentity=(options?:{universeId?:string;deviceId?:string;expiresInHours?:number})=>Promise<ProvisionedIdentity>;

// Keep this import opaque until #22 lands: this journey's branch must remain
// typecheckable while the identity helper is independently implemented.
async function identityProvisioner():Promise<ProvisionIdentity> {
 const module=await (new Function('path','return import(path)'))('../packages/db/src/identity.ts') as {provisionIdentity?:ProvisionIdentity};
 assert(typeof module.provisionIdentity==='function','packages/db/src/identity.ts exports provisionIdentity');
 return module.provisionIdentity;
}

function assert(condition:unknown,message:string):asserts condition { if(!condition) throw new Error(`J002 assertion failed: ${message}`); }
function tokenHeaders(token:string) { return {authorization:`Bearer ${token}`}; }
async function request<T>(token:string,path:string,init:RequestInit={},expected=200):Promise<T> {
 const response=await fetch(`${base}${path}`,{...init,headers:{...tokenHeaders(token),...init.headers},signal:AbortSignal.timeout(5_000)});
 if(response.status!==expected) throw new Error(`J002 ${init.method ?? 'GET'} ${path}: expected ${expected}, received ${response.status}: ${await response.text()}`);
 return response.status===204 ? undefined as T : await response.json() as T;
}
async function expectStatus(token:string,path:string,status:number,init:RequestInit={}) {
 const response=await fetch(`${base}${path}`,{...init,headers:{...tokenHeaders(token),...init.headers},signal:AbortSignal.timeout(5_000)});
 assert(response.status===status,`${init.method ?? 'GET'} ${path} expected ${status}, received ${response.status}: ${await response.text()}`);
}
async function snapshot(client:pg.Client,universeId:string):Promise<Snapshot> {
 const row=(await client.query(`SELECT a.revision AS "accountsRevision", u.revision AS "universeRevision",
  (SELECT count(*)::integer FROM trace t WHERE t.universe_id=u.id) AS "traceCount"
  FROM universe u JOIN accounts a ON a.universe_id=u.id WHERE u.id=$1`,[universeId])).rows[0];
 assert(row,'universe and Accounts row exist');return row;
}
function startWorker(environment:NodeJS.ProcessEnv) {
 const child=spawn('pnpm',['exec','tsx','apps/worker/src/main.ts'],{cwd:root,env:environment,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
 child.stdout?.on('data',chunk=>process.stdout.write(`[J002 worker] ${chunk}`));
 child.stderr?.on('data',chunk=>process.stderr.write(`[J002 worker] ${chunk}`));
 return child;
}
async function stop(child:ChildProcess|undefined) {
 if(!child || child.exitCode!==null || !child.pid) return;
 try { process.kill(-child.pid,'SIGTERM'); } catch { child.kill('SIGTERM'); }
 await Promise.race([new Promise<void>(done=>child.once('exit',()=>done())),setTimeout(5_000)]);
 if(child.exitCode===null) { try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
async function waitForJob(client:pg.Client,jobId:string) {
 for(let attempt=0;attempt<80;attempt++) {
  const job=(await client.query('SELECT status, discarded_at AS "discardedAt", completed_at AS "completedAt" FROM job WHERE id=$1',[jobId])).rows[0];
  if(job?.status==='discarded') return job;
  await setTimeout(100);
 }
 throw new Error(`J002 stale job ${jobId} never reached discarded`);
}

let worker:ChildProcess|undefined;
let client:pg.Client|undefined;
let interrupted=false;
const onSignal=()=>{interrupted=true;void stop(worker);};
process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
try {
 // The helper creates independent universes and returns raw tokens only to this
 // process. This verifier never writes them to a receipt or process output.
 const provisionIdentity=await identityProvisioner();
 const personA=await provisionIdentity();
 const personB=await provisionIdentity();
 const a=personA.scope as Scope,b=personB.scope as Scope;
 assert(a.universeId!==b.universeId,'operator provisioning creates independent universes');
 assert(personA.token!==personB.token,'operator provisioning creates independent opaque sessions');
 client=new pg.Client({connectionString:databaseUrl});await client.connect();

 const aSession=await request<Scope>(personA.token,'/v1/session');
 const bSession=await request<Scope>(personB.token,'/v1/session');
 assert(aSession.universeId===a.universeId && bSession.universeId===b.universeId,'HTTP session scope matches provisioned ownership');
 assert(aSession.privacyEpoch===0 && bSession.privacyEpoch===0,'new independent universes begin at privacy epoch zero');
 const aFeed=await request<Feed>(personA.token,'/v1/feed');
 const bFeed=await request<Feed>(personB.token,'/v1/feed');
 assert(aFeed.universeId===a.universeId && bFeed.universeId===b.universeId,'feed receipts are owned by their authenticated universe');
 assert(aFeed.decisionId!==bFeed.decisionId,'same editorial library yields private decisions');
 const item=aFeed.items[0];assert(item,'seeded disposable library contains a Scroll for J002');
 const exposureKey=randomUUID();
 const exposure=await request<Exposure>(personA.token,'/v1/exposures',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientExposureId:exposureKey,decisionId:aFeed.decisionId,assetId:item.assetId})},201);
 const duplicateExposure=await request<Exposure>(personA.token,'/v1/exposures',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientExposureId:exposureKey,decisionId:aFeed.decisionId,assetId:item.assetId})},201);
 assert(exposure.exposureId===duplicateExposure.exposureId && exposure.eventId===duplicateExposure.eventId,'exposure retry is idempotent');
 await expectStatus(personB.token,'/v1/exposures',422,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientExposureId:randomUUID(),decisionId:aFeed.decisionId,assetId:item.assetId})});
 const keepKey=randomUUID();
 const keep=await request<Keep>(personA.token,'/v1/interactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientEventId:keepKey,exposureId:exposure.exposureId,assetId:item.assetId,kind:'keep'})},202);
 const duplicateKeep=await request<Keep>(personA.token,'/v1/interactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientEventId:keepKey,exposureId:exposure.exposureId,assetId:item.assetId,kind:'keep'})},202);
 assert(keep.eventId===duplicateKeep.eventId && keep.jobId===duplicateKeep.jobId,'keep retry creates one event and one job');
 await expectStatus(personB.token,`/v1/events/${keep.eventId}`,404);
 const isolatedRows=(await client.query(`SELECT universe_id AS "universeId", count(*)::integer AS count FROM ledger
  WHERE id=ANY($1::uuid[]) GROUP BY universe_id`,[[exposure.eventId,keep.eventId]])).rows;
 assert(isolatedRows.length===1 && isolatedRows[0].universeId===a.universeId && isolatedRows[0].count===2,'exposure and keep ledger rows stay in owner A universe');
 const stamped=(await client.query(`SELECT
  (SELECT privacy_epoch FROM decision WHERE id=$1) AS "decisionEpoch",
  (SELECT privacy_epoch FROM exposure WHERE id=$2) AS "exposureEpoch",
  (SELECT privacy_epoch FROM ledger WHERE id=$3) AS "eventEpoch",
  (SELECT privacy_epoch FROM job WHERE id=$4) AS "jobEpoch",
  (SELECT status FROM job WHERE id=$4) AS "jobStatus"`,[aFeed.decisionId,exposure.exposureId,keep.eventId,keep.jobId])).rows[0];
 assert(stamped.decisionEpoch===a.privacyEpoch && stamped.exposureEpoch===a.privacyEpoch && stamped.eventEpoch===a.privacyEpoch && stamped.jobEpoch===a.privacyEpoch && stamped.jobStatus==='pending','admitted decision, exposure, Ledger event, and job carry the current epoch before worker projection');
 assert((await client.query('SELECT count(*)::integer AS count FROM trace WHERE universe_id=$1',[b.universeId])).rows[0].count===0,'owner B has no private trace before or after A admission');

 // Revocation and expiry are independently observable authentication failures.
 await request<void>(personB.token,'/v1/session/revoke',{method:'POST',headers:{'content-type':'application/json'},body:'{}'},204);
 await expectStatus(personB.token,'/v1/session',401);
 const expiring=await provisionIdentity({universeId:a.universeId,expiresInHours:1});
 await client.query("UPDATE device_session SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expiring.scope.sessionId]);
 await expectStatus(expiring.token,'/v1/session',401);

 // Do not launch the worker before this point: J002 must prove a pending job
 // from an obsolete epoch is discarded rather than projected.
 const beforeStale=await snapshot(client,a.universeId);
 await client.query('UPDATE universe SET privacy_epoch=privacy_epoch+1 WHERE id=$1',[a.universeId]);
 await expectStatus(personA.token,'/v1/session',401);
 const current=await provisionIdentity({universeId:a.universeId});
 const currentScope=await request<Scope>(current.token,'/v1/session');
 assert(currentScope.privacyEpoch===a.privacyEpoch+1,'a newly minted session is admitted at the advanced current epoch');
 await expectStatus(current.token,'/v1/exposures',409,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientExposureId:randomUUID(),decisionId:aFeed.decisionId,assetId:item.assetId})});
 await expectStatus(current.token,'/v1/interactions',409,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientEventId:randomUUID(),exposureId:exposure.exposureId,assetId:item.assetId,kind:'keep'})});
 const currentFeed=await request<Feed>(current.token,'/v1/feed');
 assert(currentFeed.privacyEpoch===currentScope.privacyEpoch && currentFeed.decisionId!==aFeed.decisionId,'current epoch has a new admissible feed decision');

 const workerEnvironment={...process.env,DATABASE_URL:databaseUrl,NODE_ENV:'test'};
 worker=startWorker(workerEnvironment);
 const discarded=await waitForJob(client,keep.jobId);
 assert(discarded.discardedAt && !discarded.completedAt,'old-epoch pending job is terminal discarded without completion');
 const afterStale=await snapshot(client,a.universeId);
 assert(afterStale.traceCount===beforeStale.traceCount,'discarded stale job does not add a Trace');
 assert(afterStale.accountsRevision===beforeStale.accountsRevision && afterStale.universeRevision===beforeStale.universeRevision,'discarded stale job does not mutate Accounts or universe revisions');
 assert(!interrupted,'journey was not interrupted');
 console.log(JSON.stringify({journey:'J002',result:'passed',runtime:{api:'separate real HTTP process',worker:'separate real process launched after stale job arrangement',database:'isolated disposable PostgreSQL'},checks:['two private sessions','cross-universe denial','idempotence','revocation','expiry','stale session','current epoch admission','discarded stale job without projection']}));
} finally {
 process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);
 await stop(worker);await client?.end();await pool.end();
}
