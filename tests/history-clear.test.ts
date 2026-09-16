import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { buildApp } from '../apps/api/src/app.ts';
import { projectOne } from '../apps/worker/src/project.ts';
import { pool, provisionIdentity } from '../packages/db/src/index.ts';

if(!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('History clear tests require an isolated knowscroll_test_* database');
const developmentToken='history-clear-development-token-123456';
const app=buildApp(developmentToken);
await app.ready();
after(async()=>{await app.close();await pool.end();});

type Identity=Awaited<ReturnType<typeof provisionIdentity>>;
const headers=(token:string)=>({authorization:`Bearer ${token}`});

async function createHistory(identity:Identity,project=true):Promise<{eventId:string;jobId:string;decisionId:string}> {
 const feedResponse=await app.inject({url:'/v1/feed',headers:headers(identity.token)});
 assert.equal(feedResponse.statusCode,200);
 const feed=feedResponse.json(), item=feed.items[0];
 const exposureResponse=await app.inject({method:'POST',url:'/v1/exposures',headers:headers(identity.token),payload:{decisionId:feed.decisionId,assetId:item.assetId,clientExposureId:randomUUID()}});
 assert.equal(exposureResponse.statusCode,201);
 const exposure=exposureResponse.json();
 const keepResponse=await app.inject({method:'POST',url:'/v1/interactions',headers:headers(identity.token),payload:{clientEventId:randomUUID(),exposureId:exposure.exposureId,assetId:item.assetId,kind:'keep'}});
 assert.equal(keepResponse.statusCode,202);
 const keep=keepResponse.json();
 await pool.query("UPDATE job SET available_at='1990-01-01T00:00:00Z' WHERE id=$1",[keep.jobId]);
 if(project) assert.deepEqual(await projectOne(),{jobId:keep.jobId,status:'completed'});
 return {eventId:keep.eventId,jobId:keep.jobId,decisionId:feed.decisionId};
}

async function scopedCounts(universeId:string) {
 return (await pool.query(`SELECT
  (SELECT count(*)::int FROM decision WHERE universe_id=$1) decisions,
  (SELECT count(*)::int FROM exposure WHERE universe_id=$1) exposures,
  (SELECT count(*)::int FROM ledger WHERE universe_id=$1) events,
  (SELECT count(*)::int FROM job WHERE universe_id=$1) jobs,
  (SELECT count(*)::int FROM trace WHERE universe_id=$1) traces`,[universeId])).rows[0];
}

async function clear(identity:Identity,body:{requestId:string;expectedPrivacyEpoch:number;confirmation:string}) {
 return app.inject({method:'POST',url:'/v1/history/clear',headers:headers(identity.token),payload:body});
}

test('clears one nonempty history, rolls only caller, and exact replay preserves later activity',async()=>{
 const owner=await provisionIdentity({expiresInHours:2});
 const otherDevice=await provisionIdentity({universeId:owner.scope.universeId,expiresInHours:2});
 const neighbor=await provisionIdentity({expiresInHours:2});
 await createHistory(owner);await createHistory(neighbor);
 const assetsBefore=Number((await pool.query('SELECT count(*) FROM asset')).rows[0].count);
 const neighborBefore=await scopedCounts(neighbor.scope.universeId);
 const accountBefore=(await pool.query('SELECT revision FROM accounts WHERE universe_id=$1',[owner.scope.universeId])).rows[0].revision;
 const universeBefore=(await pool.query('SELECT revision FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0].revision;
 const expiryBefore=(await pool.query('SELECT expires_at FROM device_session WHERE id=$1',[owner.scope.sessionId])).rows[0].expires_at.toISOString();
 const body={requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'};
 const response=await clear(owner,body);assert.equal(response.statusCode,200);
 const receipt=response.json();assert.equal(receipt.privacyEpoch,1);assert.match(receipt.clearedAt,/Z$/);
 assert.deepEqual(await scopedCounts(owner.scope.universeId),{decisions:0,exposures:0,events:0,jobs:0,traces:0});
 assert.deepEqual(await scopedCounts(neighbor.scope.universeId),neighborBefore);
 assert.equal(Number((await pool.query('SELECT count(*) FROM asset')).rows[0].count),assetsBefore);
 const state=(await pool.query('SELECT revision,privacy_epoch FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0];
 assert.equal(state.privacy_epoch,1);assert.equal(state.revision,universeBefore+1);
 const clearedAccount=(await pool.query('SELECT revision,cardinality(kept_asset_ids) kept FROM accounts WHERE universe_id=$1',[owner.scope.universeId])).rows[0];
 assert.equal(clearedAccount.revision,accountBefore+1);assert.equal(clearedAccount.kept,0);
 assert.equal((await pool.query('SELECT expires_at,privacy_epoch FROM device_session WHERE id=$1',[owner.scope.sessionId])).rows[0].expires_at.toISOString(),expiryBefore);
 assert.equal((await app.inject({url:'/v1/universe',headers:headers(otherDevice.token)})).statusCode,401);
 assert.equal((await app.inject({url:'/v1/universe',headers:headers(owner.token)})).statusCode,200);

 await createHistory({...owner,scope:{...owner.scope,privacyEpoch:1}});
 const laterCounts=await scopedCounts(owner.scope.universeId);
 const replay=await clear(owner,body);assert.equal(replay.statusCode,200);assert.equal(replay.body,response.body);
 assert.deepEqual(await scopedCounts(owner.scope.universeId),laterCounts,'old receipt replay must not clear later data');
 const conflict=await clear(owner,{...body,expectedPrivacyEpoch:1});assert.equal(conflict.statusCode,409);
 const unknownWrong=await clear(owner,{...body,requestId:randomUUID(),expectedPrivacyEpoch:0});assert.equal(unknownWrong.statusCode,409);
});

test('auth precedes strict validation and malformed input changes nothing',async()=>{
 const owner=await provisionIdentity({expiresInHours:1});await createHistory(owner);
 const before=await scopedCounts(owner.scope.universeId);
 const payload={requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history',extra:true};
 const unauthenticated=await app.inject({method:'POST',url:'/v1/history/clear',payload});
 assert.equal(unauthenticated.statusCode,401);
 const malformed=await app.inject({method:'POST',url:'/v1/history/clear',headers:headers(owner.token),payload});
 assert.equal(malformed.statusCode,400);assert.deepEqual(await scopedCounts(owner.scope.universeId),before);
 assert.equal((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0].privacy_epoch,0);
});

test('concurrent identical keys replay once and distinct keys from one epoch cannot both clear',async()=>{
 const same=await provisionIdentity({expiresInHours:1});await createHistory(same);
 const body={requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'};
 const identical=await Promise.all([clear(same,body),clear(same,body)]);
 assert.deepEqual(identical.map(r=>r.statusCode),[200,200]);assert.equal(identical[0]!.body,identical[1]!.body);
 assert.equal((await pool.query('SELECT count(*)::int n FROM history_clear_receipt WHERE universe_id=$1',[same.scope.universeId])).rows[0].n,1);

 const distinct=await provisionIdentity({expiresInHours:1});await createHistory(distinct);
 const requests=[randomUUID(),randomUUID()].map(requestId=>clear(distinct,{requestId,expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'}));
 const outcomes=await Promise.all(requests);
 assert.deepEqual(outcomes.map(r=>r.statusCode).sort(),[200,409]);
 assert.equal((await pool.query('SELECT count(*)::int n FROM history_clear_receipt WHERE universe_id=$1',[distinct.scope.universeId])).rows[0].n,1);
});

test('clear waits for prior admission and removes what committed before it',async()=>{
 const owner=await provisionIdentity({expiresInHours:1});
 const blocker=await pool.connect();await blocker.query('BEGIN');
 await blocker.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[owner.scope.universeId]);
 const decisionId=randomUUID();
 await blocker.query("INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'test','[]',0)",[decisionId,owner.scope.universeId]);
 const pending=clear(owner,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});
 void pending.catch(()=>{});
 try {
  const early=await Promise.race([pending.then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);
  assert.equal(early,false,'clear must wait for the universe lock');
 } finally {await blocker.query('COMMIT');blocker.release();}
 const response=await pending;assert.equal(response.statusCode,200);
 assert.equal((await pool.query('SELECT count(*)::int n FROM decision WHERE id=$1',[decisionId])).rows[0].n,0);
});

test('clear waits for a real worker commit and then erases its projection',async()=>{
 const owner=await provisionIdentity({expiresInHours:1});const history=await createHistory(owner,false);
 await pool.query(`CREATE FUNCTION delay_history_clear_worker() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.universe_id='${owner.scope.universeId}'::uuid THEN PERFORM pg_sleep(0.35); END IF; RETURN NEW; END $$`);
 await pool.query('CREATE TRIGGER delay_history_clear_worker BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION delay_history_clear_worker()');
 const projection=projectOne();void projection.catch(()=>{});
 try {
  let running=false;
  for(let i=0;i<30;i++) {
   const n=(await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE query LIKE 'UPDATE accounts SET revision=revision+1,%' AND wait_event='PgSleep'")).rows[0].n;
   if(n>0){running=true;break;} await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(running,true,'worker must hold the universe lock before clear starts');
  const pending=clear(owner,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});void pending.catch(()=>{});
  assert.deepEqual(await projection,{jobId:history.jobId,status:'completed'});
  const response=await pending;assert.equal(response.statusCode,200);
 } finally {
  await projection.catch(()=>{});
  await pool.query('DROP TRIGGER IF EXISTS delay_history_clear_worker ON accounts');
  await pool.query('DROP FUNCTION IF EXISTS delay_history_clear_worker()');
 }
 assert.deepEqual(await scopedCounts(owner.scope.universeId),{decisions:0,exposures:0,events:0,jobs:0,traces:0});
});

test('mid-clear database failure rolls back epoch, session, revisions and every deletion',async()=>{
 const owner=await provisionIdentity({expiresInHours:1});await createHistory(owner);
 const before=await scopedCounts(owner.scope.universeId);
 const universe=(await pool.query('SELECT revision,privacy_epoch FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0];
 const account=(await pool.query('SELECT revision,kept_asset_ids FROM accounts WHERE universe_id=$1',[owner.scope.universeId])).rows[0];
 await pool.query(`CREATE FUNCTION reject_history_clear() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF OLD.universe_id='${owner.scope.universeId}'::uuid THEN RAISE EXCEPTION 'forced clear rollback'; END IF; RETURN OLD; END $$`);
 await pool.query('CREATE TRIGGER reject_history_clear BEFORE DELETE ON decision FOR EACH ROW EXECUTE FUNCTION reject_history_clear()');
 let response;
 try {response=await clear(owner,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});}
 finally {await pool.query('DROP TRIGGER reject_history_clear ON decision');await pool.query('DROP FUNCTION reject_history_clear()');}
 assert.equal(response!.statusCode,500);assert.deepEqual(await scopedCounts(owner.scope.universeId),before);
 assert.deepEqual((await pool.query('SELECT revision,privacy_epoch FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0],universe);
 const afterAccount=(await pool.query('SELECT revision,kept_asset_ids FROM accounts WHERE universe_id=$1',[owner.scope.universeId])).rows[0];
 assert.equal(afterAccount.revision,account.revision);assert.deepEqual(afterAccount.kept_asset_ids,account.kept_asset_ids);
 assert.equal((await pool.query('SELECT privacy_epoch FROM device_session WHERE id=$1',[owner.scope.sessionId])).rows[0].privacy_epoch,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM history_clear_receipt WHERE universe_id=$1',[owner.scope.universeId])).rows[0].n,0);
});

test('maximum epoch overflow fails transactionally without clearing or rolling session',async()=>{
 const owner=await provisionIdentity({expiresInHours:1});await createHistory(owner);
 const max=2147483647;
 await pool.query('UPDATE universe SET privacy_epoch=$2 WHERE id=$1',[owner.scope.universeId,max]);
 await pool.query('UPDATE device_session SET privacy_epoch=$2 WHERE id=$1',[owner.scope.sessionId,max]);
 const before=await scopedCounts(owner.scope.universeId);
 const response=await clear(owner,{requestId:randomUUID(),expectedPrivacyEpoch:max,confirmation:'clear-scroll-history'});
 assert.equal(response.statusCode,500);assert.deepEqual(await scopedCounts(owner.scope.universeId),before);
 assert.equal((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0].privacy_epoch,max);
 assert.equal((await pool.query('SELECT privacy_epoch FROM device_session WHERE id=$1',[owner.scope.sessionId])).rows[0].privacy_epoch,max);
 assert.equal((await pool.query('SELECT count(*)::int n FROM history_clear_receipt WHERE universe_id=$1',[owner.scope.universeId])).rows[0].n,0);
});

test('receipt schema retains only retry metadata',async()=>{
 const columns=(await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='history_clear_receipt' ORDER BY ordinal_position")).rows.map(row=>row.column_name);
 assert.deepEqual(columns,['id','universe_id','request_id','epoch_before','epoch_after','cleared_at']);
});
