import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';

import {traceRevisitReceipt} from '../packages/contracts/src/trace-revisit.ts';
import {authenticateAndLock,UnauthorizedSession} from '../packages/db/src/identity.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {listSavedTraces,readTraceRevisit,TraceRevisitError} from '../packages/db/src/trace-revisit.ts';
import {inRevisitTransaction,rejectRevisitWrites,revisit,seedTraceRevisitGraph,waitForRevisitPredicate,withTraceRevisitSchema} from './helpers/trace-revisit-fixture.ts';

const failed=(kind:TraceRevisitError['kind'])=>(error:unknown)=>error instanceof TraceRevisitError&&error.kind===kind;
const listing=(pool:Parameters<typeof inRevisitTransaction>[0],graph:Awaited<ReturnType<typeof seedTraceRevisitGraph>>)=>
 inRevisitTransaction(pool,async client=>listSavedTraces(client,await authenticateAndLock(client,graph.token)));

test('revisit returns exact selected bytes, canonical IDs and original Keep time without any domain writes',async()=>{
 await withTraceRevisitSchema('exact_read',async pool=>{
  const graph=await seedTraceRevisitGraph(pool);
  await pool.query('UPDATE decision SET candidates=$2 WHERE id=$1',[graph.decisionId,JSON.stringify([{...graph.candidate,assetId:graph.assetId.toUpperCase(),reason:{arbitrary:'ignored'}}])]);
  const timestamps=(await pool.query('SELECT l.created_at AS kept_at,t.created_at AS projected_at FROM ledger l JOIN trace t ON t.event_id=l.id WHERE l.id=$1',[graph.keepEventId])).rows[0];
  const restore=await rejectRevisitWrites(pool);
  try {
   const result=await revisit(pool,graph,graph.keepEventId.toUpperCase());
   assert.deepEqual(result,{mode:'kept_revisit',traceEventId:graph.keepEventId,universeId:graph.scope.universeId,privacyEpoch:0,
    exposureId:graph.exposureId,keptAt:timestamps.kept_at.toISOString(),scroll:graph.scroll});
   assert(traceRevisitReceipt.safeParse(result).success);assert.equal('reason' in result.scroll,false);
   const traces=await listing(pool,graph);
   assert.deepEqual(traces,[{eventId:graph.keepEventId,assetId:graph.assetId,title:graph.scroll.title,createdAt:timestamps.projected_at}]);
   assert.notEqual(result.keptAt,traces[0]!.createdAt.toISOString());
  } finally {await restore();}
 });
});

test('a current owning-universe peer can revisit but foreign, missing and unprojected references disclose nothing',async()=>{
 await withTraceRevisitSchema('read_scope',async pool=>{
  const owner=await seedTraceRevisitGraph(pool),peer=await seedTraceRevisitGraph(pool,{universeId:owner.scope.universeId}),foreign=await seedTraceRevisitGraph(pool),pending=await seedTraceRevisitGraph(pool,{projected:false});
  assert.deepEqual((await revisit(pool,peer,owner.keepEventId)).scroll,owner.scroll);
  await assert.rejects(revisit(pool,foreign,owner.keepEventId),failed('not_found'));
  await assert.rejects(revisit(pool,owner,randomUUID()),failed('not_found'));
  await assert.rejects(revisit(pool,pending),failed('not_found'));
  await assert.rejects(revisit(pool,owner,owner.exposureEventId),failed('not_found'));
  await assert.rejects(revisit(pool,owner,'not-a-uuid'),failed('invalid'));
 });
});

test('old-epoch source rows fail closed and list entries remain neutral',async()=>{
 await withTraceRevisitSchema('old_epoch',async pool=>{
  const graph=await seedTraceRevisitGraph(pool);
  await pool.query('UPDATE universe SET privacy_epoch=1 WHERE id=$1',[graph.scope.universeId]);
  await pool.query('UPDATE device_session SET privacy_epoch=1 WHERE id=$1',[graph.scope.sessionId]);
  await assert.rejects(revisit(pool,graph),failed('stale_epoch'));
  assert.equal((await listing(pool,graph))[0]!.title,'Saved Scroll unavailable');
 });
});

test('ambiguous and malformed selected candidates are rejected before projection; unrelated metadata supplies no display authority',async t=>{
 const cases:Record<string,(candidate:Record<string,unknown>)=>unknown>={
  'non-array history':()=>({}), 'missing selection':()=>[],
  'duplicate canonical selection':candidate=>[candidate,{...candidate,assetId:String(candidate.assetId).toUpperCase(),body:undefined}],
  'invalid revision':candidate=>[{...candidate,revision:0}], 'invalid body':candidate=>[{...candidate,body:null}],
  'invalid source URL':candidate=>[{...candidate,sourceUrl:'not a URL'}], 'wrong consumption kind':candidate=>[{...candidate,kind:'Reel'}],
  'unsupported truth':candidate=>[{...candidate,truthState:'synthesis'}],
 };
 for(const [name,candidates] of Object.entries(cases)) await t.test(name,async()=>{
  await withTraceRevisitSchema('bad_candidate',async pool=>{
   const graph=await seedTraceRevisitGraph(pool),good=await seedTraceRevisitGraph(pool,{universeId:graph.scope.universeId});
   await pool.query('UPDATE decision SET candidates=$2 WHERE id=$1',[graph.decisionId,JSON.stringify(candidates(graph.candidate))]);
   await assert.rejects(revisit(pool,graph),failed('lineage'));
   const traces=await listing(pool,graph);
   assert.equal(traces.find(trace=>trace.eventId===graph.keepEventId)!.title,'Saved Scroll unavailable');
   assert.equal(traces.find(trace=>trace.eventId===good.keepEventId)!.title,good.scroll.title);
  });
 });
});

test('causal, payload and event references must all agree rather than relying on relational IDs alone',async t=>{
 const cases=[
  {name:'Keep asset payload',table:'ledger',id:'keepEventId',sql:"payload=jsonb_set(payload,'{assetId}',to_jsonb($2::text))"},
  {name:'Keep malformed exposure payload',table:'ledger',id:'keepEventId',sql:"payload=jsonb_set(payload,'{exposureId}',to_jsonb('bad UUID'::text))"},
  {name:'Keep client identity',table:'ledger',id:'keepEventId',sql:"payload=jsonb_set(payload,'{clientEventId}',to_jsonb($2::text))"},
  {name:'Keep causation',table:'ledger',id:'keepEventId',sql:'causation_id=NULL'},
  {name:'Keep event kind',table:'ledger',id:'keepEventId',sql:"kind='exposure'"},
  {name:'Exposure event kind',table:'ledger',id:'exposureEventId',sql:"kind='keep'"},
  {name:'Exposure decision payload',table:'ledger',id:'exposureEventId',sql:"payload=jsonb_set(payload,'{decisionId}',to_jsonb($2::text))"},
  {name:'Exposure event payload identity',table:'ledger',id:'exposureEventId',sql:"payload=jsonb_set(payload,'{exposureId}',to_jsonb($2::text))"},
  {name:'Exposure client payload',table:'ledger',id:'exposureEventId',sql:"payload=jsonb_set(payload,'{clientExposureId}',to_jsonb($2::text))"},
  {name:'Exposure extra payload field',table:'ledger',id:'exposureEventId',sql:"payload=payload || '{\"unexpected\":true}'::jsonb"},
  {name:'Exposure client row',table:'exposure',id:'exposureId',sql:'client_key=$2::uuid'},
 ];
 for(const entry of cases) await t.test(entry.name,async()=>{
  await withTraceRevisitSchema('bad_lineage',async pool=>{
   const graph=await seedTraceRevisitGraph(pool),id=graph[entry.id as 'keepEventId'|'exposureEventId'|'exposureId'];
   await pool.query(`UPDATE ${entry.table} SET ${entry.sql} WHERE id=$1`,entry.sql.includes('$2')?[id,randomUUID()]:[id]);
   await assert.rejects(revisit(pool,graph),failed('lineage'));
   assert.equal((await listing(pool,graph))[0]!.title,'Saved Scroll unavailable');
  });
 });
});

test('multiple Trace rows for one Keep event are ambiguous and unavailable individually and in the list',async()=>{
 await withTraceRevisitSchema('duplicate_trace',async pool=>{
  const first=await seedTraceRevisitGraph(pool),second=await seedTraceRevisitGraph(pool,{universeId:first.scope.universeId});
  await pool.query('UPDATE trace SET event_id=$3 WHERE universe_id=$1 AND asset_id=$2',[first.scope.universeId,second.assetId,first.keepEventId]);
  await assert.rejects(revisit(pool,first),failed('lineage'));
  assert((await listing(pool,first)).every(trace=>trace.title==='Saved Scroll unavailable'));
 });
});

test('a relationally valid Trace asset cannot replace the asset in its original Keep and exposure',async()=>{
 await withTraceRevisitSchema('wrong_trace_asset',async pool=>{
  const first=await seedTraceRevisitGraph(pool),other=await seedTraceRevisitGraph(pool,{universeId:first.scope.universeId,projected:false});
  await pool.query('UPDATE trace SET asset_id=$3 WHERE universe_id=$1 AND event_id=$2',[first.scope.universeId,first.keepEventId,other.assetId]);
  await assert.rejects(revisit(pool,first),failed('lineage'));
  assert.equal((await listing(pool,first))[0]!.title,'Saved Scroll unavailable');
 });
});

test('every current display field and revision is guarded while historical titles remain unchanged',async t=>{
 const changes:Record<string,string>={revision:'2',kind:"'Reel'",title:"'Renamed source'",summary:"'Changed summary'",body:"'Changed body'",
  source_title:"'Changed pointer'",source_url:"'https://example.test/changed'",truth_state:"'disputed'"};
 for(const [column,value] of Object.entries(changes)) await t.test(column,async()=>{
  await withTraceRevisitSchema('source_drift',async pool=>{
   const graph=await seedTraceRevisitGraph(pool);
   await pool.query(`UPDATE asset SET ${column}=${value} WHERE id=$1`,[graph.assetId]);
   await assert.rejects(revisit(pool,graph),failed('source_changed'));
   assert.equal((await listing(pool,graph))[0]!.title,graph.scroll.title);
  });
 });
});

test('session authority expires during the real source wait and the read makes no writes',async()=>{
 await withTraceRevisitSchema('session_wait',async pool=>{
  const graph=await seedTraceRevisitGraph(pool);
  await pool.query("UPDATE device_session SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[graph.scope.sessionId]);
  const restore=await rejectRevisitWrites(pool),blocker=await pool.connect();
  try {
   await blocker.query('BEGIN');await blocker.query('SELECT id FROM asset WHERE id=$1 FOR UPDATE',[graph.assetId]);
   const pid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   const pending=revisit(pool,graph);void pending.catch(()=>{});
   await waitForRevisitPredicate(async()=>Boolean((await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount),'asset lock wait');
   await waitForRevisitPredicate(async()=>(await pool.query('SELECT expires_at<=clock_timestamp() AS elapsed FROM device_session WHERE id=$1',[graph.scope.sessionId])).rows[0].elapsed,'database session expiry');
   await blocker.query('COMMIT');
   await assert.rejects(pending,error=>error instanceof UnauthorizedSession);
  } finally {await blocker.query('ROLLBACK');blocker.release();await restore();}
 });
});

test('a correction committed during the source wait is refused instead of substituting new body bytes',async()=>{
 await withTraceRevisitSchema('source_wait',async pool=>{
  const graph=await seedTraceRevisitGraph(pool),blocker=await pool.connect();
  try {
   await blocker.query('BEGIN');await blocker.query("UPDATE asset SET body='Corrected current source' WHERE id=$1",[graph.assetId]);
   const pid=Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid),pending=revisit(pool,graph);void pending.catch(()=>{});
   await waitForRevisitPredicate(async()=>Boolean((await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount),'source correction wait');
   await blocker.query('COMMIT');await assert.rejects(pending,failed('source_changed'));
  } finally {await blocker.query('ROLLBACK');blocker.release();}
 });
});

test('a successful read holds its source against correction until the authority transaction ends',async()=>{
 await withTraceRevisitSchema('source_share',async pool=>{
  const graph=await seedTraceRevisitGraph(pool),reader=await pool.connect(),writer=await pool.connect();
  try {
   await reader.query('BEGIN');const scope=await authenticateAndLock(reader,graph.token);
   const result=await readTraceRevisit(reader,scope,graph.keepEventId);
   const pid=Number((await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   const correction=writer.query("UPDATE asset SET body='Later correction' WHERE id=$1",[graph.assetId]);void correction.catch(()=>{});
   await waitForRevisitPredicate(async()=>Boolean((await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount),'held shared source');
   assert.equal(result.scroll.body,graph.scroll.body);
   await reader.query('COMMIT');await correction;
   await assert.rejects(revisit(pool,graph),failed('source_changed'));
  } finally {await reader.query('ROLLBACK');reader.release();writer.release();}
 });
});

test('Clear serializes after a read and erased references cannot return old private content',async()=>{
 await withTraceRevisitSchema('clear_serialization',async pool=>{
  const graph=await seedTraceRevisitGraph(pool),reader=await pool.connect();
  try {
   await reader.query('BEGIN');const scope=await authenticateAndLock(reader,graph.token);
   assert.deepEqual((await readTraceRevisit(reader,scope,graph.keepEventId)).scroll,graph.scroll);
   const pid=Number((await reader.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
   const clearing=inRevisitTransaction(pool,async client=>clearScrollHistory(client,await authenticateAndLock(client,graph.token),
    {requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'}));void clearing.catch(()=>{});
   await waitForRevisitPredicate(async()=>Boolean((await pool.query('SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount),'Clear universe wait');
   await reader.query('COMMIT');assert.equal((await clearing).privacyEpoch,1);
   await assert.rejects(revisit(pool,graph),failed('not_found'));assert.deepEqual(await listing(pool,graph),[]);
  } finally {await reader.query('ROLLBACK');reader.release();}
 });
});

test('Clear winning the universe lock makes waiting reads reauthenticate before any private source is returned',async()=>{
 await withTraceRevisitSchema('clear_first',async pool=>{
  const owner=await seedTraceRevisitGraph(pool),peer=await seedTraceRevisitGraph(pool,{universeId:owner.scope.universeId}),clearer=await pool.connect();
  try {
   await clearer.query('BEGIN');const scope=await authenticateAndLock(clearer,owner.token);
   await clearScrollHistory(clearer,scope,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'});
   const originalRead=revisit(pool,owner),peerRead=revisit(pool,peer,owner.keepEventId);
   void originalRead.catch(()=>{});void peerRead.catch(()=>{});
   await waitForRevisitPredicate(async()=>Number((await pool.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%SELECT id FROM universe%' ")).rows[0].n)===2,'both Clear-first authority waits');
   await clearer.query('COMMIT');
   await assert.rejects(originalRead,failed('not_found'));
   await assert.rejects(peerRead,error=>error instanceof UnauthorizedSession);
   assert.deepEqual(await listing(pool,owner),[]);
  } finally {await clearer.query('ROLLBACK');clearer.release();}
 });
});
