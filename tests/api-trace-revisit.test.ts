import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {after,test} from 'node:test';

import {buildApp} from '../apps/api/src/app.ts';
import {projectOne} from '../apps/worker/src/project.ts';
import {traceRevisitCandidate,traceRevisitReceipt} from '../packages/contracts/src/trace-revisit.ts';
import {pool,provisionIdentity} from '../packages/db/src/index.ts';
import {rejectRevisitWrites,seedTraceRevisitGraph,waitForRevisitPredicate} from './helpers/trace-revisit-fixture.ts';

const app=buildApp(randomBytes(32).toString('hex'));
after(async()=>{await app.close();await pool.end();});
const headers=(token:string)=>({authorization:`Bearer ${token}`});
const getTrace=(token:string,eventId:string)=>app.inject({url:`/v1/traces/${eventId}`,headers:headers(token)});
const universe=(token:string)=>app.inject({url:'/v1/universe',headers:headers(token)});

test('real HTTP handlers admit Keep, project it and read the strict original snapshot without new events',async()=>{
 await app.ready();
 const owner=await provisionIdentity();
 const feed=await app.inject({url:'/v1/feed',headers:headers(owner.token)});assert.equal(feed.statusCode,200,feed.body);
 const selected=feed.json().items[0];assert(selected);
 const exposure=await app.inject({method:'POST',url:'/v1/exposures',headers:headers(owner.token),payload:{decisionId:feed.json().decisionId,assetId:selected.assetId,clientExposureId:randomUUID()}});
 assert.equal(exposure.statusCode,201,exposure.body);
 const keep=await app.inject({method:'POST',url:'/v1/interactions',headers:headers(owner.token),payload:{clientEventId:randomUUID(),exposureId:exposure.json().exposureId,assetId:selected.assetId,kind:'keep'}});
 assert.equal(keep.statusCode,202,keep.body);
 assert.equal((await getTrace(owner.token,keep.json().eventId)).statusCode,404,'accepted Keep alone is not a Trace');
 let projected=false;
 for(let probe=0;probe<128;probe+=1) {
  const result=await projectOne();if(result?.jobId===keep.json().jobId) {projected=true;break;}
  if(!result) break;
 }
 assert(projected,'real deterministic projection reached the admitted Keep');
 const keptAt=(await pool.query('SELECT created_at FROM ledger WHERE id=$1',[keep.json().eventId])).rows[0].created_at.toISOString();
 const before=(await pool.query(`SELECT (SELECT count(*) FROM decision) decisions,(SELECT count(*) FROM exposure) exposures,
  (SELECT count(*) FROM ledger) events,(SELECT count(*) FROM job) jobs,(SELECT count(*) FROM trace) traces,
  (SELECT count(*) FROM reasoning_job) reasoning,(SELECT count(*) FROM reasoning_accounting) accounting`)).rows[0];
 const restore=await rejectRevisitWrites(pool);
 try {
  const response=await getTrace(owner.token,keep.json().eventId.toUpperCase());assert.equal(response.statusCode,200,response.body);
  assert.equal(response.headers['cache-control'],'no-store');
  assert.deepEqual(traceRevisitReceipt.parse(response.json()),{mode:'kept_revisit',traceEventId:keep.json().eventId,
   universeId:owner.scope.universeId,privacyEpoch:0,exposureId:exposure.json().exposureId,keptAt,scroll:traceRevisitCandidate.parse(selected)});
  const list=await universe(owner.token);assert.equal(list.statusCode,200,list.body);
  assert.equal(list.json().traces.find((trace:{eventId:string})=>trace.eventId===keep.json().eventId).title,selected.title);
  assert.deepEqual((await pool.query(`SELECT (SELECT count(*) FROM decision) decisions,(SELECT count(*) FROM exposure) exposures,
   (SELECT count(*) FROM ledger) events,(SELECT count(*) FROM job) jobs,(SELECT count(*) FROM trace) traces,
   (SELECT count(*) FROM reasoning_job) reasoning,(SELECT count(*) FROM reasoning_accounting) accounting`)).rows[0],before);
 } finally {await restore();}
});

test('trace input is strict and missing, foreign or unprojected resources use generic content-free errors',async()=>{
 const owner=await seedTraceRevisitGraph(pool),foreign=await seedTraceRevisitGraph(pool),pending=await seedTraceRevisitGraph(pool,{projected:false});
 const invalid=[
  await getTrace(owner.token,'not-a-uuid'),
  await app.inject({url:`/v1/traces/${owner.keepEventId}?assetId=${owner.assetId}`,headers:headers(owner.token)}),
  await app.inject({url:`/v1/traces/${owner.keepEventId}?sessionId=${foreign.scope.sessionId}`,headers:headers(owner.token)}),
  await app.inject({method:'GET',url:`/v1/traces/${owner.keepEventId}`,headers:{...headers(owner.token),'content-type':'application/json'},payload:{assetId:owner.assetId}}),
 ];
 for(const response of invalid) assert.equal(response.statusCode,400,response.body);
 assert.deepEqual((await app.inject({url:'/v1/traces/not-a-uuid'})).json(),{error:'Unauthorized'});
 for(const response of [await getTrace(foreign.token,owner.keepEventId),await getTrace(owner.token,randomUUID()),await getTrace(pending.token,pending.keepEventId)]) {
  assert.equal(response.statusCode,404);assert.deepEqual(response.json(),{error:'Trace not found'});
 }
 const peer=await provisionIdentity({universeId:owner.scope.universeId});
 assert.equal((await getTrace(peer.token,owner.keepEventId)).statusCode,200,'current owner peer is allowed');
 await pool.query('UPDATE device_session SET revoked_at=clock_timestamp() WHERE id=$1',[peer.scope.sessionId]);
 const revoked=await getTrace(peer.token,owner.keepEventId);assert.equal(revoked.statusCode,401);assert.deepEqual(revoked.json(),{error:'Unauthorized'});
});

test('source drift refuses private content while Universe keeps the original historical title',async()=>{
 const graph=await seedTraceRevisitGraph(pool);
 await pool.query("UPDATE asset SET title='Changed live title',body='Changed live body' WHERE id=$1",[graph.assetId]);
 const response=await getTrace(graph.token,graph.keepEventId);assert.equal(response.statusCode,409);
 assert.deepEqual(response.json(),{error:'Saved Scroll source is unavailable'});
 const list=await universe(graph.token);assert.equal(list.statusCode,200);
 assert.deepEqual(list.json().traces.map((trace:{title:string})=>trace.title),[graph.scroll.title]);
});

test('malformed and mixed-case duplicate selection history produces neutral cards and a 422 open',async()=>{
 const bad=await seedTraceRevisitGraph(pool),good=await seedTraceRevisitGraph(pool,{universeId:bad.scope.universeId});
 await pool.query('UPDATE decision SET candidates=$2 WHERE id=$1',[bad.decisionId,JSON.stringify([bad.candidate,{assetId:bad.assetId.toUpperCase()}])]);
 const response=await getTrace(bad.token,bad.keepEventId);assert.equal(response.statusCode,422);
 assert.deepEqual(response.json(),{error:'Saved Scroll lineage is unavailable'});
 const list=await universe(bad.token);assert.equal(list.statusCode,200);
 assert.equal(list.json().traces.find((trace:{eventId:string})=>trace.eventId===bad.keepEventId).title,'Saved Scroll unavailable');
 assert.equal(list.json().traces.find((trace:{eventId:string})=>trace.eventId===good.keepEventId).title,good.scroll.title);
 await pool.query('UPDATE decision SET candidates=$2 WHERE id=$1',[bad.decisionId,JSON.stringify([bad.candidate])]);
 await pool.query('UPDATE ledger SET causation_id=NULL WHERE id=$1',[bad.keepEventId]);
 assert.equal((await getTrace(bad.token,bad.keepEventId)).statusCode,422);
});

test('old private epochs refuse the read and Clear removes the original reference without reviving it',async()=>{
 const stale=await seedTraceRevisitGraph(pool);
 await pool.query('UPDATE universe SET privacy_epoch=1 WHERE id=$1',[stale.scope.universeId]);
 await pool.query('UPDATE device_session SET privacy_epoch=1 WHERE id=$1',[stale.scope.sessionId]);
 const old=await getTrace(stale.token,stale.keepEventId);assert.equal(old.statusCode,409);assert.deepEqual(old.json(),{error:'Trace privacy epoch is stale'});
 const graph=await seedTraceRevisitGraph(pool),peer=await provisionIdentity({universeId:graph.scope.universeId});
 const cleared=await app.inject({method:'POST',url:'/v1/history/clear',headers:headers(graph.token),payload:{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'}});
 assert.equal(cleared.statusCode,200,cleared.body);
 assert.equal((await getTrace(graph.token,graph.keepEventId)).statusCode,404);
 assert.equal((await getTrace(peer.token,graph.keepEventId)).statusCode,401);
 assert.deepEqual((await universe(graph.token)).json().traces,[]);
});

test('actual asset lock wait expiry returns generic 401 after authentication and releases the transaction',async()=>{
 const graph=await seedTraceRevisitGraph(pool);
 await pool.query("UPDATE device_session SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[graph.scope.sessionId]);
 const blocker=await pool.connect();
 try {
  await blocker.query('BEGIN');await blocker.query('SELECT id FROM asset WHERE id=$1 FOR UPDATE',[graph.assetId]);
  const pid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
  const pending=Promise.resolve(getTrace(graph.token,graph.keepEventId));void pending.catch(()=>{});
  await waitForRevisitPredicate(async()=>Boolean((await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount),'API source lock wait');
  await waitForRevisitPredicate(async()=>(await pool.query('SELECT expires_at<=clock_timestamp() AS elapsed FROM device_session WHERE id=$1',[graph.scope.sessionId])).rows[0].elapsed,'API database session expiry');
  await blocker.query('COMMIT');const response=await pending;assert.equal(response.statusCode,401);assert.deepEqual(response.json(),{error:'Unauthorized'});
 } finally {await blocker.query('ROLLBACK');blocker.release();}
 const caller=await provisionIdentity({universeId:graph.scope.universeId});
 assert.equal((await getTrace(caller.token,graph.keepEventId)).statusCode,200,'failed read transaction did not strand its universe lock');
});
