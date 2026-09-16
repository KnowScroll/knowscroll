import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {lockUniverse} from '../packages/db/src/index.ts';
import {runMigrations} from '../packages/db/src/migrations.ts';

const databaseUrl=process.env.DATABASE_URL??(()=>{throw new Error('DATABASE_URL required for explicit Ask tests');})();
if(!new URL(databaseUrl).pathname.slice(1).startsWith('knowscroll_test_')) throw new Error('Explicit Ask tests require a disposable knowscroll_test_* database');

async function withAskSchema(name:string,fn:(pool:pg.Pool)=>Promise<void>):Promise<void> {
 const schema=`ask_${name}_${randomUUID().replaceAll('-','')}`;
 const admin=new pg.Pool({connectionString:databaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new pg.Pool({connectionString:url.toString(),max:6});
 try {await runMigrations(pool,{directory:'packages/db/migrations'});await fn(pool);}
 finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}

async function tx<T>(pool:pg.Pool,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
 const client=await pool.connect();
 try {await client.query('BEGIN');const value=await fn(client);await client.query('COMMIT');return value;}
 catch(error) {await client.query('ROLLBACK');throw error;}
 finally {client.release();}
}

type Graph={universeId:string;sessionId:string;exposureId:string;exposureEventId:string;decisionId:string;selectedAssetId:string;otherAssetId:string;epoch:number};

async function seed(pool:pg.Pool):Promise<Graph> {
 const universeId=randomUUID(),sessionId=randomUUID(),decisionId=randomUUID(),selectedAssetId=randomUUID(),otherAssetId=randomUUID();
 const exposureId=randomUUID(),exposureEventId=randomUUID(),clientExposureId=randomUUID();
 await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
 await pool.query('INSERT INTO accounts(universe_id) VALUES($1)',[universeId]);
 await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
  VALUES($1,$2,$3,$4,0,clock_timestamp()+interval '1 hour')`,[sessionId,universeId,randomUUID(),'a'.repeat(64)]);
 for(const [assetId,title] of [[selectedAssetId,'selected'],[otherAssetId,'other']] as const) await pool.query(`INSERT INTO asset
  (id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
  VALUES($1,1,'Scroll',$2,'summary','body','source','https://example.test','documented',$3)`,[assetId,title,title==='selected'?1:2]);
 await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch)
  VALUES($1,$2,0,'ask-test',$3,0)`,[decisionId,universeId,JSON.stringify([{assetId:selectedAssetId,kind:'Scroll'}])]);
 const payload={decisionId,assetId:selectedAssetId,clientExposureId,exposureId};
 await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch)
  VALUES($1,$2,'exposure',$3,$4,0)`,[exposureEventId,universeId,clientExposureId,JSON.stringify(payload)]);
 await pool.query(`INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key)
  VALUES($1,$2,$3,$4,$5,$6)`,[exposureId,universeId,decisionId,selectedAssetId,exposureEventId,clientExposureId]);
 return {universeId,sessionId,exposureId,exposureEventId,decisionId,selectedAssetId,otherAssetId,epoch:0};
}

async function insertAsk(client:pg.PoolClient,graph:Graph,options:{question?:string;sessionId?:string;exposureId?:string;eventId?:string;clientAskId?:string;assetId?:string;decisionId?:string;epoch?:number}={}) {
 const question=options.question??'What does this mean?';
 const sessionId=options.sessionId??graph.sessionId,exposureId=options.exposureId??graph.exposureId,eventId=options.eventId??randomUUID();
 const clientAskId=options.clientAskId??randomUUID(),assetId=options.assetId??graph.selectedAssetId,decisionId=options.decisionId??graph.decisionId,epoch=options.epoch??graph.epoch;
 const payload={question,exposureId,decisionId,assetId,sessionId,clientAskId,expectedPrivacyEpoch:epoch};
 await client.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch)
  VALUES($1,$2,'ask',$3,$4,$5,$6)`,[eventId,graph.universeId,clientAskId,graph.exposureEventId,JSON.stringify(payload),epoch]);
 const askId=randomUUID();
 await client.query(`INSERT INTO explicit_ask(id,event_id,universe_id,privacy_epoch,session_id,client_ask_id,exposure_id)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[askId,eventId,graph.universeId,epoch,sessionId,clientAskId,exposureId]);
 return {askId,eventId,clientAskId};
}

test('explicit Ask SQL constraints preserve only exact source-bound literal facts',async t=>{
 await t.test('a complete valid Ask commits, while either half alone rolls back',async()=>{
  await withAskSchema('pairing',async pool=>{
   const graph=await seed(pool);
   const recorded=await tx(pool,client=>insertAsk(client,graph));
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE id=$1',[recorded.askId])).rows[0]!.count,1);
   await assert.rejects(tx(pool,async client=>{
    const eventId=randomUUID(),clientAskId=randomUUID();
    await client.query("INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch) VALUES($1,$2,'ask',$3,$4,$5,0)",
     [eventId,graph.universeId,clientAskId,graph.exposureEventId,JSON.stringify({question:'orphan',exposureId:graph.exposureId,decisionId:graph.decisionId,assetId:graph.selectedAssetId,sessionId:graph.sessionId,clientAskId,expectedPrivacyEpoch:0})]);
   }),/Explicit Ask requires matching private source lineage/);
   await assert.rejects(tx(pool,async client=>{
    await client.query(`INSERT INTO explicit_ask(id,event_id,universe_id,privacy_epoch,session_id,client_ask_id,exposure_id)
     VALUES($1,$2,$3,0,$4,$5,$6)`,[randomUUID(),graph.exposureEventId,graph.universeId,graph.sessionId,randomUUID(),graph.exposureId]);
   }),/Explicit Ask requires an Ask event/);
   await assert.rejects(pool.query('UPDATE ledger SET payload=$2 WHERE id=$1',[recorded.eventId,JSON.stringify({question:'changed'})]),/Explicit Ask facts are immutable/);
  });
 });

 await t.test('forged exposure payload, unselected asset, stale session epoch, and blank Unicode are rejected',async()=>{
  await withAskSchema('forgery',async pool=>{
   const graph=await seed(pool);
   await pool.query('UPDATE exposure SET asset_id=$2 WHERE id=$1',[graph.exposureId,graph.otherAssetId]);
   await pool.query("UPDATE ledger SET payload=jsonb_set(payload,'{assetId}',to_jsonb($2::text)) WHERE id=$1",[graph.exposureEventId,graph.otherAssetId]);
   await assert.rejects(tx(pool,client=>insertAsk(client,graph,{assetId:graph.otherAssetId})),/Explicit Ask requires matching private source lineage/);
   await pool.query('UPDATE exposure SET asset_id=$2 WHERE id=$1',[graph.exposureId,graph.selectedAssetId]);
   await pool.query("UPDATE ledger SET payload=jsonb_set(payload,'{assetId}',to_jsonb($2::text)) WHERE id=$1",[graph.exposureEventId,graph.otherAssetId]);
   await assert.rejects(tx(pool,client=>insertAsk(client,graph)),/Explicit Ask requires matching private source lineage/);
   await pool.query("UPDATE ledger SET payload=jsonb_set(payload,'{assetId}',to_jsonb($2::text)) WHERE id=$1",[graph.exposureEventId,graph.selectedAssetId]);
   await pool.query("UPDATE decision SET candidates=$2 WHERE id=$1",[graph.decisionId,JSON.stringify([{assetId:graph.selectedAssetId,kind:'Reel'}])]);
   await assert.rejects(tx(pool,client=>insertAsk(client,graph)),/Explicit Ask requires matching private source lineage/);
   await pool.query("UPDATE decision SET candidates=$2 WHERE id=$1",[graph.decisionId,JSON.stringify([{assetId:graph.selectedAssetId,kind:'Scroll'}])]);
   await pool.query('UPDATE device_session SET privacy_epoch=1 WHERE id=$1',[graph.sessionId]);
   await assert.rejects(tx(pool,client=>insertAsk(client,graph)),/Explicit Ask requires matching private source lineage/);
   await pool.query('UPDATE device_session SET privacy_epoch=0 WHERE id=$1',[graph.sessionId]);
   await assert.rejects(tx(pool,client=>insertAsk(client,graph,{question:'\u2003'})),/Explicit Ask requires matching private source lineage/);
  });
 });

 await t.test('direct Ask deletion is refused, while a universe-locked history clear deletes both halves and replays',async()=>{
  await withAskSchema('clear',async pool=>{
   const graph=await seed(pool);
   const recorded=await tx(pool,client=>insertAsk(client,graph));
   await assert.rejects(pool.query('DELETE FROM ledger WHERE id=$1',[recorded.eventId]),/Explicit Ask erasure requires an advanced privacy epoch/);
   await assert.rejects(pool.query('DELETE FROM explicit_ask WHERE id=$1',[recorded.askId]),/Explicit Ask requires matching private source lineage/);
   const input={requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history' as const};
   const scope={sessionId:graph.sessionId,deviceId:(await pool.query('SELECT device_id FROM device_session WHERE id=$1',[graph.sessionId])).rows[0]!.device_id as string,universeId:graph.universeId,privacyEpoch:0,expiresAt:new Date(Date.now()+60_000).toISOString()};
   const receipt=await tx(pool,async client=>{await lockUniverse(client,graph.universeId);return clearScrollHistory(client,scope,input);});
   assert.equal((await pool.query("SELECT count(*)::int AS count FROM ledger WHERE kind='ask'")).rows[0]!.count,0);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask')).rows[0]!.count,0);
   const replay=await tx(pool,async client=>{await lockUniverse(client,graph.universeId);return clearScrollHistory(client,{...scope,privacyEpoch:1},{...input,expectedPrivacyEpoch:0});});
   assert.deepEqual(replay,receipt);
  });
 });
});
