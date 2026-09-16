import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {after,test} from 'node:test';

import {buildApp} from '../apps/api/src/app.ts';
import {authenticateAndLock,pool,provisionIdentity,transaction} from '../packages/db/src/index.ts';
import {recordExplicitAsk} from '../packages/db/src/explicit-ask.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {compileDirectContext} from '../packages/db/src/reasoning-context.ts';
import {ReasoningDenied} from '../packages/db/src/reasoning-runtime-policy.ts';

if(!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Explicit Ask privacy tests require an isolated knowscroll_test_* database');
const app=buildApp(randomBytes(32).toString('hex'));
await app.ready();
after(async()=>{await app.close();await pool.end();});

type Identity=Awaited<ReturnType<typeof provisionIdentity>>;
type Exposure={decisionId:string;assetId:string;exposureId:string;eventId:string};
type AskBody={clientAskId:string;exposureId:string;expectedPrivacyEpoch:number;question:string};

const headers=(token:string)=>({authorization:`Bearer ${token}`});

async function expose(identity:Identity):Promise<Exposure> {
 const feed=await app.inject({url:'/v1/feed',headers:headers(identity.token)});
 assert.equal(feed.statusCode,200,feed.body);
 const value=feed.json(),assetId=String(value.items[0]!.assetId);
 const response=await app.inject({method:'POST',url:'/v1/exposures',headers:headers(identity.token),
  payload:{decisionId:value.decisionId,assetId,clientExposureId:randomUUID()}});
 assert.equal(response.statusCode,201,response.body);
 return {decisionId:value.decisionId,assetId,exposureId:response.json().exposureId,eventId:response.json().eventId};
}

const ask=(identity:Identity,body:AskBody)=>app.inject({method:'POST',url:'/v1/asks',headers:headers(identity.token),payload:body});
const clear=(identity:Identity,requestId:string,expectedPrivacyEpoch=identity.scope.privacyEpoch)=>app.inject({
 method:'POST',url:'/v1/history/clear',headers:headers(identity.token),
 payload:{requestId,expectedPrivacyEpoch,confirmation:'clear-scroll-history'},
});

async function askRows(universeId:string) {
 return (await pool.query(`SELECT a.id AS ask_id,a.event_id,a.session_id,a.client_ask_id,a.exposure_id,a.privacy_epoch,
  l.client_key,l.causation_id,l.payload FROM explicit_ask a JOIN ledger l ON l.id=a.event_id
  WHERE a.universe_id=$1 ORDER BY a.id`,[universeId])).rows;
}

async function noWorkSnapshot(universeId:string) {
 return (await pool.query(`SELECT
  (SELECT row_to_json(a) FROM (SELECT revision,kept_asset_ids FROM accounts WHERE universe_id=$1) a) account,
  (SELECT count(*)::int FROM job WHERE universe_id=$1) projection_jobs,
  (SELECT count(*)::int FROM reasoning_job WHERE universe_id=$1) reasoning_jobs,
  (SELECT count(*)::int FROM reasoning_accounting WHERE universe_id=$1) accounting,
  (SELECT count(*)::int FROM trace WHERE universe_id=$1) traces`,[universeId])).rows[0];
}

async function waitForBlockedRequest(blockerPid:number):Promise<void> {
 const deadline=Date.now()+2_000;
 while(Date.now()<deadline) {
  const blocked=(await pool.query(`SELECT 1 FROM pg_stat_activity
   WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`,[blockerPid])).rowCount;
  if(blocked) return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('Ask request never waited on the held universe lock');
}

test('explicit Ask records one literal fact with session-scoped replay and no execution authority',async()=>{
 const owner=await provisionIdentity(),source=await expose(owner),clientAskId=randomUUID();
 const question='  e\u0301\r\nWhy does this change?  ';
 const body={clientAskId,exposureId:source.exposureId,expectedPrivacyEpoch:0,question};
 const before=await noWorkSnapshot(owner.scope.universeId);
 const first=await ask(owner,body);
 assert.equal(first.statusCode,201,first.body);
 assert.deepEqual(Object.keys(first.json()).sort(),['askId','eventId','status']);
 assert.equal(first.json().status,'recorded_only');
 assert.deepEqual(await noWorkSnapshot(owner.scope.universeId),before);
 const rows=await askRows(owner.scope.universeId);
 assert.equal(rows.length,1);
 assert.equal(rows[0]!.ask_id,first.json().askId);
 assert.equal(rows[0]!.event_id,first.json().eventId);
 assert.equal(rows[0]!.session_id,owner.scope.sessionId);
 assert.equal(rows[0]!.client_ask_id,clientAskId);
 assert.equal(rows[0]!.exposure_id,source.exposureId);
 assert.equal(rows[0]!.causation_id,source.eventId);
 assert.equal(rows[0]!.payload.question,question);
 assert.equal(JSON.stringify(rows[0]!.payload).includes(owner.token),false);

 const replay=await ask(owner,body);
 assert.equal(replay.statusCode,201,replay.body);
 assert.deepEqual(replay.json(),first.json());
 assert.equal((await askRows(owner.scope.universeId)).length,1);
 assert.equal((await ask(owner,{...body,question:`${question}!`})).statusCode,409);
 const otherSource=await expose(owner);
 assert.equal((await ask(owner,{...body,exposureId:otherSource.exposureId})).statusCode,409);

 const peer=await provisionIdentity({universeId:owner.scope.universeId});
 const peerAsk=await ask(peer,body);
 assert.equal(peerAsk.statusCode,201,peerAsk.body);
 assert.notEqual(peerAsk.json().askId,first.json().askId);
 assert.notEqual(peerAsk.json().eventId,first.json().eventId);
 const two=await askRows(owner.scope.universeId);
 assert.equal(two.length,2);
 assert.notEqual(two[0]!.client_key,two[1]!.client_key);
 const event=await app.inject({url:`/v1/events/${first.json().eventId}`,headers:headers(owner.token)});
 assert.equal(event.statusCode,200,event.body);
 assert.equal(Object.hasOwn(event.json(),'payload'),false);
 assert.equal(event.body.includes(question),false);
});

test('explicit Ask enforces decoded UTF-8 bytes while preserving every accepted literal byte',async()=>{
 const owner=await provisionIdentity(),source=await expose(owner);
 const invalidQuestions=[' \t\r\n\u2003','\0','\uD800','\uDC00','😀'.repeat(1025),'a'.repeat(4097)];
 for(const question of invalidQuestions) {
  const response=await ask(owner,{clientAskId:randomUUID(),exposureId:source.exposureId,expectedPrivacyEpoch:0,question});
  assert.equal(response.statusCode,400,JSON.stringify({questionLength:question.length,body:response.body}));
 }
 const extra=await app.inject({method:'POST',url:'/v1/asks',headers:headers(owner.token),payload:{
  clientAskId:randomUUID(),exposureId:source.exposureId,expectedPrivacyEpoch:0,question:'Literal?',assetId:source.assetId,
 }});
 assert.equal(extra.statusCode,400,extra.body);

 const emoji='😀'.repeat(1024),emojiResponse=await ask(owner,{clientAskId:randomUUID(),exposureId:source.exposureId,expectedPrivacyEpoch:0,question:emoji});
 assert.equal(emojiResponse.statusCode,201,emojiResponse.body);
 assert.equal((await pool.query('SELECT payload->>\'question\' AS question FROM ledger WHERE id=$1',[emojiResponse.json().eventId])).rows[0]!.question,emoji);

 const clientAskId=randomUUID();
 const escaped=`{"clientAskId":"${clientAskId}","exposureId":"${source.exposureId}","expectedPrivacyEpoch":0,"question":"${'\\u0061'.repeat(4096)}"}`;
 assert(escaped.length>16_384&&escaped.length<32_768);
 const escapedResponse=await app.inject({method:'POST',url:'/v1/asks',headers:{...headers(owner.token),'content-type':'application/json'},payload:escaped});
 assert.equal(escapedResponse.statusCode,201,escapedResponse.body);
 assert.equal((await pool.query('SELECT payload->>\'question\' AS question FROM ledger WHERE id=$1',[escapedResponse.json().eventId])).rows[0]!.question,'a'.repeat(4096));
});

test('Clear History rollback, success, stale Ask retry and old-clear replay preserve their exact privacy boundaries',async()=>{
 const owner=await provisionIdentity(),source=await expose(owner),other=await provisionIdentity(),otherSource=await expose(other);
 const body={clientAskId:randomUUID(),exposureId:source.exposureId,expectedPrivacyEpoch:0,question:'Why this source?'};
 const otherBody={clientAskId:randomUUID(),exposureId:otherSource.exposureId,expectedPrivacyEpoch:0,question:'Unrelated private question'};
 const recorded=await ask(owner,body),otherRecorded=await ask(other,otherBody);
 assert.equal(recorded.statusCode,201,recorded.body);assert.equal(otherRecorded.statusCode,201,otherRecorded.body);
 await pool.query(`CREATE FUNCTION reject_ask_clear() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF OLD.universe_id='${owner.scope.universeId}'::uuid THEN RAISE EXCEPTION 'forced Ask clear rollback'; END IF; RETURN OLD; END $$`);
 await pool.query('CREATE TRIGGER reject_ask_clear BEFORE DELETE ON decision FOR EACH ROW EXECUTE FUNCTION reject_ask_clear()');
 const failedRequest=randomUUID();
 try {assert.equal((await clear(owner,failedRequest)).statusCode,500);}
 finally {await pool.query('DROP TRIGGER reject_ask_clear ON decision');await pool.query('DROP FUNCTION reject_ask_clear()');}
 assert.equal((await askRows(owner.scope.universeId)).length,1);
 assert.equal((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0]!.privacy_epoch,0);

 const clearRequest=randomUUID(),cleared=await clear(owner,clearRequest);
 assert.equal(cleared.statusCode,200,cleared.body);
 assert.equal((await askRows(owner.scope.universeId)).length,0);
 assert.equal((await askRows(other.scope.universeId)).length,1);
 assert.equal((await ask(owner,body)).statusCode,409,'expected epoch must fail before a deleted idempotency key can write');
 assert.equal((await askRows(owner.scope.universeId)).length,0);

 const laterSource=await expose({...owner,scope:{...owner.scope,privacyEpoch:1}}),laterBody={
  clientAskId:randomUUID(),exposureId:laterSource.exposureId,expectedPrivacyEpoch:1,question:'A later question',
 };
 const later=await ask(owner,laterBody);assert.equal(later.statusCode,201,later.body);
 const replay=await clear(owner,clearRequest,0);
 assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json(),cleared.json());
 assert.equal((await askRows(owner.scope.universeId)).length,1);
 assert.equal((await askRows(owner.scope.universeId))[0]!.ask_id,later.json().askId);
});

test('Ask admission and Clear History serialize in both commit orders without resurrection',async t=>{
 await t.test('an Ask that wins first is committed and then erased by the waiting clear',async()=>{
  const owner=await provisionIdentity(),source=await expose(owner),body={clientAskId:randomUUID(),exposureId:source.exposureId,expectedPrivacyEpoch:0,question:'Race before clear?'};
  const askClient=await pool.connect();let transactionOpen=true;
  try {
   await askClient.query('BEGIN');
   const authenticated=await authenticateAndLock(askClient,owner.token);
   const recorded=await recordExplicitAsk(askClient,authenticated,body);
   assert.equal(recorded.status,'recorded_only');
   const blockerPid=Number((await askClient.query('SELECT pg_backend_pid() pid')).rows[0]!.pid);
   const pendingClear=clear(owner,randomUUID());void pendingClear.catch(()=>{});
   await waitForBlockedRequest(blockerPid);
   await askClient.query('COMMIT');transactionOpen=false;
   const erased=await pendingClear;assert.equal(erased.statusCode,200,erased.body);
  } finally {
   if(transactionOpen) await askClient.query('ROLLBACK');
   askClient.release();
  }
  assert.equal((await askRows(owner.scope.universeId)).length,0);
 });

 await t.test('a clear that wins first makes the waiting old-epoch Ask a conflict',async()=>{
  const owner=await provisionIdentity(),source=await expose(owner),body={clientAskId:randomUUID(),exposureId:source.exposureId,expectedPrivacyEpoch:0,question:'Race after clear?'};
  const clearClient=await pool.connect();let transactionOpen=true;
  try {
   await clearClient.query('BEGIN');
   const authenticated=await authenticateAndLock(clearClient,owner.token),requestId=randomUUID();
   const receipt=await clearScrollHistory(clearClient,authenticated,{requestId,expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});
   assert.equal(receipt.privacyEpoch,1);
   const blockerPid=Number((await clearClient.query('SELECT pg_backend_pid() pid')).rows[0]!.pid);
   const pendingAsk=ask(owner,body);void pendingAsk.catch(()=>{});
   await waitForBlockedRequest(blockerPid);
   await clearClient.query('COMMIT');transactionOpen=false;
   const refused=await pendingAsk;assert.equal(refused.statusCode,409,refused.body);
  } finally {
   if(transactionOpen) await clearClient.query('ROLLBACK');
   clearClient.release();
  }
  assert.equal((await askRows(owner.scope.universeId)).length,0);
 });
});

test('expiry and revocation committed during a universe-lock wait deny Ask before replay or write',async t=>{
 await t.test('expiry after request start returns generic unauthorized',async()=>{
  const owner=await provisionIdentity(),source=await expose(owner),body={clientAskId:randomUUID(),exposureId:source.exposureId,expectedPrivacyEpoch:0,question:'Too late?'};
  await pool.query("UPDATE device_session SET created_at=clock_timestamp()-interval '1 second',expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[owner.scope.sessionId]);
  const blocker=await pool.connect();
  try {
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[owner.scope.universeId]);
   const pid=Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0]!.pid);
   const pending=ask(owner,body);void pending.catch(()=>{});await waitForBlockedRequest(pid);
   const expiresAt=(await pool.query('SELECT expires_at FROM device_session WHERE id=$1',[owner.scope.sessionId])).rows[0]!.expires_at;
   while(!(await pool.query('SELECT clock_timestamp()>=$1 AS expired',[expiresAt])).rows[0]!.expired) await new Promise(resolve=>setTimeout(resolve,10));
   await blocker.query('COMMIT');
   const response=await pending;assert.equal(response.statusCode,401,response.body);assert.deepEqual(response.json(),{error:'Unauthorized'});
  } finally {await blocker.query('ROLLBACK');blocker.release();}
  assert.equal((await askRows(owner.scope.universeId)).length,0);
 });

 await t.test('revocation committed by the lock holder returns generic unauthorized',async()=>{
  const owner=await provisionIdentity(),source=await expose(owner),body={clientAskId:randomUUID(),exposureId:source.exposureId,expectedPrivacyEpoch:0,question:'Revoked while waiting?'};
  const blocker=await pool.connect();
  try {
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM universe WHERE id=$1 FOR UPDATE',[owner.scope.universeId]);
   await blocker.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[owner.scope.sessionId]);
   const pid=Number((await blocker.query('SELECT pg_backend_pid() pid')).rows[0]!.pid);
   const pending=ask(owner,body);void pending.catch(()=>{});await waitForBlockedRequest(pid);
   await blocker.query('COMMIT');
   const response=await pending;assert.equal(response.statusCode,401,response.body);assert.deepEqual(response.json(),{error:'Unauthorized'});
  } finally {await blocker.query('ROLLBACK');blocker.release();}
  assert.equal((await askRows(owner.scope.universeId)).length,0);
 });
});

test('foreign or stale sources refuse and Ask cannot masquerade as V1 Keep evidence',async()=>{
 const owner=await provisionIdentity(),source=await expose(owner),foreign=await provisionIdentity();
 const body={clientAskId:randomUUID(),exposureId:source.exposureId,expectedPrivacyEpoch:0,question:'What follows?'};
 assert.equal((await ask(foreign,{...body,clientAskId:randomUUID()})).statusCode,422);
 assert.equal((await ask(owner,{...body,clientAskId:randomUUID(),exposureId:randomUUID()})).statusCode,422);
 assert.equal((await ask(owner,{...body,clientAskId:randomUUID(),exposureId:randomUUID(),expectedPrivacyEpoch:1})).statusCode,409,
  'epoch conflict must precede source lookup');

 const event=(await pool.query('SELECT payload FROM ledger WHERE id=$1',[source.eventId])).rows[0]!;
 await pool.query("UPDATE ledger SET payload=jsonb_set(payload,'{assetId}',to_jsonb($2::text)) WHERE id=$1",[source.eventId,randomUUID()]);
 try {assert.equal((await ask(owner,{...body,clientAskId:randomUUID()})).statusCode,422);}
 finally {await pool.query('UPDATE ledger SET payload=$2 WHERE id=$1',[source.eventId,event.payload]);}

 const recorded=await ask(owner,body);assert.equal(recorded.statusCode,201,recorded.body);
 const jobId=randomUUID(),contextId=randomUUID();
 await pool.query(`INSERT INTO reasoning_job(id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
  VALUES($1,$2,0,'queued','interactive',$2,'ask-context-refusal',clock_timestamp()+interval '1 hour','direct',$3)`,
  [jobId,owner.scope.universeId,randomUUID()]);
 await assert.rejects(transaction(async client=>{
  const authenticated=await authenticateAndLock(client,owner.token);
  return compileDirectContext(client,authenticated,{contextId,jobId,keepEventIds:[recorded.json().eventId]},async()=>{
   throw new Error('Ask-as-Keep refusal must precede policy resolution');
  });
 }),error=>error instanceof ReasoningDenied&&error.code==='context_stale_lineage');
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_context WHERE id=$1',[contextId])).rows[0]!.n,0);
});
