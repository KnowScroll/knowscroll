import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout} from 'node:timers/promises';
import assert from 'node:assert/strict';
import pg from 'pg';
import {loadLocalEnv, pool as localEnvironmentPool} from '../packages/db/src/index.ts';
import {verifyPersistedJourney} from './journey-verifier.ts';
loadLocalEnv();
const base=`http://127.0.0.1:${process.env.PORT ?? 4310}`;
const databaseUrl=process.env.JOURNEY_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL required for PostgreSQL lineage verification');
const pool=new pg.Pool({connectionString:databaseUrl,max:1,connectionTimeoutMillis:5000});
async function call(path:string,body?:unknown) {
 const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${process.env.KS_DEV_TOKEN}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(5000)});
 const data=await r.json();assert.ok(r.ok,`${path}: ${r.status} ${JSON.stringify(data)}`);return data;
}
try {
 const before=await call('/v1/universe'), feed=await call('/v1/feed');
 assert.equal(before.universeId,feed.universeId,'feed must belong to the observed universe');
 const item=feed.items[0];if(!item) throw new Error('Starting library exhausted. Use an isolated journey database; do not erase personal history.');
 const exposureBody={decisionId:feed.decisionId,assetId:item.assetId,clientExposureId:randomUUID()};
 const exposure=await call('/v1/exposures',exposureBody);
 const body={clientEventId:randomUUID(),exposureId:exposure.exposureId,assetId:item.assetId,kind:'keep'};
 const accepted=await call('/v1/interactions',body);const replay=await call('/v1/interactions',body);assert.deepEqual(accepted,replay);
 let event;for(let i=0;i<40;i++){event=await call(`/v1/events/${accepted.eventId}`);if(event.projected)break;await setTimeout(250);}
 assert.equal(event.projected,true,'worker must apply the event');
 const after=await call('/v1/universe'), next=await call('/v1/feed');
 assert.equal(after.universeId,feed.universeId,'projection must remain in the observed universe');
 assert.ok(after.traces.some((t:{eventId:string})=>t.eventId===accepted.eventId));assert.ok(!next.items.some((a:{assetId:string})=>a.assetId===item.assetId));
 assert.equal(event.eventId,accepted.eventId);assert.equal(event.jobId,accepted.jobId);assert.equal(event.jobStatus,'completed');assert.equal(event.causationId,exposure.eventId);
 const persisted=await verifyPersistedJourney(pool,{universeId:feed.universeId,asset:item,decisionId:feed.decisionId,accountRevision:feed.accountRevision,exposure:{...exposure,clientExposureId:exposureBody.clientExposureId},accepted:{...accepted,clientEventId:body.clientEventId},beforeRevision:before.revision,afterRevision:after.revision});
 let head='unavailable',dirty=true;try{head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();dirty=Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim());}catch{}
 const sourceHashes=Object.fromEntries(await Promise.all(['scripts/verify-journey.ts','scripts/journey-verifier.ts','apps/api/src/app.ts','apps/worker/src/project.ts','packages/db/migrations/0001_bootstrap.sql'].map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));
 const db=new URL(databaseUrl);
 const receipt={observedAt:new Date().toISOString(),git:{head,dirty},sourceHashes,journey:'J001',surface:'real HTTP plus PostgreSQL persisted causal lineage; worker-process launch evidence is supplied only by the isolated runner',environment:{apiBase:base,database:{kind:'PostgreSQL',host:db.hostname,port:db.port||'5432',name:db.pathname.slice(1)},node:process.version},source:{assetId:item.assetId,assetRevision:item.revision,sourceTitle:item.sourceTitle,sourceUrl:item.sourceUrl,truthState:item.truthState},decisionId:feed.decisionId,exposure,accepted,event,beforeRevision:before.revision,afterRevision:after.revision,nextDecisionId:next.decisionId,nextAssetIds:next.items.map((a:{assetId:string})=>a.assetId),persisted,result:'passed'};
 const receiptPath=process.env.JOURNEY_RECEIPT_PATH ?? 'artifacts/j001-runtime.json';
 await mkdir(dirname(receiptPath),{recursive:true});await writeFile(receiptPath,JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
} finally {await pool.end();await localEnvironmentPool.end();}
