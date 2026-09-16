import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import pg from 'pg';

import {recordExplicitAsk} from '../packages/db/src/explicit-ask.ts';
import {runMigrations} from '../packages/db/src/migrations.ts';
import {inTransaction,reasoningContextDatabaseUrl,seedDirectContextGraph,withReasoningContextSchema} from './helpers/reasoning-context-fixture.ts';

type AskGraph={
 universeId:string;sessionId:string;askId:string;jobId:string;policyVersion:string;
};

async function seedAskJob(pool:pg.Pool):Promise<AskGraph> {
 const graph=await seedDirectContextGraph(pool);
 const ask=await inTransaction(pool,async client=>{
  await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
  await client.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
  return recordExplicitAsk(client,graph.scope,{
   clientAskId:randomUUID(),exposureId:graph.exposureId,expectedPrivacyEpoch:0,question:'  literal Ask\n',
  });
 });
 const jobId=randomUUID();
 await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
  VALUES($1,$2,0,'queued','interactive',$2,$3,clock_timestamp()+interval '1 hour','direct',$4)`,
 [jobId,graph.scope.universeId,graph.policy.policyVersion,ask.askId]);
 await pool.query(`INSERT INTO reasoning_context_job_session(job_id,universe_id,privacy_epoch,session_id)
  VALUES($1,$2,0,$3)`,[jobId,graph.scope.universeId,graph.scope.sessionId]);
 return {universeId:graph.scope.universeId,sessionId:graph.scope.sessionId,askId:ask.askId,jobId,policyVersion:graph.policy.policyVersion};
}

async function bind(pool:pg.Pool,graph:AskGraph):Promise<void> {
 await pool.query(`INSERT INTO reasoning_context_job_ask(job_id,universe_id,privacy_epoch,session_id,ask_id)
  VALUES($1,$2,0,$3,$4)`,[graph.jobId,graph.universeId,graph.sessionId,graph.askId]);
}

async function existingRows(pool:pg.Pool):Promise<Array<{table:string;rows:unknown}>> {
 const tables=(await pool.query<{table_name:string}>(`SELECT table_name FROM information_schema.tables
   WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name<>'schema_migrations' ORDER BY table_name`)).rows;
 return Promise.all(tables.map(async ({table_name})=>({table:table_name,rows:(await pool.query(
  `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM "${table_name}" t`,
 )).rows[0]!.rows})));
}

test('0010 upgrades populated 0009 history without rewriting prior rows or checksums',async()=>{
 const schema=`ask_context_upgrade_${randomUUID().replaceAll('-','')}`;
 const directory=await mkdtemp(join(tmpdir(),'knowscroll-ask-context-'));
 const admin=new pg.Pool({connectionString:reasoningContextDatabaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(reasoningContextDatabaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new pg.Pool({connectionString:url.toString()});
 const names=['0001_bootstrap.sql','0002_identity_epochs.sql','0003_history_clear.sql','0004_reasoning_storage.sql','0005_reasoning_runtime.sql','0006_reasoning_fairness.sql','0007_sealed_reasoning_context.sql','0008_reasoning_retirement.sql','0009_explicit_asks.sql','0010_ask_context_binding.sql'];
 try {
  for(const name of names.slice(0,9)) await writeFile(join(directory,name),await readFile(join('packages/db/migrations',name)));
  assert.deepEqual((await runMigrations(pool,{directory})).applied,names.slice(0,9));
  const graph=await seedAskJob(pool);
  const before=await existingRows(pool);
  const checksums=(await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  await writeFile(join(directory,names[9]!),await readFile(join('packages/db/migrations',names[9]!)));
  assert.deepEqual((await runMigrations(pool,{directory})).applied,[names[9]]);
  assert.deepEqual(await existingRows(pool),before);
  assert.deepEqual((await pool.query('SELECT name,checksum FROM schema_migrations WHERE name<>$1 ORDER BY name',[names[9]])).rows,checksums);
  assert.equal((await pool.query<{checksum:string}>('SELECT checksum FROM schema_migrations WHERE name=$1',[names[9]])).rows[0]!.checksum,
   createHash('sha256').update(await readFile(join('packages/db/migrations',names[9]!))).digest('hex'));
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE id=$1',[graph.askId])).rows[0]!.count,1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM ledger WHERE kind=$1',['keep'])).rows[0]!.count,1);
 } finally {
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true});
 }
});

test('0010 binds only the original Ask/session/queued Job and freezes its family identity',async t=>{
 await t.test('accepts the scoped binding but rejects rebinding and direct-Scroll context substitution',async()=>{
  await withReasoningContextSchema('ask_context_binding',async pool=>{
   const graph=await seedAskJob(pool);
   await bind(pool,graph);
   assert.deepEqual((await pool.query(`SELECT job_id,universe_id,privacy_epoch,session_id,ask_id
     FROM reasoning_context_job_ask WHERE job_id=$1`,[graph.jobId])).rows[0],{
    job_id:graph.jobId,universe_id:graph.universeId,privacy_epoch:0,session_id:graph.sessionId,ask_id:graph.askId,
   });
   await assert.rejects(pool.query('UPDATE reasoning_context_job_ask SET ask_id=$2 WHERE job_id=$1',[graph.jobId,randomUUID()]),/immutable/);
   await assert.rejects(pool.query('DELETE FROM reasoning_context_job_ask WHERE job_id=$1',[graph.jobId]),/erases only with its Job/);
   await assert.rejects(pool.query('UPDATE reasoning_job SET intent_id=$2 WHERE id=$1',[graph.jobId,randomUUID()]),/identity is immutable/);
   await assert.rejects(pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,0,$4,$5,'editorial-asset-pointer-v1')`,
    [randomUUID(),graph.jobId,graph.universeId,'a'.repeat(64),graph.policyVersion]),/cannot change context family/);
   await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,0,$4,$5,'ask-editorial-asset-pointer-v1')`,
    [randomUUID(),graph.jobId,graph.universeId,'b'.repeat(64),graph.policyVersion]);
  });
 });

 await t.test('a pre-existing Keep family prevents Ask binding and failure leaves no partial row',async()=>{
  await withReasoningContextSchema('ask_context_rollback',async pool=>{
   const graph=await seedAskJob(pool);
   await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
     VALUES($1,$2,$3,0,$4,$5,'editorial-asset-pointer-v1')`,
    [randomUUID(),graph.jobId,graph.universeId,'c'.repeat(64),graph.policyVersion]);
   await assert.rejects(bind(pool,graph),/already uses another context family/);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_job_ask WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
  });
 });

 await t.test('competing first Ask binding serializes a Keep-family insert and rejects the losing family',async()=>{
  await withReasoningContextSchema('ask_context_first_family_race',async pool=>{
   const graph=await seedAskJob(pool);
   const binder=await pool.connect(),keeper=await pool.connect();
   let binderOpen=true,keeperOpen=true;
   try {
    await binder.query('BEGIN');
    await binder.query(`INSERT INTO reasoning_context_job_ask(job_id,universe_id,privacy_epoch,session_id,ask_id)
      VALUES($1,$2,0,$3,$4)`,[graph.jobId,graph.universeId,graph.sessionId,graph.askId]);
    await keeper.query('BEGIN');
    const pid=Number((await keeper.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
    const losing=keeper.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
      VALUES($1,$2,$3,0,$4,$5,'editorial-asset-pointer-v1')`,
    [randomUUID(),graph.jobId,graph.universeId,'d'.repeat(64),graph.policyVersion]);
    let waited=false;
    for(let attempt=0;attempt<20;attempt++) {
     const state=(await pool.query<{wait_event_type:string|null}>('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
     if(state?.wait_event_type==='Lock') {waited=true;break;}
     await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.equal(waited,true,'Keep insert must wait on the first-family Job lock');
    await binder.query('COMMIT');binderOpen=false;
    await assert.rejects(losing,/Ask Job cannot change context family/);
    await keeper.query('ROLLBACK');keeperOpen=false;
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_job_ask WHERE job_id=$1',[graph.jobId])).rows[0]!.count,1);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
   } finally {
    if(binderOpen) await binder.query('ROLLBACK');
    if(keeperOpen) await keeper.query('ROLLBACK');
    binder.release();keeper.release();
   }
  });
 });

 await t.test('Job deletion cascades only the private binding and preserves recorded Ask source history',async()=>{
  await withReasoningContextSchema('ask_context_retirement_shape',async pool=>{
   const graph=await seedAskJob(pool);
   await bind(pool,graph);
   await pool.query('DELETE FROM reasoning_job WHERE id=$1',[graph.jobId]);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM reasoning_context_job_ask WHERE job_id=$1',[graph.jobId])).rows[0]!.count,0);
   assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE id=$1',[graph.askId])).rows[0]!.count,1);
   assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger l JOIN explicit_ask a ON a.event_id=l.id WHERE a.id=$1`,[graph.askId])).rows[0]!.count,1);
  });
 });
});
