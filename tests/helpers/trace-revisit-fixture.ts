import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';

import {authenticateAndLock,type AuthScope} from '../../packages/db/src/identity.ts';
import {runMigrations} from '../../packages/db/src/migrations.ts';
import {readTraceRevisit} from '../../packages/db/src/trace-revisit.ts';

const databaseUrl=process.env.DATABASE_URL??(()=>{throw new Error('DATABASE_URL required');})();
if(!new URL(databaseUrl).pathname.startsWith('/knowscroll_test_')) throw new Error('Trace revisit fixtures require a disposable knowscroll_test_* database');

export async function withTraceRevisitSchema(name:string,fn:(pool:pg.Pool)=>Promise<void>):Promise<void> {
 const schema=`revisit_${name}_${randomUUID().replaceAll('-','')}`,admin=new pg.Pool({connectionString:databaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(databaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new pg.Pool({connectionString:url.toString(),max:8});
 try {await runMigrations(pool,{directory:'packages/db/migrations'});await fn(pool);}
 finally {await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
}
export async function inRevisitTransaction<T>(pool:pg.Pool,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
 const client=await pool.connect();
 try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}

export async function seedTraceRevisitGraph(pool:pg.Pool,options:{projected?:boolean;universeId?:string}={}) {
 const universeId=options.universeId??randomUUID(),sessionId=randomUUID(),deviceId=randomUUID(),assetId=randomUUID(),
  decisionId=randomUUID(),exposureId=randomUUID(),exposureEventId=randomUUID(),exposureKey=randomUUID(),keepEventId=randomUUID(),keepKey=randomUUID(),jobId=randomUUID();
 const token=randomBytes(32).toString('hex');
 if(!options.universeId) {
  await pool.query('INSERT INTO universe(id) VALUES($1)',[universeId]);
  await pool.query('INSERT INTO accounts(universe_id) VALUES($1)',[universeId]);
 }
 const privacyEpoch=Number((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1',[universeId])).rows[0].privacy_epoch);
 const session=(await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
  VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour') RETURNING expires_at`,[sessionId,universeId,deviceId,createHash('sha256').update(token).digest('hex'),privacyEpoch])).rows[0];
 const scope:AuthScope={sessionId,deviceId,universeId,privacyEpoch,expiresAt:session.expires_at.toISOString()};
 const scroll={assetId,revision:1,kind:'Scroll' as const,title:'The saved tide — literal title',summary:'An original selected summary.',
  body:'Original selected body.\n\nA second paragraph remains literal.',sourceTitle:'Editorial tide pointer',sourceUrl:'https://example.test/tide?ref=1',truthState:'documented' as const};
 const candidate={...scroll,reason:'Editorial selection metadata',selectionDetails:{testOnly:true}};
 const order=Number((await pool.query('SELECT COALESCE(max(editorial_order),0)+1 AS next FROM asset')).rows[0].next);
 await pool.query(`INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order)
  VALUES($1,1,'Scroll',$2,$3,$4,$5,$6,'documented',$7)`,[assetId,scroll.title,scroll.summary,scroll.body,scroll.sourceTitle,scroll.sourceUrl,order]);
 await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch)
  VALUES($1,$2,0,'editorial-unkept-v1',$3,$4)`,[decisionId,universeId,JSON.stringify([candidate]),privacyEpoch]);
 await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,payload,privacy_epoch)
  VALUES($1,$2,'exposure',$3,$4,$5)`,[exposureEventId,universeId,exposureKey,JSON.stringify({decisionId,assetId,clientExposureId:exposureKey,exposureId}),privacyEpoch]);
 await pool.query('INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key) VALUES($1,$2,$3,$4,$5,$6)',[exposureId,universeId,decisionId,assetId,exposureEventId,exposureKey]);
 await pool.query(`INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload,privacy_epoch,created_at)
  VALUES($1,$2,'keep',$3,$4,$5,$6,clock_timestamp()-interval '2 minutes')`,[keepEventId,universeId,keepKey,exposureEventId,JSON.stringify({clientEventId:keepKey,exposureId,assetId,kind:'keep'}),privacyEpoch]);
 const projected=options.projected??true;
 await pool.query(`INSERT INTO job(id,universe_id,event_id,kind,privacy_epoch,status,completed_at)
  VALUES($1,$2,$3,'project_keep',$4,$5,CASE WHEN $5='completed' THEN clock_timestamp() ELSE NULL END)`,[jobId,universeId,keepEventId,privacyEpoch,projected?'completed':'pending']);
 if(projected) await pool.query('INSERT INTO trace(universe_id,asset_id,event_id) VALUES($1,$2,$3)',[universeId,assetId,keepEventId]);
 return {scope,token,scroll,candidate,assetId,decisionId,exposureId,exposureEventId,exposureKey,keepEventId,keepKey,jobId};
}
export type TraceRevisitGraph=Awaited<ReturnType<typeof seedTraceRevisitGraph>>;
export function revisit(pool:pg.Pool,graph:TraceRevisitGraph,eventId:string=graph.keepEventId) {
 return inRevisitTransaction(pool,async client=>readTraceRevisit(client,await authenticateAndLock(client,graph.token),eventId));
}
export async function waitForRevisitPredicate(check:()=>Promise<boolean>,label:string):Promise<void> {
 const deadline=Date.now()+3_000;
 while(Date.now()<deadline) {if(await check()) return;await new Promise(resolve=>setTimeout(resolve,5));}
 throw new Error(`Trace revisit barrier timed out: ${label}`);
}

/** Statement triggers also catch same-value writes and zero-row write queries. */
export async function rejectRevisitWrites(pool:pg.Pool):Promise<()=>Promise<void>> {
 const tables=(await pool.query<{tablename:string}>('SELECT tablename FROM pg_tables WHERE schemaname=current_schema()')).rows.map(row=>row.tablename);
 await pool.query(`CREATE FUNCTION reject_revisit_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'revisit attempted domain write'; END $$`);
 for(const table of tables) await pool.query(`CREATE TRIGGER reject_revisit_write BEFORE INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION reject_revisit_write()`);
 return async()=>{
  for(const table of tables) await pool.query(`DROP TRIGGER reject_revisit_write ON "${table}"`);
  await pool.query('DROP FUNCTION reject_revisit_write()');
 };
}
