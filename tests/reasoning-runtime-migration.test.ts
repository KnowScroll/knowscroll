import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import pg from 'pg';
import {runMigrations} from '../packages/db/src/migrations.ts';
const url=process.env.DATABASE_URL!;
if(!new URL(url).pathname.startsWith('/knowscroll_test_')) throw new Error('Disposable test database required');
test('0005 preserves populated 0004 accounting and enforces immutable interpretation',async()=>{
 const schema='runtime_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:url});
 const directory=await mkdtemp(join(tmpdir(),'knowscroll-runtime-'));
 await admin.query(`CREATE SCHEMA ${schema}`);
 const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);
 const db=new pg.Pool({connectionString:scoped.toString()});
 const names=['0001_bootstrap.sql','0002_identity_epochs.sql','0003_history_clear.sql','0004_reasoning_storage.sql','0005_reasoning_runtime.sql'];
 try {
  for(const name of names.slice(0,4)) await writeFile(join(directory,name),await readFile(join('packages/db/migrations',name)));
  await runMigrations(db,{directory});
  const universe=randomUUID(),attempt=randomUUID(),permit=randomUUID(),set=randomUUID(),bucket=randomUUID();
  await db.query('INSERT INTO universe(id) VALUES($1)',[universe]);
  await db.query(`INSERT INTO reasoning_accounting(attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline) VALUES($1,$2,0,$3,'route','profile',100,clock_timestamp()+interval '1 hour')`,[attempt,universe,randomUUID()]);
  await db.query(`INSERT INTO reasoning_bucket(id,dimension,unit,capacity) VALUES($1,'global_budget','tokens',1000)`,[bucket]);
  await db.query(`INSERT INTO reasoning_permit(id,attempt_id,universe_id,privacy_epoch,reservation_set_id,expires_at) VALUES($1,$2,$3,0,$4,clock_timestamp()+interval '1 hour')`,[permit,attempt,universe,set]);
  await db.query(`INSERT INTO reasoning_reservation(id,attempt_id,reservation_set_id,bucket_id,dimension,unit,amount) VALUES($1,$2,$3,$4,'global_budget','tokens',100)`,[randomUUID(),attempt,set,bucket]);
  const before=(await db.query('SELECT * FROM reasoning_accounting')).rows;
  const prior=(await db.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  await writeFile(join(directory,names[4]!),await readFile(join('packages/db/migrations',names[4]!)));
  assert.deepEqual((await runMigrations(db,{directory})).applied,[names[4]]);
  assert.deepEqual(await runMigrations(db,{directory}),{applied:[],adopted:[]});
  const after=(await db.query('SELECT * FROM reasoning_accounting')).rows.map(({binding_hash,runtime_policy_version,price_basis,review_required,...old})=>{
   assert.equal(binding_hash,null);assert.equal(runtime_policy_version,null);assert.equal(price_basis,null);assert.equal(review_required,false);return old;
  });
  assert.deepEqual(after,before);
  const migrations=(await db.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
  assert.deepEqual(migrations.slice(0,4),prior);
  for(const [i,name] of names.entries()) assert.equal(migrations[i].checksum,createHash('sha256').update(await readFile(join('packages/db/migrations',name))).digest('hex'));
  await assert.rejects(db.query('UPDATE reasoning_accounting SET binding_hash=$2,runtime_policy_version=$3 WHERE attempt_id=$1',[attempt,'a'.repeat(64),'v1']),/immutable/);
  await assert.rejects(db.query("UPDATE reasoning_reservation SET usage_basis='input_tokens',handling='budget' WHERE attempt_id=$1",[attempt]),/immutable/);
  await assert.rejects(db.query('UPDATE reasoning_reservation SET recognized=1 WHERE attempt_id=$1',[attempt]));
  await db.query('UPDATE reasoning_reservation SET recognized=10,usage_known=true WHERE attempt_id=$1',[attempt]);
  await assert.rejects(db.query('UPDATE reasoning_reservation SET recognized=9 WHERE attempt_id=$1',[attempt]),/cannot decrease/);
  await assert.rejects(db.query('UPDATE reasoning_reservation SET usage_known=false WHERE attempt_id=$1',[attempt]),/cannot become unknown/);
 } finally {await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();await rm(directory,{recursive:true});}
});
