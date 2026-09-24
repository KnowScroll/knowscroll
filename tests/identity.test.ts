import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { authenticateAndLock, ensureDevelopmentSession, pool, provisionIdentity, transaction, UnauthorizedSession, OWNER_ID } from '../packages/db/src/index.ts';

if(!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Identity tests require an isolated knowscroll_test_* database');
after(async()=>pool.end());

test('provisions isolated identities and authenticates only the matching scope', async () => {
 const first=await provisionIdentity({expiresInHours:1});
 const second=await provisionIdentity({expiresInHours:1});
 assert.notEqual(first.scope.universeId,second.scope.universeId);
 const scope=await transaction(client=>authenticateAndLock(client,first.token));
 assert.deepEqual(scope,first.scope);
 const stored=(await pool.query('SELECT token_hash FROM device_session WHERE id=$1',[scope.sessionId])).rows[0].token_hash;
 assert.match(stored,/^[0-9a-f]{64}$/); assert.notEqual(stored,first.token);
 await assert.rejects(transaction(client=>authenticateAndLock(client,'unknown-token')),UnauthorizedSession);
});

test('explicit universe must exist and session scope follows its current epoch', async () => {
 await assert.rejects(provisionIdentity({universeId:randomUUID()}),/Universe not found/);
 const selected=await provisionIdentity({universeId:OWNER_ID,deviceId:randomUUID(),expiresInHours:1});
 // The owner universe is shared by the suite (account deletion advances its epoch): read the current one.
 const current=(await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1',[OWNER_ID])).rows[0].privacy_epoch;
 assert.equal(selected.scope.universeId,OWNER_ID); assert.equal(selected.scope.privacyEpoch,current);
});

test('development enrollment never extends or reactivates its session', async () => {
 const token='identity-test-development-token-123456';
 await ensureDevelopmentSession(token);
 const enrolled=await transaction(client=>authenticateAndLock(client,token));
 const before=(await pool.query('SELECT id,expires_at FROM device_session WHERE id=$1',[enrolled.sessionId])).rows[0];
 await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[before.id]);
 await ensureDevelopmentSession(token);
 const after=(await pool.query('SELECT expires_at,revoked_at FROM device_session WHERE id=$1',[before.id])).rows[0];
 assert.equal(after.expires_at.toISOString(),before.expires_at.toISOString()); assert.ok(after.revoked_at);
 await assert.rejects(transaction(client=>authenticateAndLock(client,token)),UnauthorizedSession);
});

test('expiry is evaluated after waiting for the universe lock', async () => {
 const provisioned=await provisionIdentity({expiresInHours:1});
 await pool.query("UPDATE device_session SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1",[provisioned.scope.sessionId]);
 const blocker=await pool.connect(); await blocker.query('BEGIN');
 const blockerPid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 await blocker.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[provisioned.scope.universeId]);
 const authClient=await pool.connect();await authClient.query('BEGIN');
 const authPid=(await authClient.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
 const auth=authenticateAndLock(authClient,provisioned.token);
 void auth.catch(()=>{});
 let blockerReleased=false;
 try {
  let blocked=false;
  for(let attempt=0;attempt<20;attempt++) {
   const blockers=(await pool.query('SELECT pg_blocking_pids($1) AS pids',[authPid])).rows[0].pids as number[];
   if(blockers.includes(blockerPid)) {blocked=true;break;}
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(blocked,true,'authentication must be waiting on the universe lock before expiry');
  await new Promise(resolve=>setTimeout(resolve,1_050));
  await blocker.query('COMMIT');blocker.release();blockerReleased=true;
  await assert.rejects(auth,UnauthorizedSession);
 } finally {
  if(!blockerReleased) {await blocker.query('ROLLBACK');blocker.release();}
  await auth.catch(()=>{});
   await authClient.query('ROLLBACK');authClient.release();
  }
});

test('privacy epoch advancement invalidates an already minted session', async () => {
 const provisioned=await provisionIdentity({expiresInHours:1});
 await pool.query('UPDATE universe SET privacy_epoch=privacy_epoch+1 WHERE id=$1',[provisioned.scope.universeId]);
 await assert.rejects(transaction(client=>authenticateAndLock(client,provisioned.token)),UnauthorizedSession);
});

async function withUpgradeSchema(name: string, fn: (client: import('pg').PoolClient) => Promise<void>): Promise<void> {
 const schema=`identity_upgrade_${name}_${randomUUID().replaceAll('-','')}`;
 const client=await pool.connect();
 try {
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await fn(client);
 } finally {
  await client.query('RESET search_path'); await client.query(`DROP SCHEMA ${schema} CASCADE`); client.release();
 }
}

test('0001 to 0002 preserves valid owner history and stamps epoch zero', async () => {
 const bootstrap=await readFile('packages/db/migrations/0001_bootstrap.sql','utf8');
 const identity=await readFile('packages/db/migrations/0002_identity_epochs.sql','utf8');
 await withUpgradeSchema('valid',async client=>{
  await client.query(bootstrap);
  const universe=randomUUID(), asset=randomUUID(), decision=randomUUID(), exposureEvent=randomUUID(), exposure=randomUUID(), keepEvent=randomUUID(), job=randomUUID();
  await client.query('INSERT INTO universe(id) VALUES($1)',[universe]);
  await client.query('INSERT INTO accounts(universe_id) VALUES($1)',[universe]);
  await client.query("INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order) VALUES($1,1,'Scroll','t','s','b','src','https://example.test','documented',1)",[asset]);
  await client.query("INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates) VALUES($1,$2,0,'p','[]')",[decision,universe]);
  await client.query("INSERT INTO ledger(id,universe_id,kind,client_key,payload) VALUES($1,$2,'exposure',$3,'{}')",[exposureEvent,universe,randomUUID()]);
  await client.query('INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key) VALUES($1,$2,$3,$4,$5,$6)',[exposure,universe,decision,asset,exposureEvent,randomUUID()]);
  await client.query("INSERT INTO ledger(id,universe_id,kind,client_key,causation_id,payload) VALUES($1,$2,'keep',$3,$4,$5)",[keepEvent,universe,randomUUID(),exposureEvent,JSON.stringify({assetId:asset})]);
  await client.query("INSERT INTO job(id,universe_id,event_id,kind) VALUES($1,$2,$3,'project_keep')",[job,universe,keepEvent]);
  await client.query('INSERT INTO trace(universe_id,asset_id,event_id) VALUES($1,$2,$3)',[universe,asset,keepEvent]);
  await client.query(identity);
  const rows=await client.query('SELECT (SELECT count(*) FROM ledger)::int AS events,(SELECT count(*) FROM trace)::int AS traces,(SELECT privacy_epoch FROM job WHERE id=$1)::int AS epoch',[job]);
  assert.deepEqual(rows.rows[0],{events:2,traces:1,epoch:0});
 });
});

test('0002 rejects incompatible cross-universe history without rewriting it', async () => {
 const bootstrap=await readFile('packages/db/migrations/0001_bootstrap.sql','utf8');
 const identity=await readFile('packages/db/migrations/0002_identity_epochs.sql','utf8');
 await withUpgradeSchema('invalid',async client=>{
  await client.query(bootstrap);
  const first=randomUUID(), second=randomUUID(), asset=randomUUID(), decision=randomUUID(), event=randomUUID(), exposure=randomUUID();
  await client.query('INSERT INTO universe(id) VALUES($1),($2)',[first,second]);
  await client.query('INSERT INTO accounts(universe_id) VALUES($1),($2)',[first,second]);
  await client.query("INSERT INTO asset(id,revision,kind,title,summary,body,source_title,source_url,truth_state,editorial_order) VALUES($1,1,'Scroll','t','s','b','src','https://example.test','documented',1)",[asset]);
  await client.query("INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates) VALUES($1,$2,0,'p','[]')",[decision,first]);
  await client.query("INSERT INTO ledger(id,universe_id,kind,client_key,payload) VALUES($1,$2,'exposure',$3,'{}')",[event,second,randomUUID()]);
  await client.query('INSERT INTO exposure(id,universe_id,decision_id,asset_id,event_id,client_key) VALUES($1,$2,$3,$4,$5,$6)',[exposure,first,decision,asset,event,randomUUID()]);
  await client.query('BEGIN');
  await assert.rejects(client.query(identity),/violates foreign key constraint/);
  await client.query('ROLLBACK');
  assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='universe' AND column_name='privacy_epoch'")).rows[0].n,0);
  assert.equal((await client.query('SELECT universe_id FROM exposure WHERE id=$1',[exposure])).rows[0].universe_id,first);
 });
});
