/** J002 verifier: real HTTP admission plus bounded inspection of a disposable database. */
import {spawn,type ChildProcess,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {relative,resolve,dirname} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {pool} from '../packages/db/src/index.ts';
import {provisionIdentity,type AuthScope} from '../packages/db/src/identity.ts';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const helperUrl=process.env.DATABASE_URL,journeyUrl=process.env.JOURNEY_DATABASE_URL;
if(!helperUrl||!journeyUrl||helperUrl!==journeyUrl) throw new Error('J002 requires identical DATABASE_URL and JOURNEY_DATABASE_URL');
const database=new URL(journeyUrl);
if(!['127.0.0.1','localhost','::1'].includes(database.hostname)||!/^\/knowscroll_j002_[0-9a-f]+$/.test(database.pathname)) throw new Error('J002 only permits a loopback knowscroll_j002_<hex> disposable database');
const base=process.env.JOURNEY_API_BASE;
if(!base||new URL(base).hostname!=='127.0.0.1') throw new Error('J002 requires a loopback JOURNEY_API_BASE');
const receiptInput=process.env.JOURNEY_RECEIPT_PATH;if(!receiptInput) throw new Error('J002 requires JOURNEY_RECEIPT_PATH under artifacts');
const receiptPath=resolve(root,receiptInput);if(relative(resolve(root,'artifacts'),receiptPath).startsWith('..')) throw new Error('J002 receipt path must be under artifacts');

type Feed={decisionId:string;universeId:string;privacyEpoch:number;items:Array<{assetId:string}>};
type Exposure={exposureId:string;eventId:string};type Keep={eventId:string;jobId:string;status:string};
type Event={eventId:string;jobId:string;jobStatus:string;projected:boolean};type Universe={universeId:string;revision:number;traces:Array<{eventId:string;assetId:string}>};
type Snapshot={accountsRevision:number;traceCount:number;universeRevision:number};type Managed={child:ChildProcess;startupError?:Error};
function assert(value:unknown,message:string):asserts value {if(!value) throw new Error(`J002 assertion failed: ${message}`);}
function git(args:string[]){return execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();}
async function request<T>(token:string,path:string,init:RequestInit={},expected=200):Promise<T>{const response=await fetch(`${base}${path}`,{...init,headers:{authorization:`Bearer ${token}`,...init.headers},signal:AbortSignal.timeout(5000)});if(response.status!==expected)throw new Error(`J002 ${init.method??'GET'} ${path}: expected ${expected}, received ${response.status}: ${await response.text()}`);return response.status===204?undefined as T:await response.json() as T;}
async function expectStatus(token:string,path:string,status:number,init:RequestInit={}){const response=await fetch(`${base}${path}`,{...init,headers:{authorization:`Bearer ${token}`,...init.headers},signal:AbortSignal.timeout(5000)});assert(response.status===status,`${init.method??'GET'} ${path} expected ${status}, received ${response.status}: ${await response.text()}`);}
async function snapshot(client:pg.Client,universeId:string):Promise<Snapshot>{const row=(await client.query(`SELECT a.revision AS "accountsRevision",u.revision AS "universeRevision",(SELECT count(*)::integer FROM trace t WHERE t.universe_id=u.id) AS "traceCount" FROM universe u JOIN accounts a ON a.universe_id=u.id WHERE u.id=$1`,[universeId])).rows[0];assert(row,'universe and Accounts row exist');return row;}
function startWorker(env:NodeJS.ProcessEnv):Managed{const child=spawn('pnpm',['exec','tsx','apps/worker/src/main.ts'],{cwd:root,env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});const managed:Managed={child};child.once('error',error=>managed.startupError=error);child.stdout?.on('data',chunk=>process.stdout.write(`[J002 worker] ${chunk}`));child.stderr?.on('data',chunk=>process.stderr.write(`[J002 worker] ${chunk}`));return managed;}
async function stop(managed:Managed|undefined){const child=managed?.child;if(!child||child.exitCode!==null||!child.pid)return;try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');}await Promise.race([new Promise<void>(done=>child.once('exit',()=>done())),setTimeout(5000)]);if(child.exitCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}}
async function waitForJob(client:pg.Client,worker:Managed,id:string,status:'completed'|'discarded'){for(let i=0;i<80;i++){if(worker.startupError)throw worker.startupError;if(worker.child.exitCode!==null)throw new Error(`J002 worker exited before ${id} reached ${status}: ${worker.child.exitCode}`);const job=(await client.query('SELECT status,discarded_at AS "discardedAt",completed_at AS "completedAt" FROM job WHERE id=$1',[id])).rows[0];if(job?.status===status)return job;await setTimeout(100);}throw new Error(`J002 job ${id} never reached ${status}`);}

let worker:Managed|undefined,client:pg.Client|undefined,interrupted=false,primaryError:unknown;
const onSignal=()=>{interrupted=true;void stop(worker);};process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
try{
 const personA=await provisionIdentity(),personB=await provisionIdentity(),a=personA.scope,b=personB.scope;
 assert(a.universeId!==b.universeId&&personA.token!==personB.token,'operator provisioning creates independent opaque sessions');
 client=new pg.Client({connectionString:journeyUrl});await client.connect();
 const aSession=await request<AuthScope>(personA.token,'/v1/session'),bSession=await request<AuthScope>(personB.token,'/v1/session');
 assert(aSession.universeId===a.universeId&&bSession.universeId===b.universeId&&aSession.privacyEpoch===0&&bSession.privacyEpoch===0,'HTTP sessions have independent epoch-zero scopes');
 const aFeed=await request<Feed>(personA.token,'/v1/feed'),bFeed=await request<Feed>(personB.token,'/v1/feed');
 assert(aFeed.universeId===a.universeId&&bFeed.universeId===b.universeId&&aFeed.decisionId!==bFeed.decisionId,'feed decisions are private');
 const aItem=aFeed.items[0],bItem=bFeed.items[0];assert(aItem&&bItem,'seeded disposable library contains Scrolls');
 const aExposureKey=randomUUID();
 const aExposure=await request<Exposure>(personA.token,'/v1/exposures',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientExposureId:aExposureKey,decisionId:aFeed.decisionId,assetId:aItem.assetId})},201);
 const duplicateExposure=await request<Exposure>(personA.token,'/v1/exposures',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientExposureId:aExposureKey,decisionId:aFeed.decisionId,assetId:aItem.assetId})},201);assert(aExposure.exposureId===duplicateExposure.exposureId&&aExposure.eventId===duplicateExposure.eventId,'exposure retry is idempotent');
 const aKeepKey=randomUUID();
 const aKeep=await request<Keep>(personA.token,'/v1/interactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientEventId:aKeepKey,exposureId:aExposure.exposureId,assetId:aItem.assetId,kind:'keep'})},202);
 const duplicateKeep=await request<Keep>(personA.token,'/v1/interactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientEventId:aKeepKey,exposureId:aExposure.exposureId,assetId:aItem.assetId,kind:'keep'})},202);assert(aKeep.eventId===duplicateKeep.eventId&&aKeep.jobId===duplicateKeep.jobId,'keep retry is idempotent');
 await expectStatus(personB.token,'/v1/exposures',422,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientExposureId:randomUUID(),decisionId:aFeed.decisionId,assetId:aItem.assetId})});
 await expectStatus(personB.token,'/v1/interactions',422,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientEventId:randomUUID(),exposureId:aExposure.exposureId,assetId:aItem.assetId,kind:'keep'})});await expectStatus(personB.token,`/v1/events/${aKeep.eventId}`,404);
 const bExposure=await request<Exposure>(personB.token,'/v1/exposures',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientExposureId:randomUUID(),decisionId:bFeed.decisionId,assetId:bItem.assetId})},201);
 const bKeep=await request<Keep>(personB.token,'/v1/interactions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientEventId:randomUUID(),exposureId:bExposure.exposureId,assetId:bItem.assetId,kind:'keep'})},202);
 const stamped=(await client.query(`SELECT (SELECT privacy_epoch FROM decision WHERE id=$1) AS "decisionEpoch",(SELECT privacy_epoch FROM ledger WHERE id=$2) AS "exposureEpoch",(SELECT privacy_epoch FROM ledger WHERE id=$3) AS "eventEpoch",(SELECT privacy_epoch FROM job WHERE id=$4) AS "jobEpoch",(SELECT status FROM job WHERE id=$4) AS "jobStatus"`,[aFeed.decisionId,aExposure.eventId,aKeep.eventId,aKeep.jobId])).rows[0];
 assert(stamped.decisionEpoch===a.privacyEpoch&&stamped.exposureEpoch===a.privacyEpoch&&stamped.eventEpoch===a.privacyEpoch&&stamped.jobEpoch===a.privacyEpoch&&stamped.jobStatus==='pending','A admission stamps current epoch through pending job');
 const expiring=await provisionIdentity({universeId:a.universeId,expiresInHours:1});await client.query("UPDATE device_session SET created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[expiring.scope.sessionId]);await expectStatus(expiring.token,'/v1/session',401);
 const beforeA=await snapshot(client,a.universeId),beforeB=await snapshot(client,b.universeId);await client.query('UPDATE universe SET privacy_epoch=privacy_epoch+1 WHERE id=$1',[a.universeId]);await expectStatus(personA.token,'/v1/session',401);
 const currentA=await provisionIdentity({universeId:a.universeId}),currentASession=await request<AuthScope>(currentA.token,'/v1/session');assert(currentASession.privacyEpoch===a.privacyEpoch+1,'new A session is current after epoch advance');
 await expectStatus(currentA.token,'/v1/exposures',409,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientExposureId:randomUUID(),decisionId:aFeed.decisionId,assetId:aItem.assetId})});await expectStatus(currentA.token,'/v1/interactions',409,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clientEventId:randomUUID(),exposureId:aExposure.exposureId,assetId:aItem.assetId,kind:'keep'})});
 const currentAFeed=await request<Feed>(currentA.token,'/v1/feed');assert(currentAFeed.privacyEpoch===currentASession.privacyEpoch&&currentAFeed.decisionId!==aFeed.decisionId,'current epoch receives a new decision');
 worker=startWorker({...process.env,DATABASE_URL:journeyUrl,NODE_ENV:'test'});const [discarded,completed]=await Promise.all([waitForJob(client,worker,aKeep.jobId,'discarded'),waitForJob(client,worker,bKeep.jobId,'completed')]);assert(discarded.discardedAt&&!discarded.completedAt,'old A job is discarded');assert(completed.completedAt&&!completed.discardedAt,'current B job completes');
 const afterA=await snapshot(client,a.universeId),afterB=await snapshot(client,b.universeId);assert(afterA.traceCount===beforeA.traceCount&&afterA.accountsRevision===beforeA.accountsRevision&&afterA.universeRevision===beforeA.universeRevision,'discarded A job does not mutate projections');assert(afterB.traceCount===beforeB.traceCount+1&&afterB.accountsRevision===beforeB.accountsRevision+1&&afterB.universeRevision===beforeB.universeRevision+1,'B job projects exactly once');
 const bEvent=await request<Event>(personB.token,`/v1/events/${bKeep.eventId}`),bUniverse=await request<Universe>(personB.token,'/v1/universe'),bNextFeed=await request<Feed>(personB.token,'/v1/feed');assert(bEvent.projected&&bEvent.jobStatus==='completed'&&bUniverse.traces.some(trace=>trace.eventId===bKeep.eventId),'B sees its private projection');assert(!bNextFeed.items.some(item=>item.assetId===bItem.assetId),'B next feed excludes kept asset');await expectStatus(currentA.token,`/v1/events/${bKeep.eventId}`,404);const aUniverse=await request<Universe>(currentA.token,'/v1/universe');assert(!aUniverse.traces.some(trace=>trace.eventId===bKeep.eventId),'A never receives B trace');
 await request<void>(personB.token,'/v1/session/revoke',{method:'POST',headers:{'content-type':'application/json'},body:'{}'},204);await expectStatus(personB.token,'/v1/session',401);assert(!interrupted,'journey was not interrupted');
 const receipt={observedAt:new Date().toISOString(),git:{head:git(['rev-parse','HEAD']),dirty:git(['status','--porcelain'])!==''},journey:'J002',result:'passed',runtime:{apiBase:base,database:{host:database.hostname,port:database.port||'5432',name:database.pathname.slice(1)},worker:'separate process launched after stale job arrangement'},causal:{oldEpochA:{decisionId:aFeed.decisionId,exposureId:aExposure.exposureId,exposureEventId:aExposure.eventId,eventId:aKeep.eventId,jobId:aKeep.jobId},currentB:{decisionId:bFeed.decisionId,exposureId:bExposure.exposureId,exposureEventId:bExposure.eventId,eventId:bKeep.eventId,jobId:bKeep.jobId}}};await writeFile(receiptPath,`${JSON.stringify(receipt,null,2)}\n`);console.log(JSON.stringify({journey:'J002',result:'passed',receiptPath:relative(root,receiptPath)}));
}catch(error){primaryError=error;throw error;}finally{process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);try{await stop(worker);await client?.end();await pool.end();}catch(error){if(primaryError)console.error('J002 cleanup failed after primary error',error);else throw error;}}
