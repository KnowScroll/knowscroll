import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import pg from 'pg';

import {recordExplicitAsk} from '../packages/db/src/explicit-ask.ts';
import {runMigrations} from '../packages/db/src/migrations.ts';
import {compileDirectAskContext} from '../packages/db/src/reasoning-ask-context.ts';
import {compileDirectContext} from '../packages/db/src/reasoning-context.ts';
import {seedWithdrawnReasoningGraph} from './helpers/reasoning-maintenance-fixture.ts';
import {inTransaction,reasoningContextDatabaseUrl,seedDirectContextGraph} from './helpers/reasoning-context-fixture.ts';

const migrationNames=[
 '0001_bootstrap.sql','0002_identity_epochs.sql','0003_history_clear.sql','0004_reasoning_storage.sql','0005_reasoning_runtime.sql',
 '0006_reasoning_fairness.sql','0007_sealed_reasoning_context.sql','0008_reasoning_retirement.sql','0009_explicit_asks.sql',
 '0010_ask_context_binding.sql','0011_idle_direct_withdrawal.sql',
] as const;

type AskGraph={universeId:string;sessionId:string;askId:string;jobId:string;contextId:string};

async function existingRows(pool:pg.Pool,only?:string[]):Promise<Array<{table:string;rows:unknown}>> {
 const tables=only===undefined?(await pool.query<{table_name:string}>(`SELECT table_name FROM information_schema.tables
   WHERE table_schema=current_schema() AND table_type='BASE TABLE' AND table_name<>'schema_migrations' ORDER BY table_name`)).rows:
  only.map(table_name=>({table_name}));
 return Promise.all(tables.map(async ({table_name})=>({table:table_name,rows:(await pool.query(
  `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM "${table_name}" t`,
 )).rows[0]!.rows})));
}

async function seedBoundKeepContext(pool:pg.Pool):Promise<{jobId:string;contextId:string}> {
 const graph=await seedDirectContextGraph(pool);
 await inTransaction(pool,client=>compileDirectContext(client,graph.scope,{
  contextId:graph.contextId,jobId:graph.jobId,keepEventIds:graph.keepEventIds,
 },async()=>graph.policy));
 return {jobId:graph.jobId,contextId:graph.contextId};
}

async function seedBoundAskContext(pool:pg.Pool):Promise<AskGraph> {
 const graph=await seedDirectContextGraph(pool);
 const ask=await inTransaction(pool,async client=>{
  await client.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[graph.scope.universeId]);
  await client.query('SELECT id FROM device_session WHERE id=$1 FOR UPDATE',[graph.scope.sessionId]);
  return recordExplicitAsk(client,graph.scope,{
   clientAskId:randomUUID(),exposureId:graph.exposureId,expectedPrivacyEpoch:0,question:'A preserved migration Ask?',
  });
 });
 const jobId=randomUUID(),contextId=randomUUID();
 await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
  VALUES($1,$2,0,'queued','interactive',$2,$3,clock_timestamp()+interval '1 hour','direct',$4)`,
 [jobId,graph.scope.universeId,graph.policy.policyVersion,ask.askId]);
 await pool.query(`INSERT INTO reasoning_context_job_session(job_id,universe_id,privacy_epoch,session_id)
  VALUES($1,$2,0,$3)`,[jobId,graph.scope.universeId,graph.scope.sessionId]);
 await pool.query(`INSERT INTO reasoning_context_job_ask(job_id,universe_id,privacy_epoch,session_id,ask_id)
  VALUES($1,$2,0,$3,$4)`,[jobId,graph.scope.universeId,graph.scope.sessionId,ask.askId]);
 const askPolicy={...graph.policy,buckets:graph.policy.buckets.map(bucket=>bucket.scope==='job'?{...bucket,scopeId:jobId}:bucket)};
 await inTransaction(pool,client=>compileDirectAskContext(client,graph.scope,{contextId,jobId,askId:ask.askId},async()=>askPolicy));
 return {universeId:graph.scope.universeId,sessionId:graph.scope.sessionId,askId:ask.askId,jobId,contextId};
}

test('0011 upgrades populated 0010 history exactly once without rewriting sealed or withdrawn rows',async()=>{
 const schema=`idle_direct_upgrade_${randomUUID().replaceAll('-','')}`;
 // scripts/env.sh routes local TMPDIR to the SSD; CI supplies its own dev root.
 const directory=await mkdtemp(join(tmpdir(),'knowscroll-idle-migration-'));
 const admin=new pg.Pool({connectionString:reasoningContextDatabaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(reasoningContextDatabaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new pg.Pool({connectionString:url.toString()});
 try {
  for(const name of migrationNames.slice(0,10)) await writeFile(join(directory,name),await readFile(join('packages/db/migrations',name)));
  assert.deepEqual(await runMigrations(pool,{directory}),{applied:[...migrationNames.slice(0,10)],adopted:[]});
  const keep=await seedBoundKeepContext(pool);
  const ask=await seedBoundAskContext(pool);
  const withdrawn=await seedWithdrawnReasoningGraph(pool);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM reasoning_context_job_session WHERE job_id=$1`,[keep.jobId])).rows[0]!.count,1);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM reasoning_context_job_ask WHERE job_id=$1`,[ask.jobId])).rows[0]!.count,1);
  assert.deepEqual((await pool.query(`SELECT status,withdrawn_at IS NOT NULL AS withdrawn FROM reasoning_job WHERE id=$1`,[withdrawn.jobId])).rows[0],{status:'cancelled',withdrawn:true});
  const beforeRows=await existingRows(pool);
  const beforeChecksums=(await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  assert.equal(beforeChecksums.length,10);

  const idleMigration=migrationNames[10];
  await writeFile(join(directory,idleMigration),await readFile(join('packages/db/migrations',idleMigration)));
  assert.deepEqual(await runMigrations(pool,{directory}),{applied:[idleMigration],adopted:[]});
  assert.deepEqual(await existingRows(pool,beforeRows.map(entry=>entry.table)),beforeRows);
  assert.deepEqual((await pool.query('SELECT name,checksum FROM schema_migrations WHERE name<>$1 ORDER BY name',[idleMigration])).rows,beforeChecksums);
  assert.equal((await pool.query<{checksum:string}>('SELECT checksum FROM schema_migrations WHERE name=$1',[idleMigration])).rows[0]!.checksum,
   createHash('sha256').update(await readFile(join('packages/db/migrations',idleMigration))).digest('hex'));
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM pg_trigger
   WHERE tgname='reasoning_withdrawal_clock_guard' AND tgrelid='reasoning_job'::regclass AND NOT tgisinternal`)).rows[0]!.count,1);
  assert.equal((await pool.query<{guard:string | null}>(`SELECT to_regprocedure('reasoning_withdrawal_clock_guard()')::text AS guard`)).rows[0]!.guard,'reasoning_withdrawal_clock_guard()');
  assert.deepEqual(await runMigrations(pool,{directory}),{applied:[],adopted:[]});
 } finally {
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true});
 }
});
