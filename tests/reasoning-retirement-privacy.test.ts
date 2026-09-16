import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import test from 'node:test';
import type pg from 'pg';

import {authenticateAndLock} from '../packages/db/src/identity.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {createReasoningAdmission} from '../packages/db/src/reasoning-admission.ts';
import {createReasoningMaintenance} from '../packages/db/src/reasoning-maintenance.ts';
import {appendRestrictedReasoningReceipt} from '../packages/db/src/reasoning-storage.ts';
import {
 ageWithdrawalForTest,inMaintenanceTransaction,seedWithdrawnReasoningGraph,withReasoningMaintenanceSchema,
} from './helpers/reasoning-maintenance-fixture.ts';

type PrivateGraph={
 universeId:string;jobId:string;contextId:string;stepId:string;sessionId:string;sessionToken:string;deviceId:string;expiresAt:string;
 attemptId?:string;requestId?:string;dispatchId?:string;permitId?:string;reservationId?:string;bucketId?:string;
};

const authority={
 resolvePolicy:async()=>{throw new Error('Privacy fixture does not resolve policy');},
 validateContext:async()=>false,
};

async function seedRunningPrivateGraph(pool:pg.Pool,{consumed=false}:{consumed?:boolean}={}):Promise<PrivateGraph> {
 const universeId=randomUUID(),jobId=randomUUID(),contextId=randomUUID(),stepId=randomUUID();
 const sessionId=randomUUID(),sessionToken=randomUUID(),deviceId=randomUUID(),owner='retirement-privacy';
 const expiresAt=(await pool.query<{expires_at:Date}>("SELECT clock_timestamp()+interval '2 hours' AS expires_at")).rows[0]!.expires_at;
 await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
 await pool.query('INSERT INTO accounts(universe_id) VALUES($1)',[universeId]);
 await pool.query(`INSERT INTO device_session(id,universe_id,device_id,token_hash,privacy_epoch,expires_at)
  VALUES($1,$2,$3,$4,0,$5)`,[sessionId,universeId,deviceId,createHash('sha256').update(sessionToken).digest('hex'),expiresAt]);
 await pool.query(`INSERT INTO reasoning_job
  (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id,lease_owner,lease_fence,lease_expires_at)
  VALUES($1,$2,0,'running','interactive',$2,'retirement-privacy',clock_timestamp()+interval '1 hour','direct',$3,$4,1,clock_timestamp()+interval '1 hour')`,
  [jobId,universeId,randomUUID(),owner]);
 await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
  VALUES($1,$2,$3,0,$4,'retirement-privacy','retirement-privacy')`,[contextId,jobId,universeId,'a'.repeat(64)]);
 await inMaintenanceTransaction(pool,async client=>{
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  await client.query(`INSERT INTO reasoning_context_dependency
   (context_id,universe_id,privacy_epoch,identity,canonical_dependency) VALUES($1,$2,0,'scroll:test:revision:1',$3)`,
   [contextId,universeId,JSON.stringify({kind:'Scroll',revision:1})]);
  await client.query(`INSERT INTO reasoning_context_payload
   (context_id,universe_id,privacy_epoch,canonical_payload,content_hash,read_set_hash) VALUES($1,$2,0,$3,$4,$5)`,
   [contextId,universeId,JSON.stringify({version:1,scrolls:[]}),'a'.repeat(64),'b'.repeat(64)]);
 });
 await pool.query(`INSERT INTO reasoning_context_job_session(job_id,universe_id,privacy_epoch,session_id)
  VALUES($1,$2,0,$3)`,[jobId,universeId,sessionId]);
 await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
  VALUES($1,$2,$3,0,$4,1,'pending')`,[stepId,jobId,universeId,contextId]);
 const graph:PrivateGraph={universeId,jobId,contextId,stepId,sessionId,sessionToken,deviceId,expiresAt:expiresAt.toISOString()};
 if(!consumed) return graph;

 const attemptId=randomUUID(),requestId=randomUUID(),dispatchId=randomUUID(),permitId=randomUUID();
 const reservationSetId=randomUUID(),reservationId=randomUUID(),bucketId=randomUUID(),now=new Date().toISOString();
 await pool.query(`INSERT INTO reasoning_accounting
  (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,
   state,dispatch_id,dispatch_committed_at)
  VALUES($1,$2,0,$3,'privacy-route','privacy-profile',100,clock_timestamp()+interval '1 hour','dispatch_committed',$4,$5)`,
  [attemptId,universeId,requestId,dispatchId,now]);
 await pool.query(`INSERT INTO reasoning_bucket(id,dimension,unit,capacity,reserved)
  VALUES($1,'global_budget','tokens',1000,7)`,[bucketId]);
 await pool.query(`INSERT INTO reasoning_permit
  (id,attempt_id,universe_id,privacy_epoch,reservation_set_id,expires_at,state,dispatch_id,consumed_at)
  VALUES($1,$2,$3,0,$4,clock_timestamp()+interval '1 hour','consumed',$5,$6)`,
  [permitId,attemptId,universeId,reservationSetId,dispatchId,now]);
 await pool.query(`INSERT INTO reasoning_reservation
  (id,attempt_id,reservation_set_id,bucket_id,dimension,unit,amount)
  VALUES($1,$2,$3,$4,'global_budget','tokens',7)`,[reservationId,attemptId,reservationSetId,bucketId]);
 await pool.query(`INSERT INTO reasoning_attempt
  (id,job_id,step_id,context_id,universe_id,privacy_epoch,ordinal,lease_fence,request_hash,permit_id,reservation_set_id)
  VALUES($1,$2,$3,$4,$5,0,1,1,$6,$7,$8)`,
  [attemptId,jobId,stepId,contextId,universeId,'c'.repeat(64),permitId,reservationSetId]);
 return {...graph,attemptId,requestId,dispatchId,permitId,reservationId,bucketId};
}

async function withdraw(pool:pg.Pool,graph:PrivateGraph):Promise<void> {
 await createReasoningAdmission(pool,authority).withdrawJob({
  universeId:graph.universeId,privacyEpoch:0,jobId:graph.jobId,owner:'retirement-privacy',leaseFence:'1',reason:'cancelled',
 });
}

async function count(pool:pg.Pool,table:string,column:string,value:string):Promise<number> {
 return (await pool.query<{count:number}>(`SELECT count(*)::int AS count FROM ${table} WHERE ${column}=$1`,[value])).rows[0]!.count;
}

async function seedClosedAccounting(pool:pg.Pool,universeId:string,ageDays:number):Promise<string> {
 const attemptId=randomUUID();
 await pool.query(`INSERT INTO reasoning_accounting
  (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,
   state,output_authority,liability_state,remote_state,remote_disposition,reconciliation_hold,idempotency_hold,
   closure_basis,all_duties_closed_at)
  VALUES($1,$2,0,$3,'privacy-route','privacy-profile',1,clock_timestamp()+interval '1 hour',
   'not_sent','withdrawn','settled','released','not_sent',false,false,'evidence',clock_timestamp()-($4::int*interval '1 day'))`,
  [attemptId,universeId,randomUUID(),ageDays]);
 return attemptId;
}

test('reasoning retirement preserves privacy and evidence boundaries',async t=>{
 await t.test('the database withdrawal clock enforces seven days and never guesses a legacy timestamp',async()=>{
  await withReasoningMaintenanceSchema('privacy_clock',async pool=>{
   const before=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   const graph=await seedRunningPrivateGraph(pool);
   await withdraw(pool,graph);
   const stamped=(await pool.query<{status:string;withdrawn_at:Date}>('SELECT status,withdrawn_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0]!;
   const after=(await pool.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
   assert.equal(stamped.status,'cancelled');
   assert(stamped.withdrawn_at>=before&&stamped.withdrawn_at<=after);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:2}),
    {probes:2,expiredJobs:0,retiredJobs:0,purgedAccounting:0,skipped:2});
   assert.equal(await count(pool,'reasoning_job','id',graph.jobId),1);
   await assert.rejects(pool.query("UPDATE reasoning_job SET status='completed' WHERE id=$1",[graph.jobId]),/cannot reactivate|retention clock/i);
   await ageWithdrawalForTest(pool,graph.jobId,168);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:2}),
    {probes:2,expiredJobs:0,retiredJobs:1,purgedAccounting:0,skipped:1});
   assert.equal(await count(pool,'reasoning_job','id',graph.jobId),0);
   assert.equal(await count(pool,'reasoning_context_payload','context_id',graph.contextId),0);
   assert.equal(await count(pool,'reasoning_context_dependency','context_id',graph.contextId),0);
   assert.equal(await count(pool,'reasoning_context_job_session','job_id',graph.jobId),0);

   const legacyUniverse=randomUUID(),legacyJob=randomUUID();
   await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[legacyUniverse]);
   await pool.query(`INSERT INTO reasoning_job
    (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,created_at,wake_kind,intent_id)
    VALUES($1,$2,0,'cancelled','interactive',$2,'legacy',clock_timestamp()-interval '90 days',clock_timestamp()-interval '100 days','direct',$3)`,
    [legacyJob,legacyUniverse,randomUUID()]);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:2}),
    {probes:2,expiredJobs:0,retiredJobs:0,purgedAccounting:0,skipped:2});
   assert.deepEqual((await pool.query('SELECT withdrawn_at FROM reasoning_job WHERE id=$1',[legacyJob])).rows[0],{withdrawn_at:null});
  });
 });

 await t.test('a failed real withdrawal rolls back its private mutations and retention clock',async()=>{
  await withReasoningMaintenanceSchema('privacy_withdrawal_rollback',async pool=>{
   const graph=await seedRunningPrivateGraph(pool);
   await pool.query("CREATE FUNCTION reject_privacy_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced withdrawal rollback'; END $$");
   await pool.query('CREATE TRIGGER reject_privacy_withdrawal BEFORE UPDATE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION reject_privacy_withdrawal()');
   try {await assert.rejects(withdraw(pool,graph),/forced withdrawal rollback/);}
   finally {
    await pool.query('DROP TRIGGER reject_privacy_withdrawal ON reasoning_job');
    await pool.query('DROP FUNCTION reject_privacy_withdrawal()');
   }
   assert.deepEqual((await pool.query('SELECT status,lease_owner,lease_fence::text,withdrawn_at FROM reasoning_job WHERE id=$1',[graph.jobId])).rows[0],
    {status:'running',lease_owner:'retirement-privacy',lease_fence:'1',withdrawn_at:null});
   assert.equal((await pool.query('SELECT status FROM reasoning_step WHERE id=$1',[graph.stepId])).rows[0]!.status,'pending');
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:2}),
    {probes:2,expiredJobs:0,retiredJobs:0,purgedAccounting:0,skipped:2});
  });
 });

 await t.test('Clear History erases fresh private context immediately and cannot cross universes',async()=>{
  await withReasoningMaintenanceSchema('privacy_clear',async pool=>{
   const owner=await seedRunningPrivateGraph(pool,{consumed:true});
   await withdraw(pool,owner);
   const neighbor=await seedWithdrawnReasoningGraph(pool);
   await inMaintenanceTransaction(pool,client=>clearScrollHistory(client,{
    universeId:owner.universeId,privacyEpoch:0,sessionId:owner.sessionId,deviceId:owner.deviceId,expiresAt:owner.expiresAt,
   },{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'}));
   assert.equal(await count(pool,'reasoning_job','id',owner.jobId),0);
   assert.equal(await count(pool,'reasoning_context_payload','context_id',owner.contextId),0);
   assert.equal(await count(pool,'reasoning_context_dependency','context_id',owner.contextId),0);
   assert.equal(await count(pool,'reasoning_context_job_session','job_id',owner.jobId),0);
   assert.equal(await count(pool,'reasoning_accounting','attempt_id',owner.attemptId!),1);
   assert.deepEqual((await pool.query('SELECT state,output_authority FROM reasoning_accounting WHERE attempt_id=$1',[owner.attemptId])).rows[0],
    {state:'unknown',output_authority:'withdrawn'});
   assert.equal(await count(pool,'reasoning_job','id',neighbor.jobId),1);
   assert.equal(await count(pool,'reasoning_context','job_id',neighbor.jobId),1);
  });
 });

 await t.test('a concurrent authenticated clear wins the universe lock and an old replay cannot erase later work',async()=>{
  await withReasoningMaintenanceSchema('privacy_clear_race',async pool=>{
   const graph=await seedRunningPrivateGraph(pool,{consumed:true});
   await withdraw(pool,graph);
   await ageWithdrawalForTest(pool,graph.jobId,169);
   const requestId=randomUUID();
   const input={requestId,expectedPrivacyEpoch:0,confirmation:'clear-scroll-history' as const};
   const clearClient=await pool.connect();
   let transactionOpen=true;
   try {
    await clearClient.query('BEGIN');
    const authenticated=await authenticateAndLock(clearClient,graph.sessionToken);
    const receipt=await clearScrollHistory(clearClient,authenticated,input);
    assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:2}),
     {probes:2,expiredJobs:0,retiredJobs:0,purgedAccounting:0,skipped:2});
    await clearClient.query('COMMIT');transactionOpen=false;
    assert.equal(await count(pool,'reasoning_job','id',graph.jobId),0);
    assert.equal((await createReasoningMaintenance(pool).runBatch({maxProbes:2})).retiredJobs,0);

    const laterJobId=randomUUID();
    await pool.query(`INSERT INTO reasoning_job
     (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
     VALUES($1,$2,1,'queued','interactive',$2,'after-clear',clock_timestamp()+interval '1 hour','direct',$3)`,
     [laterJobId,graph.universeId,randomUUID()]);
    const replay=await inMaintenanceTransaction(pool,async client=>{
     const authenticated=await authenticateAndLock(client,graph.sessionToken);
     return clearScrollHistory(client,authenticated,input);
    });
    assert.deepEqual(replay,receipt);
    assert.equal(await count(pool,'reasoning_job','id',laterJobId),1);
    assert.equal((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1',[graph.universeId])).rows[0]!.privacy_epoch,1);
   } finally {
    if(transactionOpen) await clearClient.query('ROLLBACK');
    clearClient.release();
   }
  });
 });

 await t.test('retirement preserves unknown liability and late original evidence cannot recreate private authority',async()=>{
  await withReasoningMaintenanceSchema('privacy_unknown',async pool=>{
   const graph=await seedRunningPrivateGraph(pool,{consumed:true});
   await withdraw(pool,graph);
   assert(graph.attemptId&&graph.requestId&&graph.dispatchId&&graph.permitId&&graph.reservationId&&graph.bucketId);
   const before=(await pool.query(`SELECT
    (SELECT row_to_json(a) FROM (SELECT state,output_authority,liability_state,remote_state,remote_disposition,reconciliation_hold,idempotency_hold FROM reasoning_accounting WHERE attempt_id=$1) a) accounting,
    (SELECT row_to_json(p) FROM (SELECT state,dispatch_id FROM reasoning_permit WHERE id=$2) p) permit,
    (SELECT row_to_json(r) FROM (SELECT state,amount::text FROM reasoning_reservation WHERE id=$3) r) reservation,
    (SELECT row_to_json(b) FROM (SELECT reserved::text,consumed::text FROM reasoning_bucket WHERE id=$4) b) bucket`,
    [graph.attemptId,graph.permitId,graph.reservationId,graph.bucketId])).rows[0];
   assert.deepEqual(before.accounting,{state:'unknown',output_authority:'withdrawn',liability_state:'held',remote_state:'held',remote_disposition:'unconfirmed',reconciliation_hold:true,idempotency_hold:true});
   await ageWithdrawalForTest(pool,graph.jobId,169);
   assert.equal((await createReasoningMaintenance(pool).runBatch({maxProbes:2})).retiredJobs,1);
   const retained=(await pool.query(`SELECT
    (SELECT row_to_json(a) FROM (SELECT state,output_authority,liability_state,remote_state,remote_disposition,reconciliation_hold,idempotency_hold FROM reasoning_accounting WHERE attempt_id=$1) a) accounting,
    (SELECT row_to_json(p) FROM (SELECT state,dispatch_id FROM reasoning_permit WHERE id=$2) p) permit,
    (SELECT row_to_json(r) FROM (SELECT state,amount::text FROM reasoning_reservation WHERE id=$3) r) reservation,
    (SELECT row_to_json(b) FROM (SELECT reserved::text,consumed::text FROM reasoning_bucket WHERE id=$4) b) bucket`,
    [graph.attemptId,graph.permitId,graph.reservationId,graph.bucketId])).rows[0];
   assert.deepEqual(retained,before);
   assert.equal(await count(pool,'reasoning_attempt','id',graph.attemptId),0);

   const receipt={version:1,receiptId:randomUUID(),attemptId:graph.attemptId,dispatchId:graph.dispatchId,requestId:graph.requestId,
    routeId:'privacy-route',routeProfileVersion:'privacy-profile',evidenceKind:'original_transport',observedAt:new Date().toISOString(),
    remoteDisposition:'terminal',outcome:'success',httpStatus:200,
    usage:{inputTokens:3,outputTokens:4,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:5}};
   const appended=await inMaintenanceTransaction(pool,client=>appendRestrictedReasoningReceipt(client,receipt,'worker'));
   assert.equal(appended.replayed,false);
   assert.deepEqual((await pool.query('SELECT state,output_authority,remote_disposition FROM reasoning_accounting WHERE attempt_id=$1',[graph.attemptId])).rows[0],
    {state:'responded',output_authority:'withdrawn',remote_disposition:'terminal'});
   for(const [table,column,value] of [
    ['reasoning_job','id',graph.jobId],['reasoning_context','job_id',graph.jobId],['reasoning_step','job_id',graph.jobId],
    ['reasoning_attempt','id',graph.attemptId],['reasoning_context_job_session','job_id',graph.jobId],
   ] as const) assert.equal(await count(pool,table,column,value),0,table);
   assert.equal((await createReasoningMaintenance(pool).runBatch({maxProbes:3})).purgedAccounting,0);
   assert.equal(await count(pool,'reasoning_accounting','attempt_id',graph.attemptId),1);
  });
 });

 await t.test('a late original receipt reopens closed duties before maintenance can purge them',async()=>{
  await withReasoningMaintenanceSchema('privacy_late_receipt_race',async pool=>{
   const graph=await seedRunningPrivateGraph(pool,{consumed:true});
   await withdraw(pool,graph);
   assert(graph.attemptId&&graph.requestId&&graph.dispatchId);
   await ageWithdrawalForTest(pool,graph.jobId,169);
   assert.equal((await createReasoningMaintenance(pool).runBatch({maxProbes:2})).retiredJobs,1);
   await pool.query(`UPDATE reasoning_accounting SET
    liability_state='settled',remote_state='released',remote_disposition='terminal',
    reconciliation_hold=false,idempotency_hold=false,closure_basis='evidence',
    all_duties_closed_at=clock_timestamp()-interval '31 days'
    WHERE attempt_id=$1`,[graph.attemptId]);
   const receipt={version:1,receiptId:randomUUID(),attemptId:graph.attemptId,dispatchId:graph.dispatchId,requestId:graph.requestId,
    routeId:'privacy-route',routeProfileVersion:'privacy-profile',evidenceKind:'original_transport',observedAt:new Date().toISOString(),
    remoteDisposition:'terminal',outcome:'success',httpStatus:200,
    usage:{inputTokens:2,outputTokens:3,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:4}};
   const receiptClient=await pool.connect();
   let transactionOpen=true;
   try {
    await receiptClient.query('BEGIN');
    const appended=await appendRestrictedReasoningReceipt(receiptClient,receipt,'worker');
    assert.equal(appended.replayed,false);
    assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:3}),
     {probes:3,expiredJobs:0,retiredJobs:0,purgedAccounting:0,skipped:3});
    await receiptClient.query('COMMIT');transactionOpen=false;
   } finally {
    if(transactionOpen) await receiptClient.query('ROLLBACK');
    receiptClient.release();
   }
   assert.deepEqual((await pool.query(`SELECT state,output_authority,liability_state,remote_state,
    reconciliation_hold,idempotency_hold,all_duties_closed_at FROM reasoning_accounting WHERE attempt_id=$1`,[graph.attemptId])).rows[0],
    {state:'responded',output_authority:'withdrawn',liability_state:'held',remote_state:'held',reconciliation_hold:true,idempotency_hold:true,all_duties_closed_at:null});
   assert.equal(await count(pool,'reasoning_receipt','attempt_id',graph.attemptId),1);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:3}),
    {probes:3,expiredJobs:0,retiredJobs:0,purgedAccounting:0,skipped:3});
   assert.equal(await count(pool,'reasoning_accounting','attempt_id',graph.attemptId),1);
   for(const [table,column,value] of [
    ['reasoning_job','id',graph.jobId],['reasoning_context','job_id',graph.jobId],
    ['reasoning_step','job_id',graph.jobId],['reasoning_attempt','id',graph.attemptId],
   ] as const) assert.equal(await count(pool,table,column,value),0,table);
  });
 });

 await t.test('the 30-day all-duties clock remains independent from private retirement',async()=>{
  await withReasoningMaintenanceSchema('privacy_recent_accounting',async pool=>{
   const universeId=randomUUID();await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
   const attemptId=await seedClosedAccounting(pool,universeId,29);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:3}),
    {probes:3,expiredJobs:0,retiredJobs:0,purgedAccounting:0,skipped:3});
   assert.equal(await count(pool,'reasoning_accounting','attempt_id',attemptId),1);
  });
  await withReasoningMaintenanceSchema('privacy_aged_accounting',async pool=>{
   const universeId=randomUUID();await pool.query('INSERT INTO universe(id,privacy_epoch) VALUES($1,0)',[universeId]);
   const attemptId=await seedClosedAccounting(pool,universeId,31);
   assert.deepEqual(await createReasoningMaintenance(pool).runBatch({maxProbes:3}),
    {probes:3,expiredJobs:0,retiredJobs:0,purgedAccounting:1,skipped:2});
   assert.equal(await count(pool,'reasoning_accounting','attempt_id',attemptId),0);
  });
 });
});
