import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {after,test} from 'node:test';
import {pool,provisionIdentity,transaction} from '../packages/db/src/index.ts';
import {clearScrollHistory} from '../packages/db/src/privacy.ts';
import {createReasoningReconciliation} from '../packages/db/src/reasoning-reconciliation.ts';
import {appendRestrictedReasoningReceipt,ReasoningReceiptConflict} from '../packages/db/src/reasoning-storage.ts';

if(!new URL(process.env.DATABASE_URL!).pathname.startsWith('/knowscroll_test_')) throw new Error('Reasoning reconciliation tests require an isolated knowscroll_test_* database');
after(async()=>{await pool.end();});

type Identity=Awaited<ReturnType<typeof provisionIdentity>>;
type Binding={basis:'input_tokens'|'output_tokens'|'total_tokens'|'cost_micro_usd'|'requests'|'remote_slots';handling:'budget'|'rate'|'remote';dimension:string;unit:string;amount:number};
type Seed={attemptId:string;requestId:string;dispatchId:string;reservations:Array<{id:string;bucketId:string;basis:string;handling:string;amount:number}>};
const reconciliation=createReasoningReconciliation(pool);

async function seed(identity:Identity,bindings:Binding[],expired=false):Promise<Seed> {
 const attemptId=randomUUID(),requestId=randomUUID(),dispatchId=randomUUID(),setId=randomUUID(),permitId=randomUUID();
 await pool.query(`INSERT INTO reasoning_accounting
  (attempt_id,universe_id,privacy_epoch,request_id,route_id,route_profile_version,max_output_tokens,deadline,state,dispatch_id,dispatch_committed_at,binding_hash,input_reservation_ceiling,runtime_policy_version)
  VALUES($1,$2,$3,$4,'route','profile',100,${expired?"clock_timestamp()-interval '1 second'":"clock_timestamp()+interval '1 hour'"},'dispatch_committed',$5,clock_timestamp(),$6,100,'policy')`,
  [attemptId,identity.scope.universeId,identity.scope.privacyEpoch,requestId,dispatchId,'c'.repeat(64)]);
 await pool.query(`INSERT INTO reasoning_permit(id,attempt_id,universe_id,privacy_epoch,reservation_set_id,expires_at,state,dispatch_id,consumed_at)
  VALUES($1,$2,$3,$4,$5,clock_timestamp()+interval '1 hour','consumed',$6,clock_timestamp())`,
  [permitId,attemptId,identity.scope.universeId,identity.scope.privacyEpoch,setId,dispatchId]);
 const reservations=[] as Seed['reservations'];
 for(const binding of bindings) {
  const bucketId=randomUUID(),id=randomUUID();
  await pool.query(`INSERT INTO reasoning_bucket(id,dimension,unit,window_id,capacity,reserved)
   VALUES($1,$2,$3,$4,10000,$5)`,[bucketId,binding.dimension,binding.unit,binding.handling==='rate'?'window':null,binding.amount]);
  await pool.query(`INSERT INTO reasoning_reservation(id,attempt_id,reservation_set_id,bucket_id,dimension,unit,amount,usage_basis,handling)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,attemptId,setId,bucketId,binding.dimension,binding.unit,binding.amount,binding.basis,binding.handling]);
  reservations.push({id,bucketId,basis:binding.basis,handling:binding.handling,amount:binding.amount});
 }
 return {attemptId,requestId,dispatchId,reservations};
}

function receipt(seed:Seed,overrides:Record<string,unknown>={}) {
 return {version:1,receiptId:randomUUID(),attemptId:seed.attemptId,dispatchId:seed.dispatchId,requestId:seed.requestId,
  routeId:'route',routeProfileVersion:'profile',evidenceKind:'original_transport',observedAt:new Date().toISOString(),
  remoteDisposition:'terminal',outcome:'success',httpStatus:200,
  usage:{inputTokens:5,outputTokens:4,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null},...overrides};
}

const input:Binding={basis:'input_tokens',handling:'budget',dimension:'global_budget',unit:'tokens',amount:10};
const output:Binding={basis:'output_tokens',handling:'budget',dimension:'owner_budget',unit:'tokens',amount:10};
const totalRate:Binding={basis:'total_tokens',handling:'rate',dimension:'combined_rate',unit:'tokens',amount:20};
const remote:Binding={basis:'remote_slots',handling:'remote',dimension:'remote_concurrency',unit:'slots',amount:1};

async function bucket(bucketId:string) {return (await pool.query('SELECT reserved,consumed,paused FROM reasoning_bucket WHERE id=$1',[bucketId])).rows[0];}
async function reservation(id:string) {return (await pool.query('SELECT state,recognized,usage_known FROM reasoning_reservation WHERE id=$1',[id])).rows[0];}

test('cumulative receipt revisions post only deltas and duplicates are no-ops',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input,output,totalRate,remote]),first=receipt(record);
 const one=await reconciliation.recordAndSettleReceipt(first,'worker');assert.equal(one.replayed,false);assert.equal(one.revision,1);
 const inputReservation=record.reservations[0]!,rateReservation=record.reservations[2]!;
 assert.deepEqual(await bucket(inputReservation.bucketId),{reserved:'0',consumed:'5',paused:false});
 assert.deepEqual(await bucket(rateReservation.bucketId),{reserved:'0',consumed:'20',paused:false});
 assert.equal((await reconciliation.recordAndSettleReceipt(first,'worker')).replayed,true);
 const second=receipt(record,{usage:{inputTokens:7,outputTokens:5,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}});
 const two=await reconciliation.recordAndSettleReceipt(second,'worker');assert.equal(two.revision,2);
 assert.deepEqual(await bucket(inputReservation.bucketId),{reserved:'0',consumed:'7',paused:false});
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_settlement WHERE attempt_id=$1',[record.attemptId])).rows[0].n,2);
 await assert.rejects(reconciliation.recordAndSettleReceipt({...first,usage:{...first.usage,inputTokens:6}},'worker'),ReasoningReceiptConflict);
});

test('terminal evidence releases remote capacity while nullable financial usage remains held',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input,output,remote]);
 await reconciliation.recordAndSettleReceipt(receipt(record,{usage:{inputTokens:5,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}}),'worker');
 assert.deepEqual((await pool.query('SELECT liability_state,remote_state,reconciliation_hold,idempotency_hold FROM reasoning_accounting WHERE attempt_id=$1',[record.attemptId])).rows[0],
  {liability_state:'partially_settled',remote_state:'released',reconciliation_hold:true,idempotency_hold:true});
 assert.deepEqual(await reservation(record.reservations[1]!.id),{state:'held',recognized:'0',usage_known:false});
 assert.deepEqual(await bucket(record.reservations[2]!.bucketId),{reserved:'0',consumed:'0',paused:false});
});

test('overage pauses budget and rate keeps its reserved floor without an early refund',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[{...input,amount:5},totalRate,remote]);
 await reconciliation.recordAndSettleReceipt(receipt(record,{usage:{inputTokens:9,outputTokens:0,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}}),'worker');
 assert.deepEqual(await bucket(record.reservations[0]!.bucketId),{reserved:'0',consumed:'9',paused:true});
 assert.deepEqual(await bucket(record.reservations[1]!.bucketId),{reserved:'0',consumed:'20',paused:false});
});

test('rate cumulative usage within a reserved floor does not double charge',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[{...totalRate,amount:100},remote]);
 await reconciliation.recordAndSettleReceipt(receipt(record,{usage:{inputTokens:10,outputTokens:0,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}}),'worker');
 await reconciliation.recordAndSettleReceipt(receipt(record,{usage:{inputTokens:20,outputTokens:0,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}}),'worker');
 assert.deepEqual(await bucket(record.reservations[0]!.bucketId),{reserved:'0',consumed:'100',paused:false});
 assert.deepEqual(await reservation(record.reservations[0]!.id),{state:'accounted',recognized:'20',usage_known:true});
});

test('PostgreSQL bigint counters compare numerically across receipt revisions and cache fields',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input,remote]);
 for(const value of [9,10,100]) {
  await reconciliation.recordAndSettleReceipt(receipt(record,{usage:{inputTokens:value,outputTokens:4,cacheReadTokens:value,cacheWriteTokens:null,costMicroUsd:null}}),'worker');
 }
 assert.deepEqual(await bucket(record.reservations[0]!.bucketId),{reserved:'0',consumed:'100',paused:true});
 assert.equal((await reconciliation.recordAndSettleReceipt(receipt(record,{usage:{inputTokens:99,outputTokens:4,cacheReadTokens:99,cacheWriteTokens:null,costMicroUsd:null}}),'worker')).reviewRequired,true);
});

test('split nullable cumulative fields merge before total-token settlement',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[totalRate,remote]);
 await reconciliation.recordAndSettleReceipt(receipt(record,{usage:{inputTokens:5,outputTokens:null,cacheReadTokens:2,cacheWriteTokens:null,costMicroUsd:null}}),'worker');
 await reconciliation.recordAndSettleReceipt(receipt(record,{usage:{inputTokens:null,outputTokens:3,cacheReadTokens:null,cacheWriteTokens:4,costMicroUsd:null}}),'worker');
 assert.deepEqual(await reservation(record.reservations[0]!.id),{state:'accounted',recognized:'8',usage_known:true});
 assert.deepEqual((await pool.query(`SELECT input_tokens,output_tokens,cache_read_tokens,cache_write_tokens
  FROM reasoning_settlement WHERE attempt_id=$1 ORDER BY revision DESC LIMIT 1`,[record.attemptId])).rows[0],
  {input_tokens:'5',output_tokens:'3',cache_read_tokens:'2',cache_write_tokens:'4'});
});

test('contradictory terminal and decreasing cumulative evidence freeze reconciliation',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input,remote]),first=receipt(record);
 await reconciliation.recordAndSettleReceipt(first,'worker');
 await reconciliation.recordAndSettleReceipt(receipt(record,{remoteDisposition:'unconfirmed'}),'worker');
 assert.equal((await pool.query('SELECT remote_state FROM reasoning_accounting WHERE attempt_id=$1',[record.attemptId])).rows[0].remote_state,'released');
 const before=await reservation(record.reservations[0]!.id);
 const contradiction=receipt(record,{outcome:'error'}),frozen=await reconciliation.recordAndSettleReceipt(contradiction,'worker');
 assert.equal(frozen.reviewRequired,true);assert.deepEqual(await reservation(record.reservations[0]!.id),before);
 assert.equal((await bucket(record.reservations[0]!.bucketId)).paused,true);
 assert.equal((await pool.query('SELECT remote_state FROM reasoning_accounting WHERE attempt_id=$1',[record.attemptId])).rows[0].remote_state,'released');
 assert.equal((await reconciliation.recordAndSettleReceipt(contradiction,'worker')).reviewRequired,true);
 assert.equal((await pool.query(`SELECT input_tokens FROM reasoning_settlement WHERE attempt_id=$1 ORDER BY revision DESC LIMIT 1`,[record.attemptId])).rows[0].input_tokens,'5');
 const other=await seed(await provisionIdentity(),[input,remote]);
 await reconciliation.recordAndSettleReceipt(receipt(other),'worker');
 assert.equal((await reconciliation.recordAndSettleReceipt(receipt(other,{usage:{inputTokens:4,outputTokens:4,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null}}),'worker')).reviewRequired,true);
});

test('missing remote reservation freezes legacy-incomplete reconciliation',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input]);
 assert.equal((await reconciliation.recordAndSettleReceipt(receipt(record),'worker')).reviewRequired,true);
 assert.equal((await bucket(record.reservations[0]!.bucketId)).paused,true);
});

test('old-epoch late receipt settles retained accounting without resurrecting private graph',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input,remote]);
 await transaction(client=>clearScrollHistory(client,owner.scope,{requestId:randomUUID(),expectedPrivacyEpoch:0,confirmation:'clear-scroll-history'}));
 await reconciliation.recordAndSettleReceipt(receipt(record),'worker');
 assert.equal((await pool.query('SELECT privacy_epoch FROM universe WHERE id=$1',[owner.scope.universeId])).rows[0].privacy_epoch,1);
 assert.deepEqual((await pool.query('SELECT privacy_epoch,output_authority FROM reasoning_accounting WHERE attempt_id=$1',[record.attemptId])).rows[0],{privacy_epoch:0,output_authority:'withdrawn'});
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_attempt WHERE universe_id=$1',[owner.scope.universeId])).rows[0].n,0);
});

test('unconfirmed remote duty blocks retention even when financial usage is settled',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input,remote]);
 await reconciliation.recordAndSettleReceipt(receipt(record,{remoteDisposition:'unconfirmed'}),'worker');
 assert.deepEqual((await pool.query('SELECT liability_state,remote_state,all_duties_closed_at FROM reasoning_accounting WHERE attempt_id=$1',[record.attemptId])).rows[0],
  {liability_state:'settled',remote_state:'held',all_duties_closed_at:null});
});

test('reconciliation transaction rolls receipt and accounting changes back on settlement failure',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input,remote]),incoming=receipt(record);
 await pool.query(`CREATE FUNCTION reject_reasoning_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced settlement rollback'; END $$`);
 await pool.query('CREATE TRIGGER reject_reasoning_settlement BEFORE INSERT ON reasoning_settlement FOR EACH ROW EXECUTE FUNCTION reject_reasoning_settlement()');
 try {await assert.rejects(reconciliation.recordAndSettleReceipt(incoming,'worker'),/forced settlement rollback/);} finally {
  await pool.query('DROP TRIGGER reject_reasoning_settlement ON reasoning_settlement');
  await pool.query('DROP FUNCTION reject_reasoning_settlement()');
 }
 assert.equal((await pool.query('SELECT count(*)::int n FROM reasoning_receipt WHERE id=$1',[incoming.receiptId])).rows[0].n,0);
 assert.deepEqual((await pool.query('SELECT state,reconciliation_hold FROM reasoning_accounting WHERE attempt_id=$1',[record.attemptId])).rows[0],{state:'dispatch_committed',reconciliation_hold:true});
});

test('an internally appended receipt replays into its own settlement and expired accounting withdraws output',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input,remote],true),incoming=receipt(record);
 await transaction(client=>appendRestrictedReasoningReceipt(client,incoming,'worker'));
 const settled=await reconciliation.recordAndSettleReceipt(incoming,'worker');
 assert.equal(settled.replayed,true);assert.equal(settled.revision,1);
 assert.equal((await pool.query('SELECT output_authority FROM reasoning_accounting WHERE attempt_id=$1',[record.attemptId])).rows[0].output_authority,'withdrawn');
 assert.equal((await pool.query('SELECT receipt_id FROM reasoning_settlement WHERE id=$1',[settled.settlementId])).rows[0].receipt_id,incoming.receiptId);
});

test('a fully known terminal receipt starts one retention clock and exact replay does not reset it',async()=>{
 const owner=await provisionIdentity(),record=await seed(owner,[input,remote]),incoming=receipt(record);
 await reconciliation.recordAndSettleReceipt(incoming,'worker');
 const first=(await pool.query('SELECT all_duties_closed_at FROM reasoning_accounting WHERE attempt_id=$1',[record.attemptId])).rows[0].all_duties_closed_at;
 assert.ok(first);assert.equal((await reconciliation.recordAndSettleReceipt(incoming,'worker')).replayed,true);
 assert.equal((await pool.query('SELECT all_duties_closed_at FROM reasoning_accounting WHERE attempt_id=$1',[record.attemptId])).rows[0].all_duties_closed_at.toISOString(),first.toISOString());
});
