import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,test} from 'node:test';
import {pool,provisionIdentity,transaction} from '../packages/db/src/index.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {
 appendRestrictedReasoningReceipt, purgeClosedReasoningAccounting,
 ReasoningReceiptConflict, UnknownReasoningReceipt,
} from '../packages/db/src/reasoning-storage.ts';

if(!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Reasoning privacy tests require an isolated knowscroll_test_* database');
after(async()=>{await pool.end();});

type Identity=Awaited<ReturnType<typeof provisionIdentity>>;
type Graph={attemptId:string;requestId:string;dispatchId:string;bucketId:string;jobId:string;permitId:string;reservationId:string};

async function clear(identity:Identity,epoch=identity.scope.privacyEpoch,requestId=randomUUID()) {
 return transaction(client=>clearScrollHistory(client,{...identity.scope,privacyEpoch:epoch},{
  requestId,expectedPrivacyEpoch:epoch,confirmation:'clear-scroll-history',
 }));
}

async function seedQueued(identity:Identity,epoch=identity.scope.privacyEpoch):Promise<string> {
 const jobId=randomUUID(),contextId=randomUUID(),stepId=randomUUID();
 await pool.query(`INSERT INTO reasoning_job
  (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
  VALUES($1,$2,$3,'queued','interactive',$2,'test',clock_timestamp()+interval '1 hour','direct',$4)`,
  [jobId,identity.scope.universeId,epoch,randomUUID()]);
 await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
  VALUES($1,$2,$3,$4,$5,'test','test')`,[contextId,jobId,identity.scope.universeId,epoch,'a'.repeat(64)]);
 await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
  VALUES($1,$2,$3,$4,$5,1,'pending')`,[stepId,jobId,identity.scope.universeId,epoch,contextId]);
 return jobId;
}

async function seedGraph(identity:Identity,options:{consumed?:boolean;permitState?:'reserved'|'revoked'|'expired';amount?:number}={}):Promise<Graph> {
 const epoch=identity.scope.privacyEpoch;
 const jobId=randomUUID(),contextId=randomUUID(),stepId=randomUUID(),attemptId=randomUUID();
 const requestId=randomUUID(),dispatchId=randomUUID(),permitId=randomUUID(),reservationSetId=randomUUID();
 const bucketId=randomUUID(),reservationId=randomUUID(),amount=options.amount??7;
 const consumed=options.consumed===true;
 const now=new Date().toISOString();
 await seedQueuedWithIds(identity,{jobId,contextId,stepId},epoch);
 await pool.query(`INSERT INTO reasoning_accounting
  (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,state,dispatch_id,dispatch_committed_at)
  VALUES($1,$2,$3,$4,'route','profile',100,clock_timestamp()+interval '1 hour',$5,$6,$7)`,
  [attemptId,identity.scope.universeId,epoch,requestId,consumed?'dispatch_committed':'reserved',consumed?dispatchId:null,consumed?now:null]);
 await pool.query(`INSERT INTO reasoning_bucket(id,dimension,unit,capacity,reserved)
  VALUES($1,'global_budget','tokens',1000,$2)`,[bucketId,amount]);
 const permitState=consumed?'consumed':(options.permitState??'reserved');
 await pool.query(`INSERT INTO reasoning_permit
  (id,attempt_id,universe_id,privacy_epoch,reservation_set_id,expires_at,state,dispatch_id,consumed_at,closed_at)
  VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour',$6,$7,$8,$9)`,
  [permitId,attemptId,identity.scope.universeId,epoch,reservationSetId,permitState,
   consumed?dispatchId:null,consumed?now:null,permitState==='consumed'?null:(permitState==='reserved'?null:now)]);
 await pool.query(`INSERT INTO reasoning_reservation(id,attempt_id,reservation_set_id,bucket_id,dimension,unit,amount)
  VALUES($1,$2,$3,$4,'global_budget','tokens',$5)`,[reservationId,attemptId,reservationSetId,bucketId,amount]);
 await pool.query(`INSERT INTO reasoning_attempt
  (id,job_id,step_id,context_id,universe_id,privacy_epoch,ordinal,lease_fence,request_hash,permit_id,reservation_set_id)
  VALUES($1,$2,$3,$4,$5,$6,1,1,$7,$8,$9)`,
  [attemptId,jobId,stepId,contextId,identity.scope.universeId,epoch,'b'.repeat(64),permitId,reservationSetId]);
 return {attemptId,requestId,dispatchId,bucketId,jobId,permitId,reservationId};
}

async function seedRetainedUnconsumed(identity:Identity,amount=6):Promise<Pick<Graph,'attemptId'|'bucketId'|'permitId'|'reservationId'>> {
 const attemptId=randomUUID(),bucketId=randomUUID(),permitId=randomUUID(),reservationId=randomUUID(),reservationSetId=randomUUID();
 await pool.query(`INSERT INTO reasoning_accounting
  (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline)
  VALUES($1,$2,$3,$4,'route','profile',100,clock_timestamp()+interval '1 hour')`,
  [attemptId,identity.scope.universeId,identity.scope.privacyEpoch,randomUUID()]);
 await pool.query(`INSERT INTO reasoning_bucket(id,dimension,unit,capacity,reserved)
  VALUES($1,'global_budget','tokens',1000,$2)`,[bucketId,amount]);
 await pool.query(`INSERT INTO reasoning_permit(id,attempt_id,universe_id,privacy_epoch,reservation_set_id,expires_at)
  VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour')`,[permitId,attemptId,identity.scope.universeId,identity.scope.privacyEpoch,reservationSetId]);
 await pool.query(`INSERT INTO reasoning_reservation(id,attempt_id,reservation_set_id,bucket_id,dimension,unit,amount)
  VALUES($1,$2,$3,$4,'global_budget','tokens',$5)`,[reservationId,attemptId,reservationSetId,bucketId,amount]);
 return {attemptId,bucketId,permitId,reservationId};
}

async function seedQueuedWithIds(identity:Identity,ids:{jobId:string;contextId:string;stepId:string},epoch:number) {
 await pool.query(`INSERT INTO reasoning_job
  (id,universe_id,privacy_epoch,status,class,budget_owner_id,policy_version,deadline,wake_kind,intent_id)
  VALUES($1,$2,$3,'queued','interactive',$2,'test',clock_timestamp()+interval '1 hour','direct',$4)`,
  [ids.jobId,identity.scope.universeId,epoch,randomUUID()]);
 await pool.query(`INSERT INTO reasoning_context(id,job_id,universe_id,privacy_epoch,content_hash,policy_version,source_policy_version)
  VALUES($1,$2,$3,$4,$5,'test','test')`,[ids.contextId,ids.jobId,identity.scope.universeId,epoch,'a'.repeat(64)]);
 await pool.query(`INSERT INTO reasoning_step(id,job_id,universe_id,privacy_epoch,context_id,ordinal,status)
  VALUES($1,$2,$3,$4,$5,1,'pending')`,[ids.stepId,ids.jobId,identity.scope.universeId,epoch,ids.contextId]);
}

function receipt(graph:Graph,overrides:Record<string,unknown>={}) {
 return {version:1,receiptId:randomUUID(),attemptId:graph.attemptId,dispatchId:graph.dispatchId,requestId:graph.requestId,
  routeId:'route',routeProfileVersion:'profile',evidenceKind:'original_transport',observedAt:new Date().toISOString(),
  remoteDisposition:'terminal',outcome:'success',httpStatus:200,
  usage:{inputTokens:3,outputTokens:4,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:5},...overrides};
}

test('history clear removes queued and private reasoning while retaining only accounting',async()=>{
 const owner=await provisionIdentity({expiresInHours:2}),neighbor=await provisionIdentity({expiresInHours:2});
 const queued=await seedQueued(owner),reserved=await seedGraph(owner,{amount:9}),consumed=await seedGraph(owner,{consumed:true,amount:7});
 const closed=await seedGraph(owner,{permitState:'revoked',amount:5});
 await pool.query(`UPDATE reasoning_accounting SET state='not_sent',output_authority='withdrawn',liability_state='settled',remote_state='released',
  remote_disposition='not_sent',reconciliation_hold=false,idempotency_hold=false,closure_basis='evidence',all_duties_closed_at=clock_timestamp()
  WHERE attempt_id=$1`,[closed.attemptId]);
 const neighborGraph=await seedGraph(neighbor,{amount:11});
 await clear(owner);
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_job WHERE universe_id=$1',[owner.scope.universeId])).rows[0].n,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt WHERE universe_id=$1',[owner.scope.universeId])).rows[0].n,0);
 assert.equal((await pool.query('SELECT reserved FROM reasoning_bucket WHERE id=$1',[reserved.bucketId])).rows[0].reserved,'0');
 assert.equal((await pool.query('SELECT reserved FROM reasoning_bucket WHERE id=$1',[consumed.bucketId])).rows[0].reserved,'7');
 assert.equal((await pool.query('SELECT reserved FROM reasoning_bucket WHERE id=$1',[closed.bucketId])).rows[0].reserved,'0');
 assert.deepEqual((await pool.query('SELECT state,output_authority,liability_state,remote_state,remote_disposition,reconciliation_hold,idempotency_hold FROM reasoning_accounting WHERE attempt_id=$1',[reserved.attemptId])).rows[0],
  {state:'not_sent',output_authority:'withdrawn',liability_state:'settled',remote_state:'released',remote_disposition:'not_sent',reconciliation_hold:false,idempotency_hold:false});
 assert.deepEqual((await pool.query('SELECT state,output_authority FROM reasoning_accounting WHERE attempt_id=$1',[consumed.attemptId])).rows[0],{state:'dispatch_committed',output_authority:'withdrawn'});
 assert.equal((await pool.query('SELECT state FROM reasoning_reservation WHERE id=$1',[closed.reservationId])).rows[0].state,'released');
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt WHERE id=$1',[neighborGraph.attemptId])).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_job WHERE id=$1',[queued])).rows[0].n,0);
});

test('a later clear preserves earlier retained accounting and does not refund twice',async()=>{
 const owner=await provisionIdentity({expiresInHours:2});
 const first=await seedGraph(owner,{amount:9});
 await clear(owner);
 const retainedBefore=(await pool.query('SELECT state,all_duties_closed_at FROM reasoning_accounting WHERE attempt_id=$1',[first.attemptId])).rows[0];
 await seedQueued(owner,1);
 await clear(owner,1);
 assert.equal((await pool.query('SELECT reserved FROM reasoning_bucket WHERE id=$1',[first.bucketId])).rows[0].reserved,'0');
 assert.deepEqual((await pool.query('SELECT state,all_duties_closed_at FROM reasoning_accounting WHERE attempt_id=$1',[first.attemptId])).rows[0],retainedBefore);
});

test('exact older-clear replay leaves later private reasoning and reservations untouched',async()=>{
 const owner=await provisionIdentity({expiresInHours:2}),first=await seedGraph(owner,{amount:9}),requestId=randomUUID();
 await clear(owner,0,requestId);
 const later=await seedGraph({...owner,scope:{...owner.scope,privacyEpoch:1}},{amount:13});
 const before=await pool.query(`SELECT
  (SELECT count(*)::int FROM reasoning_job WHERE universe_id=$1) jobs,
  (SELECT count(*)::int FROM reasoning_attempt WHERE universe_id=$1) attempts,
  (SELECT reserved FROM reasoning_bucket WHERE id=$2) reserved`,[owner.scope.universeId,later.bucketId]);
 await clear(owner,0,requestId);
 assert.deepEqual((await pool.query(`SELECT
  (SELECT count(*)::int FROM reasoning_job WHERE universe_id=$1) jobs,
  (SELECT count(*)::int FROM reasoning_attempt WHERE universe_id=$1) attempts,
  (SELECT reserved FROM reasoning_bucket WHERE id=$2) reserved`,[owner.scope.universeId,later.bucketId])).rows[0],before.rows[0]);
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_accounting WHERE attempt_id=$1',[first.attemptId])).rows[0].n,1);
});

test('clear withdraws and releases retained unconsumed accounting even without a private graph',async()=>{
 const owner=await provisionIdentity({expiresInHours:2}),retained=await seedRetainedUnconsumed(owner);
 await clear(owner);
 assert.deepEqual((await pool.query(`SELECT state,output_authority,liability_state,remote_state,remote_disposition,
  reconciliation_hold,idempotency_hold,all_duties_closed_at IS NOT NULL closed FROM reasoning_accounting WHERE attempt_id=$1`,[retained.attemptId])).rows[0],
  {state:'not_sent',output_authority:'withdrawn',liability_state:'settled',remote_state:'released',remote_disposition:'not_sent',reconciliation_hold:false,idempotency_hold:false,closed:true});
 assert.equal((await pool.query('SELECT state FROM reasoning_permit WHERE id=$1',[retained.permitId])).rows[0].state,'revoked');
 assert.equal((await pool.query('SELECT state FROM reasoning_reservation WHERE id=$1',[retained.reservationId])).rows[0].state,'released');
 assert.equal((await pool.query('SELECT reserved FROM reasoning_bucket WHERE id=$1',[retained.bucketId])).rows[0].reserved,'0');
});

test('history clear rolls reasoning mutations back with the rest of its transaction',async()=>{
 const owner=await provisionIdentity({expiresInHours:2}),graph=await seedGraph(owner,{amount:9});
 await pool.query(`CREATE FUNCTION reject_reasoning_clear() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced reasoning clear rollback'; END $$`);
 await pool.query('CREATE TRIGGER reject_reasoning_clear BEFORE DELETE ON reasoning_job FOR EACH ROW EXECUTE FUNCTION reject_reasoning_clear()');
 try {await assert.rejects(clear(owner),/forced reasoning clear rollback/);} finally {
  await pool.query('DROP TRIGGER reject_reasoning_clear ON reasoning_job');
  await pool.query('DROP FUNCTION reject_reasoning_clear()');
 }
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt WHERE id=$1',[graph.attemptId])).rows[0].n,1);
 assert.equal((await pool.query('SELECT reserved FROM reasoning_bucket WHERE id=$1',[graph.bucketId])).rows[0].reserved,'9');
 assert.equal((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0].privacy_epoch,0);
});

test('restricted receipts accept old-epoch original identity only, and enforce origin and exact replay',async()=>{
 const owner=await provisionIdentity({expiresInHours:2}),graph=await seedGraph(owner,{consumed:true});
 await clear(owner);
 const original=receipt(graph);
 const first=await transaction(client=>appendRestrictedReasoningReceipt(client,original,'worker'));
 assert.equal(first.replayed,false);
 assert.equal((await transaction(client=>appendRestrictedReasoningReceipt(client,original,'worker'))).replayed,true);
 assert.deepEqual((await pool.query('SELECT privacy_epoch,cache_read_tokens,cache_write_tokens FROM reasoning_receipt WHERE id=$1',[original.receiptId])).rows[0],
  {privacy_epoch:0,cache_read_tokens:null,cache_write_tokens:null});
 assert.equal((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0].privacy_epoch,1);
 assert.equal((await pool.query('SELECT output_authority FROM reasoning_accounting WHERE attempt_id=$1',[graph.attemptId])).rows[0].output_authority,'withdrawn');
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt WHERE universe_id=$1',[owner.scope.universeId])).rows[0].n,0);
 await assert.rejects(transaction(client=>appendRestrictedReasoningReceipt(client,{...original,usage:{...original.usage,inputTokens:9}},'worker')),ReasoningReceiptConflict);
 await assert.rejects(transaction(client=>appendRestrictedReasoningReceipt(client,{...original,receiptId:randomUUID(),routeId:'other'},'worker')),ReasoningReceiptConflict);
 await assert.rejects(transaction(client=>appendRestrictedReasoningReceipt(client,{...original,receiptId:randomUUID(),rawResponse:'secret'},'worker')),/Unrecognized key/);
 await assert.rejects(transaction(client=>appendRestrictedReasoningReceipt(client,{...original,receiptId:randomUUID(),evidenceKind:'provider_lookup'},'worker')),ReasoningReceiptConflict);
 await assert.rejects(transaction(client=>appendRestrictedReasoningReceipt(client,{...original,receiptId:randomUUID()},'operator' as never)),ReasoningReceiptConflict);
 await pool.query(`UPDATE reasoning_accounting SET liability_state='settled',remote_state='released',reconciliation_hold=false,idempotency_hold=false,
  closure_basis='operator_risk',risk_closure_id=$2,all_duties_closed_at=clock_timestamp() WHERE attempt_id=$1`,[graph.attemptId,randomUUID()]);
 assert.equal((await transaction(client=>appendRestrictedReasoningReceipt(client,original,'worker'))).replayed,true);
 await assert.rejects(transaction(client=>appendRestrictedReasoningReceipt(client,{...original,receiptId:randomUUID()},'worker')),ReasoningReceiptConflict);
});

test('purge removes only aged fully closed erased accounting and leaves unknown identities unknown',async()=>{
 const owner=await provisionIdentity({expiresInHours:2}),eligible=await seedGraph(owner,{consumed:true});
 await clear(owner);
 const saved=receipt(eligible);
 const savedResult=await transaction(client=>appendRestrictedReasoningReceipt(client,saved,'worker'));
 const settlementId=randomUUID();
 await pool.query(`INSERT INTO reasoning_settlement(id,attempt_id,receipt_id,receipt_fingerprint,revision,basis,liability,remote_concurrency)
  VALUES($1,$2,$3,$4,1,'measured','settled','released')`,[settlementId,eligible.attemptId,saved.receiptId,savedResult.fingerprint]);
 await pool.query(`INSERT INTO reasoning_settlement_adjustment(settlement_id,attempt_id,bucket_id,unit,delta)
  VALUES($1,$2,$3,'tokens',-1)`,[settlementId,eligible.attemptId,eligible.bucketId]);
 await pool.query(`UPDATE reasoning_accounting SET liability_state='settled',remote_state='released',reconciliation_hold=false,idempotency_hold=false,
  closure_basis='evidence',all_duties_closed_at=clock_timestamp()-interval '31 days' WHERE attempt_id=$1`,[eligible.attemptId]);
 const epoch1={...owner,scope:{...owner.scope,privacyEpoch:1}};
 const unresolved=await seedGraph(epoch1,{consumed:true});
 await clear(owner,1);
 await pool.query("UPDATE reasoning_accounting SET liability_state='settled' WHERE attempt_id=$1",[unresolved.attemptId]);
 const epoch2={...owner,scope:{...owner.scope,privacyEpoch:2}};
 const recent=await seedRetainedUnconsumed(epoch2);
 await clear(owner,2);
 const epoch3={...owner,scope:{...owner.scope,privacyEpoch:3}};
 const privateGraph=await seedGraph(epoch3,{amount:2});
 await pool.query(`UPDATE reasoning_accounting SET state='not_sent',output_authority='withdrawn',liability_state='settled',remote_state='released',
  remote_disposition='not_sent',reconciliation_hold=false,idempotency_hold=false,closure_basis='evidence',all_duties_closed_at=clock_timestamp()-interval '31 days'
  WHERE attempt_id=$1`,[privateGraph.attemptId]);
 assert.equal(await transaction(client=>purgeClosedReasoningAccounting(client,owner.scope.universeId)),1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_accounting WHERE attempt_id=$1',[eligible.attemptId])).rows[0].n,0);
 for(const table of ['reasoning_permit','reasoning_reservation','reasoning_receipt','reasoning_settlement','reasoning_settlement_adjustment']) {
  assert.equal((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE attempt_id=$1`,[eligible.attemptId])).rows[0].n,0,table);
 }
 assert.equal(await transaction(client=>purgeClosedReasoningAccounting(client,owner.scope.universeId)),0);
 assert.deepEqual((await pool.query('SELECT liability_state,remote_state,remote_disposition FROM reasoning_accounting WHERE attempt_id=$1',[unresolved.attemptId])).rows[0],
  {liability_state:'settled',remote_state:'held',remote_disposition:'unconfirmed'});
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_accounting WHERE attempt_id=$1',[recent.attemptId])).rows[0].n,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_accounting WHERE attempt_id=$1',[privateGraph.attemptId])).rows[0].n,1);
 await assert.rejects(pool.query('DELETE FROM reasoning_reservation WHERE id=$1',[privateGraph.reservationId]),/append-only/);
 await assert.rejects(transaction(client=>appendRestrictedReasoningReceipt(client,saved,'worker')),UnknownReasoningReceipt);
});
