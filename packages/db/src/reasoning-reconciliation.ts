import {lockFairnessResources,pauseFairnessForAttempt,settleFairness} from './reasoning-fairness-accounting.js';
import {randomUUID} from 'node:crypto';
import type pg from 'pg';
import {
 appendRestrictedReasoningReceipt,
 type TrustedReasoningReceiptOrigin,
} from './reasoning-storage.ts';

type Usage={inputTokens:number|null;outputTokens:number|null;cacheReadTokens:number|null;cacheWriteTokens:number|null;costMicroUsd:number|null};
type Reservation={id:string;attempt_id:string;bucket_id:string;amount:string;state:'held'|'accounted'|'released';usage_basis:string;handling:string;recognized:string;usage_known:boolean};
type Accounting={attempt_id:string;universe_id:string;state:string;binding_hash:string|null;runtime_policy_version:string|null;output_authority:string;review_required:boolean;deadline:Date|string};
type Counter=string|number|null;
type Receipt={id:string;attempt_id:string;remote_disposition:'terminal'|'unconfirmed';outcome:string;input_tokens:Counter;output_tokens:Counter;cache_read_tokens:Counter;cache_write_tokens:Counter;cost_micro_usd:Counter};
type ReconciliationResult={receiptId:string;attemptId:string;fingerprint:string;replayed:boolean;settlementId?:string;revision?:number;reviewRequired:boolean};
type PreviousSettlement={id:string;revision:number;usage:Usage};

const max=9007199254740991n;
const asBigInt=(value:string|number):bigint=>{
 const parsed=typeof value==='number'?BigInt(value):BigInt(value);
 if(parsed<0n||parsed>max) throw new Error('Reasoning counter exceeds safe storage range');
 return parsed;
};
const asNullableBigInt=(value:number|null):bigint|null=>value===null?null:asBigInt(value);
const usageValue=(basis:string,usage:Usage):bigint|null=>{
 const input=asNullableBigInt(usage.inputTokens),output=asNullableBigInt(usage.outputTokens);
 switch(basis) {
  case 'input_tokens': return input;
  case 'output_tokens': return output;
  case 'total_tokens': {
   if(input===null||output===null) return null;
   const total=input+output;
   if(total>max) throw new Error('Reasoning total usage exceeds safe storage range');
   return total;
  }
  case 'cost_micro_usd': return asNullableBigInt(usage.costMicroUsd);
  case 'requests': return 1n;
  case 'remote_slots': return 1n;
  default: return null;
 }
};
const asNullableNumber=(value:Counter):number|null=>value===null?null:Number(asBigInt(value));
const receiptUsage=(receipt:Receipt):Usage=>({inputTokens:asNullableNumber(receipt.input_tokens),outputTokens:asNullableNumber(receipt.output_tokens),
 cacheReadTokens:asNullableNumber(receipt.cache_read_tokens),cacheWriteTokens:asNullableNumber(receipt.cache_write_tokens),costMicroUsd:asNullableNumber(receipt.cost_micro_usd)});
const text=(value:bigint)=>value.toString();
const mergeUsage=(previous:Usage,incoming:Usage):{usage:Usage;decreases:boolean}=>{
 let decreases=false;
 const merge=(prior:number|null,next:number|null):number|null=>{
  if(next===null) return prior;
  if(prior!==null&&next<prior) {decreases=true;return prior;}
  return next;
 };
 return {usage:{inputTokens:merge(previous.inputTokens,incoming.inputTokens),outputTokens:merge(previous.outputTokens,incoming.outputTokens),
  cacheReadTokens:merge(previous.cacheReadTokens,incoming.cacheReadTokens),cacheWriteTokens:merge(previous.cacheWriteTokens,incoming.cacheWriteTokens),
  costMicroUsd:merge(previous.costMicroUsd,incoming.costMicroUsd)},decreases};
};

async function withTransaction<T>(db:pg.Pool,fn:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
 const client=await db.connect();
 try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}
 catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}

async function pauseBuckets(client:pg.PoolClient,bucketIds:string[]):Promise<void> {
 if(bucketIds.length===0) return;
 await client.query('UPDATE reasoning_bucket SET paused=true WHERE id=ANY($1::uuid[])',[bucketIds]);
}

async function freeze(
 client:pg.PoolClient,accounting:Accounting,reservations:Reservation[],
):Promise<'held'|'released'> {
 await pauseFairnessForAttempt(client,accounting.attempt_id);
 await pauseBuckets(client,reservations.map(reservation=>reservation.bucket_id));
 const remoteReservations=reservations.filter(reservation=>reservation.handling==='remote');
 const remoteReleased=remoteReservations.length>0&&remoteReservations.every(reservation=>reservation.state==='released');
 await client.query(`UPDATE reasoning_accounting SET review_required=true,reconciliation_hold=true,idempotency_hold=true,
  liability_state='held',remote_state=$2,remote_disposition=CASE WHEN $2='released' THEN 'terminal' ELSE remote_disposition END,
  all_duties_closed_at=NULL WHERE attempt_id=$1`,[accounting.attempt_id,remoteReleased?'released':'held']);
 return remoteReleased?'released':'held';
}

async function previousSettlement(client:pg.PoolClient,attemptId:string):Promise<PreviousSettlement|undefined> {
 const row=(await client.query(`SELECT id,revision,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micro_usd
  FROM reasoning_settlement WHERE attempt_id=$1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,[attemptId])).rows[0];
 return row?{id:row.id,revision:row.revision,usage:{inputTokens:asNullableNumber(row.input_tokens),outputTokens:asNullableNumber(row.output_tokens),
  cacheReadTokens:asNullableNumber(row.cache_read_tokens),cacheWriteTokens:asNullableNumber(row.cache_write_tokens),costMicroUsd:asNullableNumber(row.cost_micro_usd)}}:undefined;
}

async function appendSettlement(
 client:pg.PoolClient,receipt:Receipt,previous:PreviousSettlement|undefined,usage:Usage,adjustments:Array<{bucketId:string;delta:bigint}>,liability:'held'|'partially_settled'|'settled',remote:'held'|'released',
):Promise<{settlementId:string;revision:number}> {
 const settlementId=randomUUID(),revision=(previous?.revision??0)+1;
 const fingerprint=(await client.query('SELECT fingerprint FROM reasoning_receipt WHERE id=$1',[receipt.id])).rows[0].fingerprint;
 await client.query(`INSERT INTO reasoning_settlement
  (id,attempt_id,receipt_id,receipt_fingerprint,revision,supersedes_settlement_id,basis,liability,remote_concurrency,
   input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micro_usd)
  VALUES($1,$2,$3,$4,$5,$6,'measured',$7,$8,$9,$10,$11,$12,$13)`,
  [settlementId,receipt.attempt_id,receipt.id,fingerprint,revision,previous?.id??null,liability,remote,
   usage.inputTokens,usage.outputTokens,usage.cacheReadTokens,usage.cacheWriteTokens,usage.costMicroUsd]);
 for(const adjustment of adjustments) {
  await client.query(`INSERT INTO reasoning_settlement_adjustment(settlement_id,attempt_id,bucket_id,unit,delta)
   SELECT $1,r.attempt_id,r.bucket_id,b.unit,$4::bigint FROM reasoning_reservation r
   JOIN reasoning_bucket b ON b.id=r.bucket_id WHERE r.attempt_id=$2 AND r.bucket_id=$3`,
   [settlementId,receipt.attempt_id,adjustment.bucketId,text(adjustment.delta)]);
 }
 return {settlementId,revision};
}

async function settleReceipt(client:pg.PoolClient,receiptId:string):Promise<Omit<ReconciliationResult,'receiptId'|'attemptId'|'fingerprint'|'replayed'>> {
 const receipt=(await client.query(`SELECT id,attempt_id,remote_disposition,outcome,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micro_usd
  FROM reasoning_receipt WHERE id=$1 FOR UPDATE`,[receiptId])).rows[0] as Receipt|undefined;
 if(!receipt) throw new Error('Reasoning receipt disappeared before settlement');
 const accounting=(await client.query(`SELECT attempt_id,universe_id,state,binding_hash,runtime_policy_version,output_authority,review_required,deadline
  FROM reasoning_accounting WHERE attempt_id=$1 FOR UPDATE`,[receipt.attempt_id])).rows[0] as Accounting|undefined;
 if(!accounting) throw new Error('Reasoning accounting disappeared before settlement');
 await client.query(`UPDATE reasoning_accounting SET output_authority='withdrawn'
  WHERE attempt_id=$1 AND deadline<=clock_timestamp() AND output_authority='eligible'`,[receipt.attempt_id]);
 await lockFairnessResources(client,[receipt.attempt_id]);
 const reservations=(await client.query(`SELECT id,attempt_id,bucket_id,amount,state,usage_basis,handling,recognized,usage_known
  FROM reasoning_reservation WHERE attempt_id=$1 ORDER BY bucket_id FOR UPDATE`,[receipt.attempt_id])).rows as Reservation[];
 await client.query('SELECT id FROM reasoning_bucket WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',[reservations.map(row=>row.bucket_id)]);

 const previous=await previousSettlement(client,receipt.attempt_id);
 const merged=mergeUsage(previous?.usage??{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null},receiptUsage(receipt));
 const terminal=(await client.query(`SELECT outcome FROM reasoning_receipt
  WHERE attempt_id=$1 AND remote_disposition='terminal' ORDER BY recorded_at,id`,[receipt.attempt_id])).rows as Array<{outcome:string}>;
 const contradictory=terminal.length>1&&new Set(terminal.map(row=>row.outcome)).size>1;
 const remoteReservations=reservations.filter(reservation=>reservation.handling==='remote');
 const financialReservations=reservations.filter(reservation=>reservation.handling==='budget'||reservation.handling==='rate');
 const unknown=accounting.binding_hash===null||accounting.runtime_policy_version===null||remoteReservations.length===0||financialReservations.length===0||reservations.some(reservation=>reservation.usage_basis==='unknown'||reservation.handling==='unknown');
 const decreases=reservations.some(reservation=>{
  const next=usageValue(reservation.usage_basis,merged.usage);
  return next!==null&&reservation.usage_known&&next<asBigInt(reservation.recognized);
 });
 if(accounting.review_required||contradictory||unknown||merged.decreases||decreases) {
  const remoteState=await freeze(client,accounting,reservations);
  const settlement=await appendSettlement(client,receipt,previous,previous?.usage??{inputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,costMicroUsd:null},[],'held',remoteState);
  return {...settlement,reviewRequired:true};
 }

 const adjustments:Array<{bucketId:string;delta:bigint}>=[];
 for(const reservation of reservations) {
  const next=usageValue(reservation.usage_basis,merged.usage),prior=asBigInt(reservation.recognized),amount=asBigInt(reservation.amount);
  if(reservation.handling==='remote') {
   if(!reservation.usage_known) await client.query(`UPDATE reasoning_reservation SET usage_known=true,recognized=1 WHERE id=$1`,[reservation.id]);
   if(receipt.remote_disposition==='terminal'&&reservation.state==='held') {
    const released=await client.query(`UPDATE reasoning_bucket SET reserved=reserved-$2::bigint
     WHERE id=$1 AND reserved>=$2::bigint RETURNING id`,[reservation.bucket_id,text(amount)]);
    if(released.rowCount!==1) throw new Error('Reasoning remote reservation underflow');
    await client.query("UPDATE reasoning_reservation SET state='released' WHERE id=$1 AND state='held'",[reservation.id]);
    adjustments.push({bucketId:reservation.bucket_id,delta:0n});
   }
   continue;
  }
  if(next===null) continue;
  const first=!reservation.usage_known;
  const consumed=reservation.handling==='rate'?(next>amount?next:amount):next;
  const priorConsumed=reservation.handling==='rate'?(prior>amount?prior:amount):prior;
  const delta=first?consumed:consumed-priorConsumed;
  if(delta<0n) throw new Error('Decreasing usage reached settlement mutation');
  if(first) {
   const bucket=await client.query(`UPDATE reasoning_bucket SET reserved=reserved-$2::bigint,consumed=consumed+$3::bigint,
    paused=paused OR $4 WHERE id=$1 AND reserved>=$2::bigint RETURNING id`,
    [reservation.bucket_id,text(amount),text(delta),next>amount]);
   if(bucket.rowCount!==1) throw new Error('Reasoning reservation underflow');
   await client.query("UPDATE reasoning_reservation SET state='accounted',usage_known=true,recognized=$2::bigint WHERE id=$1 AND state='held'",[reservation.id,text(next)]);
   adjustments.push({bucketId:reservation.bucket_id,delta});
  } else if(next>prior) {
   if(delta>0n) {
    await client.query(`UPDATE reasoning_bucket SET consumed=consumed+$2::bigint,paused=paused OR $3 WHERE id=$1`,
     [reservation.bucket_id,text(delta),next>amount]);
    adjustments.push({bucketId:reservation.bucket_id,delta});
   }
   await client.query('UPDATE reasoning_reservation SET recognized=$2::bigint WHERE id=$1',[reservation.id,text(next)]);
  }
 }

 const current=(await client.query(`SELECT id,usage_basis,handling,usage_known,state,recognized,bucket_id FROM reasoning_reservation
  WHERE attempt_id=$1 ORDER BY bucket_id FOR UPDATE`,[receipt.attempt_id])).rows as Reservation[];
 const financial=current.filter(row=>row.handling==='budget'||row.handling==='rate');
 const allKnown=financial.every(row=>row.usage_known);
 const anyKnown=financial.some(row=>row.usage_known);
 const remote=current.filter(row=>row.handling==='remote');
 const terminalRemote=remote.length>0&&remote.every(row=>row.state==='released');
 const liability=allKnown?'settled':anyKnown?'partially_settled':'held';
 const remoteState=terminalRemote?'released':'held';
 const close=allKnown&&terminalRemote;
 await client.query(`UPDATE reasoning_accounting SET state='responded',liability_state=$2,remote_state=$3,
  remote_disposition=$4,reconciliation_hold=$5,idempotency_hold=$5,review_required=false,
  output_authority=CASE WHEN deadline<=clock_timestamp() THEN 'withdrawn' ELSE output_authority END,
  closure_basis=CASE WHEN $6 THEN 'evidence' ELSE NULL END,risk_closure_id=NULL,
  all_duties_closed_at=CASE WHEN $6 THEN clock_timestamp() ELSE NULL END
  WHERE attempt_id=$1`,[receipt.attempt_id,liability,remoteState,terminalRemote?'terminal':'unconfirmed',!close,close]);
 const settlement=await appendSettlement(client,receipt,previous,merged.usage,adjustments,liability,remoteState);
 await settleFairness(client,receipt.attempt_id,settlement.revision,merged.usage);
 return {...settlement,reviewRequired:false};
}

export function createReasoningReconciliation(db:pg.Pool) {
 return {
  async recordAndSettleReceipt(input:unknown,origin:TrustedReasoningReceiptOrigin):Promise<ReconciliationResult> {
   return withTransaction(db,async client=>{
    const appended=await appendRestrictedReasoningReceipt(client,input,origin);
    if(appended.replayed) {
     const accounting=(await client.query('SELECT review_required FROM reasoning_accounting WHERE attempt_id=$1 FOR UPDATE',[appended.attemptId])).rows[0];
     const forReceipt=(await client.query('SELECT id,revision FROM reasoning_settlement WHERE attempt_id=$1 AND receipt_id=$2 FOR UPDATE',[appended.attemptId,appended.receiptId])).rows[0];
     if(!forReceipt) return {...appended,...await settleReceipt(client,appended.receiptId),replayed:true};
     return {...appended,settlementId:forReceipt.id,revision:forReceipt.revision,reviewRequired:Boolean(accounting?.review_required)};
    }
    const settled=await settleReceipt(client,appended.receiptId);
    return {...appended,...settled};
   });
  },
 };
}
