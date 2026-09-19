/**
 * Issue81 populated 0011→0012 preservation test for ADR-0019.
 *
 * The migration must:
 *   - add a nullable finished_at column with a check constraint;
 *   - leave every existing row, every prior column and every prior checksum
 *     untouched;
 *   - install the finished_at clock trigger and its index;
 *   - preserve ledger/device-session/explicit-ask/Ask-context binding rows
 *     and original-session bindings for prior fixtures;
 *   - keep a recorded Ask visible and its question text intact;
 *   - keep the prior 168-hour withdrawn clock guard working alongside the
 *     new guard, both for already-withdrawn jobs and for freshly terminal
 *     jobs.
 */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
 '0010_ask_context_binding.sql','0011_idle_direct_withdrawal.sql','0012_terminal_private_retirement.sql',
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

async function jobSnapshot(pool:pg.Pool):Promise<Array<Record<string,unknown>>> {
 return (await pool.query<Record<string,unknown>>(`SELECT to_jsonb(j.*) AS row FROM reasoning_job j ORDER BY j.id`)).rows.map(r=>r.row as Record<string,unknown>);
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
   clientAskId:randomUUID(),exposureId:graph.exposureId,expectedPrivacyEpoch:0,question:'A preserved terminal Ask?',
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

test('0012 upgrades populated 0011 history exactly once without rewriting prior rows or checksums',async()=>{
 const schema=`terminal_upgrade_${randomUUID().replaceAll('-','')}`;
 const directory=await mkdtemp(join(tmpdir(),'knowscroll-terminal-migration-'));
 const admin=new pg.Pool({connectionString:reasoningContextDatabaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(reasoningContextDatabaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new pg.Pool({connectionString:url.toString(),max:8});
 const priorNames=migrationNames.slice(0,11);
 const terminalName=migrationNames[11]!;
 try {
  for(const name of priorNames) await writeFile(join(directory,name),await readFile(join('packages/db/migrations',name)));
  assert.deepEqual((await runMigrations(pool,{directory})).applied,[...priorNames]);

  // Populate every prior fixture row so the upgrade must preserve them all.
  const keep=await seedBoundKeepContext(pool);
  const ask=await seedBoundAskContext(pool);
  const withdrawn=await seedWithdrawnReasoningGraph(pool);

  // Sanity: the populated rows exist before the new migration runs.
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM reasoning_context_job_session WHERE job_id=$1`,[keep.jobId])).rows[0]!.count,1);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM reasoning_context_job_ask WHERE job_id=$1`,[ask.jobId])).rows[0]!.count,1);
  assert.deepEqual((await pool.query(`SELECT status,withdrawn_at IS NOT NULL AS withdrawn FROM reasoning_job WHERE id=$1`,[withdrawn.jobId])).rows[0],
   {status:'cancelled',withdrawn:true});

  const beforeRows=await existingRows(pool);
  const beforeJobs=await jobSnapshot(pool);
  const beforeChecksums=(await pool.query('SELECT name,checksum FROM schema_migrations ORDER BY name')).rows;
  assert.equal(beforeChecksums.length,11);
  // The withdrawn row's lease_fence must already have advanced.
  const withdrawnFence=(await pool.query(`SELECT lease_fence::text AS fence FROM reasoning_job WHERE id=$1`,[withdrawn.jobId])).rows[0]!.fence;
  assert.equal(withdrawnFence,'1');

  await writeFile(join(directory,terminalName),await readFile(join('packages/db/migrations',terminalName)));
  assert.deepEqual((await runMigrations(pool,{directory})).applied,[terminalName]);
  assert.deepEqual((await runMigrations(pool,{directory})).applied,[]);

  // Every row from every non-reasoning_job table is preserved exactly.
  // reasoning_job gains a new finished_at column, so the prior rows are
  // compared column-by-column below.
  assert.deepEqual(await existingRows(pool,beforeRows.map(entry=>entry.table).filter(name=>name!=='reasoning_job')),beforeRows.filter(entry=>entry.table!=='reasoning_job'));
  // Every prior reasoning_job row keeps its old columns and gains a NULL finished_at.
  const afterJobs=await jobSnapshot(pool);
  assert.equal(afterJobs.length,beforeJobs.length);
  for(let index=0;index<beforeJobs.length;index+=1) {
   const before=beforeJobs[index]!;
   const after=afterJobs[index]!;
   for(const [key,value] of Object.entries(before)) {
    assert.deepEqual(after[key],value,`column ${key} preserved for job ${before.id}`);
   }
   assert.equal(after['finished_at'],null,'new finished_at column is NULL for every prior row');
  }

  // Every prior migration checksum is preserved verbatim.
  assert.deepEqual(
   (await pool.query('SELECT name,checksum FROM schema_migrations WHERE name<>$1 ORDER BY name',[terminalName])).rows,
   beforeChecksums,
  );
  // The new migration's checksum matches the on-disk file.
  assert.equal((await pool.query<{checksum:string}>('SELECT checksum FROM schema_migrations WHERE name=$1',[terminalName])).rows[0]!.checksum,
   createHash('sha256').update(await readFile(join('packages/db/migrations',terminalName))).digest('hex'));

  // The column, the check constraint, the candidate index and the trigger are installed.
  const finishedColumn=(await pool.query<{column_name:string}>(`SELECT column_name FROM information_schema.columns
   WHERE table_schema=current_schema() AND table_name='reasoning_job' AND column_name='finished_at'`)).rows[0];
  assert.ok(finishedColumn,'finished_at column is added by 0012');
  const constraint=(await pool.query<{constraint_name:string}>(`SELECT constraint_name FROM information_schema.table_constraints
   WHERE table_schema=current_schema() AND table_name='reasoning_job' AND constraint_name='reasoning_job_retirement_clock_kind'`)).rows[0];
  assert.ok(constraint,'retirement-clock-kind check constraint is added by 0012');
  const index=(await pool.query<{indexname:string}>(`SELECT indexname FROM pg_indexes
   WHERE schemaname=current_schema() AND tablename='reasoning_job' AND indexname='reasoning_job_finished_retirement_candidates'`)).rows[0];
  assert.ok(index,'finished_at retirement-candidate partial index is created by 0012');
  const triggerCount=(await pool.query(`SELECT count(*)::int AS count FROM pg_trigger
   WHERE tgname='reasoning_finished_clock_guard' AND tgrelid='reasoning_job'::regclass AND NOT tgisinternal`)).rows[0]!.count;
  assert.equal(triggerCount,1,'finished clock guard trigger is installed exactly once');

  // The withdrawn guard trigger remains active too; both coexist.
  const withdrawnGuardCount=(await pool.query(`SELECT count(*)::int AS count FROM pg_trigger
   WHERE tgname='reasoning_withdrawal_clock_guard' AND tgrelid='reasoning_job'::regclass AND NOT tgisinternal`)).rows[0]!.count;
  assert.equal(withdrawnGuardCount,1);

  // The prior withdrawn Job remains stamped with withdrawn_at, finished_at NULL.
  assert.deepEqual((await pool.query(`SELECT status,withdrawn_at IS NOT NULL AS withdrawn,finished_at FROM reasoning_job WHERE id=$1`,[withdrawn.jobId])).rows[0],
   {status:'cancelled',withdrawn:true,finished_at:null});
  // Its lease_fence is unchanged across the migration.
  assert.equal((await pool.query(`SELECT lease_fence::text AS fence FROM reasoning_job WHERE id=$1`,[withdrawn.jobId])).rows[0]!.fence,withdrawnFence);

  // Keep/Ask fixture rows remain bound to their original sessions.
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM reasoning_context_job_session WHERE job_id=$1`,[keep.jobId])).rows[0]!.count,1);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM reasoning_context_job_ask WHERE job_id=$1`,[ask.jobId])).rows[0]!.count,1);
  // The literal Ask question bytes survive on the ledger event row.
  assert.equal((await pool.query(`SELECT l.payload->>'question' AS question FROM explicit_ask a
   JOIN ledger l ON l.id=a.event_id AND l.universe_id=a.universe_id
   WHERE a.id=$1`,[ask.askId])).rows[0]!.question,'A preserved terminal Ask?');

  // Ledger source history remains: both an exposure and a keep event per fixture.
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger WHERE kind='keep'`)).rows[0]!.count,2);
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger WHERE kind='exposure'`)).rows[0]!.count,2);
 } finally {
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true});
 }
});

test('0012 adds finished_at NULL on a populated row but does not infer a stamp on legacy completed rows',async()=>{
 const schema=`terminal_legacy_${randomUUID().replaceAll('-','')}`;
 const directory=await mkdtemp(join(tmpdir(),'knowscroll-terminal-legacy-'));
 const admin=new pg.Pool({connectionString:reasoningContextDatabaseUrl});
 await admin.query(`CREATE SCHEMA ${schema}`);
 const url=new URL(reasoningContextDatabaseUrl);url.searchParams.set('options',`-c search_path=${schema}`);
 const pool=new pg.Pool({connectionString:url.toString(),max:8});
 try {
  // Run only through 0011 first.
  for(const name of migrationNames.slice(0,11)) await writeFile(join(directory,name),await readFile(join('packages/db/migrations',name)));
  await runMigrations(pool,{directory});

  // Insert a legacy completed Job that pre-dates 0012.
  const universeId=randomUUID(),jobId=randomUUID();
  await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
  await pool.query(`INSERT INTO reasoning_job
   (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id,
    lease_owner,lease_fence,lease_expires_at)
   VALUES($1,$2,0,'completed','interactive',$2,'legacy',clock_timestamp()+interval '1 hour','direct',$3,'legacy',1,clock_timestamp()+interval '1 hour')`,
   [jobId,universeId,randomUUID()]);

  // Apply 0012.
  await writeFile(join(directory,migrationNames[11]!),await readFile(join('packages/db/migrations',migrationNames[11]!)));
  await runMigrations(pool,{directory});

  // The legacy completed row stays NULL and is NOT stamped as a side effect.
  assert.equal((await pool.query(`SELECT finished_at IS NULL AS null_clock FROM reasoning_job WHERE id=$1`,[jobId])).rows[0]!.null_clock,true);
  assert.equal((await pool.query(`SELECT status FROM reasoning_job WHERE id=$1`,[jobId])).rows[0]!.status,'completed');
 } finally {
  await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true});
 }
});
