import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {setTimeout} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {pool} from '../packages/db/src/index.ts';
const base=`http://127.0.0.1:${process.env.PORT ?? 4310}`;
async function call(path:string,body?:unknown) {
 const r=await fetch(base+path,{method:body?'POST':'GET',headers:{authorization:`Bearer ${process.env.KS_DEV_TOKEN}`,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
 const data=await r.json();assert.ok(r.ok,`${path}: ${r.status} ${JSON.stringify(data)}`);return data;
}
try {
 const before=await call('/v1/universe'), feed=await call('/v1/feed');
 const item=feed.items[0];if(!item) throw new Error('Starting library exhausted. Use an isolated journey database; do not erase personal history.');
 const exposure=await call('/v1/exposures',{decisionId:feed.decisionId,assetId:item.assetId,clientExposureId:randomUUID()});
 const body={clientEventId:randomUUID(),exposureId:exposure.exposureId,assetId:item.assetId,kind:'keep'};
 const accepted=await call('/v1/interactions',body);const replay=await call('/v1/interactions',body);assert.deepEqual(accepted,replay);
 let event;for(let i=0;i<40;i++){event=await call(`/v1/events/${accepted.eventId}`);if(event.projected)break;await setTimeout(250);}
 assert.equal(event.projected,true,'worker must apply the event');
 const after=await call('/v1/universe'), next=await call('/v1/feed');
 assert.ok(after.traces.some((t:{eventId:string})=>t.eventId===accepted.eventId));assert.ok(!next.items.some((a:{assetId:string})=>a.assetId===item.assetId));
 assert.equal(event.causationId,exposure.eventId);
 let git='uncommitted bootstrap';try{git=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
 const receipt={observedAt:new Date().toISOString(),git,journey:'J001',surface:'real HTTP + separate worker + PostgreSQL; Android UI is separate proof',assetId:item.assetId,decisionId:feed.decisionId,exposure,accepted,event,beforeRevision:before.revision,afterRevision:after.revision,nextDecisionId:next.decisionId,nextAssetIds:next.items.map((a:{assetId:string})=>a.assetId),result:'passed'};
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/j001-runtime.json',JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
} finally {await pool.end();}
