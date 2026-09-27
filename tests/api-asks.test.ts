import {after, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';

import {buildApp} from '../apps/api/src/app.ts';
import {pool, provisionIdentity} from '../packages/db/src/index.ts';

if(!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) {
  throw new Error('Ask API tests require an isolated knowscroll_test_* database');
}

const developmentToken=randomBytes(32).toString('hex');
const app=buildApp(developmentToken);
after(async()=>{ await app.close(); await pool.end(); });

const headers=(token:string)=>({authorization:`Bearer ${token}`});
type Feed={decisionId:string;items:Array<{assetId:string}>;privacyEpoch:number};
type Exposure={body:{decisionId:string;assetId:string;clientExposureId:string};receipt:{exposureId:string;eventId:string}};

async function feed(token:string):Promise<Feed> {
  const response=await app.inject({url:'/v1/feed',headers:headers(token)});
  assert.equal(response.statusCode,200,response.body);
  return response.json();
}

async function expose(token:string,receipt:Feed):Promise<Exposure> {
  const body={decisionId:receipt.decisionId,assetId:receipt.items[0]!.assetId,clientExposureId:randomUUID()};
  const response=await app.inject({method:'POST',url:'/v1/exposures',headers:headers(token),payload:body});
  assert.equal(response.statusCode,201,response.body);
  return {body,receipt:response.json()};
}

async function ask(token:string,body:Record<string,unknown>) {
  return app.inject({method:'POST',url:'/v1/asks',headers:headers(token),payload:body});
}

async function waitForAssetBlockedRequest(blockerPid:number):Promise<void> {
  const deadline=Date.now()+2_000;
  while(Date.now()<deadline) {
    const row=(await pool.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`,[blockerPid])).rows[0];
    if(row) return;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.fail('Ask request never waited on the held asset lock');
}

test('records an exposure-anchored literal Ask and replays the exact request without a Keep',async()=>{
  await app.ready();
  const identity=await provisionIdentity();
  const exposure=await expose(identity.token,await feed(identity.token));
  const askId=randomUUID().toUpperCase();
  const question='  What changed in this Scroll?  ';
  const input={clientAskId:askId,exposureId:exposure.receipt.exposureId.toUpperCase(),expectedPrivacyEpoch:0,question};
  const before=await pool.query(`SELECT (SELECT count(*) FROM job) AS jobs,(SELECT count(*) FROM reasoning_job) AS reasoning_jobs,
    (SELECT count(*) FROM reasoning_accounting) AS accounting,(SELECT count(*) FROM trace) AS traces`);
  const first=await ask(identity.token,input);
  assert.equal(first.statusCode,201,first.body);
  assert.deepEqual(first.json().status,'recorded_only');
  const replay=await ask(identity.token,input);
  assert.equal(replay.statusCode,201,replay.body);
  assert.deepEqual(replay.json(),first.json());

  const stored=(await pool.query(`SELECT a.session_id,a.client_ask_id,a.exposure_id,l.kind,l.client_key,l.causation_id,l.payload
    FROM explicit_ask a JOIN ledger l ON l.id=a.event_id WHERE a.id=$1`,[first.json().askId])).rows[0];
  assert.deepEqual(stored.payload,{question,exposureId:exposure.receipt.exposureId,decisionId:exposure.body.decisionId,
    assetId:exposure.body.assetId,sessionId:identity.scope.sessionId,clientAskId:askId.toLowerCase(),expectedPrivacyEpoch:0});
  assert.equal(stored.session_id,identity.scope.sessionId);
  assert.equal(stored.client_ask_id,askId.toLowerCase());
  assert.equal(stored.exposure_id,exposure.receipt.exposureId);
  assert.equal(stored.kind,'ask');
  assert.equal(stored.causation_id,exposure.receipt.eventId);
  assert.match(stored.client_key,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual((await pool.query(`SELECT (SELECT count(*) FROM job) AS jobs,(SELECT count(*) FROM reasoning_job) AS reasoning_jobs,
    (SELECT count(*) FROM reasoning_accounting) AS accounting,(SELECT count(*) FROM trace) AS traces`)).rows[0],before.rows[0]);
});

test('accepts the 4096-byte decoded literal through the Ask route envelope and rejects malformed Ask input after authentication',async()=>{
  const identity=await provisionIdentity();
  const exposure=await expose(identity.token,await feed(identity.token));
  const clientAskId=randomUUID();
  const raw=`{"clientAskId":"${clientAskId}","exposureId":"${exposure.receipt.exposureId}","expectedPrivacyEpoch":0,"question":"${'\\u0061'.repeat(4096)}"}`;
  assert.ok(Buffer.byteLength(raw)>16384);
  const accepted=await app.inject({method:'POST',url:'/v1/asks',headers:{...headers(identity.token),'content-type':'application/json'},payload:raw});
  assert.equal(accepted.statusCode,201,accepted.body);
  const malformed=[
    {clientAskId:randomUUID(),exposureId:exposure.receipt.exposureId,expectedPrivacyEpoch:0,question:'\u0000'},
    {clientAskId:randomUUID(),exposureId:exposure.receipt.exposureId,expectedPrivacyEpoch:0,question:' '.repeat(3)},
    {clientAskId:randomUUID(),exposureId:exposure.receipt.exposureId,expectedPrivacyEpoch:0,question:'a'.repeat(4097)},
    {clientAskId:randomUUID(),exposureId:exposure.receipt.exposureId,expectedPrivacyEpoch:0,question:'\ud800'},
  ];
  for(const input of malformed) {
    const response=await ask(identity.token,input);
    assert.equal(response.statusCode,400,response.body);
  }
  const unauthenticated=await app.inject({method:'POST',url:'/v1/asks',payload:{not:'an Ask'}});
  assert.equal(unauthenticated.statusCode,401);
});

test('rejects foreign, stale, altered, and conflicting Ask sources without exposing a session relation',async()=>{
  const owner=await provisionIdentity();
  const peer=await provisionIdentity({universeId:owner.scope.universeId});
  const foreign=await provisionIdentity();
  const exposure=await expose(owner.token,await feed(owner.token));
  const body={clientAskId:randomUUID(),exposureId:exposure.receipt.exposureId,expectedPrivacyEpoch:0,question:'Can you explain this?' };
  assert.equal((await ask(foreign.token,body)).statusCode,422);
  const peerAsk=await ask(peer.token,body);
  assert.equal(peerAsk.statusCode,201,peerAsk.body);
  assert.equal((await ask(owner.token,body)).statusCode,201,'same client key belongs to a different session');
  assert.equal((await ask(owner.token,{...body,question:'A different literal question'})).statusCode,409);
  assert.equal((await ask(owner.token,{...body,exposureId:randomUUID()})).statusCode,409);

  // An impossible candidates array no ranking ever produced, purely to exercise the Ask route's own
  // ambiguity check. It is its own fixture decision (no ranking version) rather than an edit of a
  // recorded one: a recorded decision's ranking is fixed (ADR-0032, migration 0027).
  const served=await feed(owner.token);
  const candidates=(await pool.query<{candidates:Record<string,unknown>[]}>('SELECT candidates FROM decision WHERE id=$1',[served.decisionId])).rows[0]!.candidates;
  const fixtureDecision=randomUUID();
  await pool.query(`INSERT INTO decision(id,universe_id,account_revision,policy_version,candidates,privacy_epoch) VALUES($1,$2,0,'ask-ambiguity-fixture',$3,0)`,
    [fixtureDecision,owner.scope.universeId,JSON.stringify([...candidates,{...candidates[0],kind:'Reel'}])]);
  const ambiguous=await expose(owner.token,{...served,decisionId:fixtureDecision});
  const ambiguousInput={clientAskId:randomUUID(),exposureId:ambiguous.receipt.exposureId,expectedPrivacyEpoch:0,question:'Which selected Scroll is this?'};
  assert.equal((await ask(owner.token,ambiguousInput)).statusCode,422);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE session_id=$1 AND client_ask_id=$2',[owner.scope.sessionId,ambiguousInput.clientAskId])).rows[0].count,0);

  const altered=await expose(owner.token,await feed(owner.token));
  await pool.query('UPDATE asset SET title=$2 WHERE id=$1',[altered.body.assetId,'Changed after selection']);
  assert.equal((await ask(owner.token,{clientAskId:randomUUID(),exposureId:altered.receipt.exposureId,expectedPrivacyEpoch:0,question:'Is this still current?'})).statusCode,422);
});

test('concurrent duplicate requests serialize to one immutable fact and failure rolls back both rows',async()=>{
  const identity=await provisionIdentity();
  const exposure=await expose(identity.token,await feed(identity.token));
  const input={clientAskId:randomUUID(),exposureId:exposure.receipt.exposureId,expectedPrivacyEpoch:0,question:'One durable question'};
  const [left,right]=await Promise.all([ask(identity.token,input),ask(identity.token,input)]);
  assert.equal(left.statusCode,201,left.body);
  assert.equal(right.statusCode,201,right.body);
  assert.deepEqual(left.json(),right.json());
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE session_id=$1 AND client_ask_id=$2',[identity.scope.sessionId,input.clientAskId])).rows[0].count,1);

  await pool.query(`CREATE FUNCTION ask_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced ask failure'; END $$`);
  await pool.query('CREATE TRIGGER ask_test_fail BEFORE INSERT ON explicit_ask FOR EACH ROW EXECUTE FUNCTION ask_test_fail()');
  const failed={...input,clientAskId:randomUUID(),question:'This transaction must disappear'};
  try {
    const response=await ask(identity.token,failed);
    assert.equal(response.statusCode,500,response.body);
  } finally {
    await pool.query('DROP TRIGGER ask_test_fail ON explicit_ask');
    await pool.query('DROP FUNCTION ask_test_fail()');
  }
  assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ledger WHERE universe_id=$1 AND kind='ask' AND payload->>'question'=$2`,[identity.scope.universeId,failed.question])).rows[0].count,0);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE session_id=$1 AND client_ask_id=$2',[identity.scope.sessionId,failed.clientAskId])).rows[0].count,0);
});

test('clear erases Ask facts and an old expected epoch is rejected before replay',async()=>{
  const identity=await provisionIdentity();
  const exposure=await expose(identity.token,await feed(identity.token));
  const input={clientAskId:randomUUID(),exposureId:exposure.receipt.exposureId,expectedPrivacyEpoch:0,question:'Erase this literal question'};
  const created=await ask(identity.token,input);
  assert.equal(created.statusCode,201,created.body);
  const clear=await app.inject({method:'POST',url:'/v1/history/clear',headers:headers(identity.token),payload:{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'}});
  assert.equal(clear.statusCode,200,clear.body);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE id=$1',[created.json().askId])).rows[0].count,0);
  const stale=await ask(identity.token,input);
  assert.equal(stale.statusCode,409,stale.body);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE session_id=$1 AND client_ask_id=$2',[identity.scope.sessionId,input.clientAskId])).rows[0].count,0);
});

test('a session expiring while the selected asset lock is held is unauthorized and records no Ask',async()=>{
  const identity=await provisionIdentity();
  const exposure=await expose(identity.token,await feed(identity.token));
  const input={clientAskId:randomUUID(),exposureId:exposure.receipt.exposureId,expectedPrivacyEpoch:0,question:'Will the source remain available?'};
  await pool.query(`UPDATE device_session SET created_at=clock_timestamp()-interval '1 second',
    expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1`,[identity.scope.sessionId]);
  const blocker=await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM asset WHERE id=$1 FOR UPDATE',[exposure.body.assetId]);
    const blockerPid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const pending=Promise.resolve(ask(identity.token,input));
    await waitForAssetBlockedRequest(blockerPid);
    const expiry=(await pool.query('SELECT expires_at FROM device_session WHERE id=$1',[identity.scope.sessionId])).rows[0].expires_at as Date;
    while(!(await pool.query('SELECT clock_timestamp()>=$1 AS expired',[expiry])).rows[0].expired) {
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    await blocker.query('COMMIT');
    const response=await pending;
    assert.equal(response.statusCode,401,response.body);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
  }
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM explicit_ask WHERE session_id=$1 AND client_ask_id=$2',[identity.scope.sessionId,input.clientAskId])).rows[0].count,0);
});
