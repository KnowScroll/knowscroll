/** #64: literal Ask durability over a separate HTTP API and disposable PostgreSQL. */
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {runMigrations} from '../packages/db/src/migrations.ts';

const name=`knowscroll_test_ask_${randomUUID().replaceAll('-','')}`;
const token=randomBytes(32).toString('hex');
let admin:pg.Client|undefined,db:pg.Client|undefined,api:ChildProcess|undefined;
let created=false,interrupted=false,stage='configuration',stderrSeen=false;
const children=new Set<ChildProcess>();
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const check=()=>{if(interrupted)throw new Error('interrupted');};
const requestStop=()=>{interrupted=true;};
process.on('SIGTERM',requestStop);process.on('SIGINT',requestStop);
function launch(args:string[],env:NodeJS.ProcessEnv):ChildProcess {
 const child=spawn(process.execPath,['--import','tsx',...args],{env,detached:true,stdio:['ignore','ignore','pipe']});
 children.add(child);child.on('error',()=>{stderrSeen=true;});
 child.stderr?.on('data',()=>{stderrSeen=true;});return child;
}
async function stop(child:ChildProcess|undefined):Promise<void> {
 if(!child?.pid)return;
 if(child.exitCode===null&&child.signalCode===null) {
  try{process.kill(-child.pid,'SIGTERM');}catch{}
  for(let i=0;i<100&&child.exitCode===null&&child.signalCode===null;i++)await pause(50);
  if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{};await pause(100);}
 }
 assert(child.exitCode!==null||child.signalCode!==null,'child did not exit');children.delete(child);
}
async function unusedPort():Promise<number> {
 return new Promise((resolve,reject)=>{const s=createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{
  const address=s.address();assert(address&&typeof address==='object');s.close(error=>error?reject(error):resolve(address.port));
 });});
}
let receipt:Record<string,unknown>|undefined,failed=false;
try {
 let config:Record<string,string>={};
 try{config=Object.fromEntries((await readFile('.env','utf8')).split('\n').flatMap(line=>{const m=/^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);return m?[[m[1]!,m[2]!]]:[];}));}catch{}
 const base=process.env.DATABASE_URL??config.DATABASE_URL;assert(base);const u=new URL(base);
 assert(['127.0.0.1','localhost','::1'].includes(u.hostname));u.pathname='/postgres';
 admin=new pg.Client({connectionString:u.toString(),connectionTimeoutMillis:5000});await admin.connect();check();
 await admin.query(`CREATE DATABASE "${name}"`);created=true;u.pathname=`/${name}`;
 const database=u.toString();db=new pg.Client({connectionString:database,connectionTimeoutMillis:5000});await db.connect();
 stage='migration';const migrationPool=new pg.Pool({connectionString:database});try{await runMigrations(migrationPool,{directory:'packages/db/migrations'});}finally{await migrationPool.end();}check();
 const allowed=Object.fromEntries(['PATH','HOME','LANG','LC_ALL','KS_DEV_ROOT','COREPACK_HOME','TMPDIR'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]!] ]));
 const blanks=Object.fromEntries(Object.keys(config).map(key=>[key,'']));
 const port=await unusedPort();const env={...allowed,...blanks,DATABASE_URL:database,KS_DEV_TOKEN:token,PORT:String(port),NODE_ENV:'test'};
 stage='seed';const seed=launch(['scripts/seed.ts'],env);
 for(let i=0;i<100&&seed.exitCode===null&&seed.signalCode===null;i++){check();await pause(50);}
 assert.equal(seed.exitCode,0);children.delete(seed);
 const url=`http://127.0.0.1:${port}`;
 async function startApi(){api=launch(['apps/api/src/main.ts'],env);for(let i=0;i<100;i++){check();try{if((await fetch(`${url}/health`,{signal:AbortSignal.timeout(1000)})).ok)return;}catch{};await pause(50);}throw new Error('API unavailable');}
 async function request(path:string,body?:unknown,expected=200){check();const r=await fetch(url+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});assert.equal(r.status,expected);return r.json() as Promise<Record<string,any>>;}
 async function exposure(){const feed=await request('/v1/feed');const asset=feed.items[0];const receipt=await request('/v1/exposures',{decisionId:feed.decisionId,assetId:asset.assetId,clientExposureId:randomUUID()},201);return {feed,receipt};}
 stage='admission';await startApi();const source=await exposure();
 const question='  What changes here?\r\nKeep e\u0301 literal.  ';
 const input={clientAskId:randomUUID(),exposureId:source.receipt.exposureId,expectedPrivacyEpoch:source.feed.privacyEpoch,question};
 const ask=await request('/v1/asks',input,201);assert.equal(ask.status,'recorded_only');assert.deepEqual(await request('/v1/asks',input,201),ask);
 assert.equal((await db.query('SELECT payload->>\'question\' AS question FROM ledger WHERE id=$1',[ask.eventId])).rows[0]?.question,question);
 await request('/v1/asks',{...input,question:question.trim()},409);
 stage='restart';await stop(api);await startApi();assert.deepEqual(await request('/v1/asks',input,201),ask);
 for(const table of ['job','reasoning_job','reasoning_accounting','reasoning_fairness_ready','trace'])assert.equal(Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count),0,table);
 stage='clear';const clearInput={requestId:randomUUID(),expectedPrivacyEpoch:source.feed.privacyEpoch,confirmation:'clear-scroll-history'};
 const cleared=await request('/v1/history/clear',clearInput);assert.equal(Number((await db.query('SELECT count(*) FROM explicit_ask')).rows[0].count),0);
 assert.equal(Number((await db.query("SELECT count(*) FROM ledger WHERE kind='ask'")).rows[0].count),0);
 await request('/v1/asks',input,409);
 const later=await exposure();const laterAsk=await request('/v1/asks',{...input,exposureId:later.receipt.exposureId,expectedPrivacyEpoch:later.feed.privacyEpoch},201);
 assert.deepEqual(await request('/v1/history/clear',clearInput),cleared);
 assert.equal(Number((await db.query('SELECT count(*) FROM explicit_ask WHERE id=$1',[laterAsk.askId])).rows[0].count),1);
 stage='shutdown';await stop(api);assert.equal(api?.exitCode,0);assert.equal(stderrSeen,false);
 const paths=['scripts/run-isolated-ask-journey.ts','packages/contracts/src/index.ts','packages/db/migrations/0009_explicit_asks.sql','packages/db/src/explicit-ask.ts','packages/db/src/privacy.ts','packages/db/src/identity.ts','apps/api/src/app.ts','apps/api/src/main.ts'];
 receipt={check:'explicit-ask-http-durability',result:'passed',observedAt:new Date().toISOString(),source:{revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0,files:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},assertions:{separateApi:true,literalQuestionStored:true,identicalReplay:true,conflictRejected:true,apiRestartReplay:true,noJobsAccountingOrProjection:true,immediateClear:true,oldEpochRetryRejected:true,oldClearReplayPreservesLaterAsk:true},providerCalls:0,limits:['synthetic questions and editorial Scroll fixtures','no mobile Ask control, answer, provider invocation, semantic application or usefulness proof','API restart is not PostgreSQL restart; no production deployment claim']};
} catch {failed=true;console.error(JSON.stringify({check:'explicit-ask-http-durability',result:'failed',stage}));}
finally {
 for(const child of children){try{await stop(child);}catch{failed=true;}}
 try{await db?.end();if(created){await admin!.query(`DROP DATABASE "${name}" WITH(FORCE)`);assert.equal((await admin!.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0);}await admin?.end();}catch{failed=true;}
 process.removeListener('SIGTERM',requestStop);process.removeListener('SIGINT',requestStop);
}
if(failed||interrupted){process.exitCode=1;}
else if(receipt){receipt.cleanup={databaseAbsent:true,childrenExited:true};const path=process.argv[2]??'artifacts/explicit-ask-journey.json';await writeFile(path,JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({check:'explicit-ask-http-durability',result:'passed',receiptPath:path}));}
